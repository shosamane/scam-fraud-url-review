"""SQLite-backed store for the URL tree explorer.

Data model
----------
- Per institution (SHARED across reviewers): the strike ``marks`` and the
  ``selections``. When either reviewer strikes or selects, both see the same
  shared document.
- GLOBAL (shared across every institution AND every reviewer): the keyword
  ``search`` list — one vocabulary. A term discovered while reviewing one
  institution then surfaces previously-struck matches in all the others.
- Per (institution, user) (PRIVATE): the reviewer's own ``notes`` on URLs. Notes
  are the only thing that differs between Aziz and Sudhamshu.

Concurrency
-----------
The shared document is written whole-record, last-writer-wins: each save
overwrites ``marks``/``selections`` for the institution. Reviewers see each
other's shared changes on load (there is no live polling for the shared list), so
a genuinely simultaneous edit resolves to whichever save lands last. Note saves
go to a separate per-user row and can never clobber the shared list.

Durability
----------
SQLite runs in WAL mode, so it is ACID and crash-safe: a killed process or power
loss never loses a committed write or corrupts the file. WAL also lets many
readers run while a write is in progress. Against *disk* failure or an accidental
delete, ``start_backups()`` spins up a daemon thread that periodically copies the
database (via SQLite's online-backup API, which is consistent even while writes
happen) into ``backups/`` and keeps the most recent N. On EC2, also keep
``review.db`` on an EBS volume with scheduled snapshots.

Standard library only, so it can be unit-tested without FastAPI installed.
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.environ.get("REVIEW_DB", os.path.join(HERE, "review.db"))

# Keywords live in the `keywords` table under this single reserved key, so the
# list is one GLOBAL vocabulary shared across every institution (the real
# institution ids can never collide with it).
_GLOBAL_KEYWORDS = "__global__"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _split_terms(terms: str) -> list:
    """Split a keyword string (comma- or newline-separated) into trimmed terms."""
    out = []
    for chunk in str(terms).replace("\n", ",").split(","):
        t = chunk.strip()
        if t:
            out.append(t)
    return out


class ReviewStore:
    def __init__(self, path: str = DEFAULT_DB):
        self.path = path
        self._init_lock = threading.Lock()
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _ensure_schema(self) -> None:
        with self._init_lock, self._connect() as conn:
            # Per-user row. Historically held marks/selections too; those columns
            # are kept for the one-time migration but are no longer read after the
            # shared table is populated. Going forward only ``notes`` is per-user.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS annotations (
                    institution TEXT NOT NULL,
                    user        TEXT NOT NULL,
                    marks       TEXT NOT NULL DEFAULT '{}',
                    selections  TEXT NOT NULL DEFAULT '[]',
                    notes       TEXT NOT NULL DEFAULT '{}',
                    version     INTEGER NOT NULL DEFAULT 0,
                    updated_at  TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (institution, user)
                )
                """
            )
            have = [r["name"] for r in conn.execute("PRAGMA table_info(annotations)")]
            if "notes" not in have:
                conn.execute(
                    "ALTER TABLE annotations ADD COLUMN notes TEXT NOT NULL DEFAULT '{}'"
                )
            # Shared strike marks + selections, one row per institution.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS shared (
                    institution TEXT PRIMARY KEY,
                    marks       TEXT NOT NULL DEFAULT '{}',
                    selections  TEXT NOT NULL DEFAULT '[]',
                    version     INTEGER NOT NULL DEFAULT 0,
                    updated_at  TEXT NOT NULL DEFAULT ''
                )
                """
            )
            # Global keyword list — one reserved row (see _GLOBAL_KEYWORDS).
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS keywords (
                    institution TEXT PRIMARY KEY,
                    search      TEXT NOT NULL DEFAULT '{}',
                    version     INTEGER NOT NULL DEFAULT 0,
                    updated_at  TEXT NOT NULL DEFAULT ''
                )
                """
            )
        self._migrate_global_keywords()

    def _migrate_global_keywords(self) -> None:
        """One-time: keywords used to be per-institution. Fold every existing
        per-institution list into the single global row (union of terms, most
        recent match mode/logic wins) so nobody's keywords are lost. Idempotent:
        does nothing once the global row exists."""
        with self._init_lock, self._connect() as conn:
            if conn.execute(
                "SELECT 1 FROM keywords WHERE institution = ?", (_GLOBAL_KEYWORDS,)
            ).fetchone():
                return
            rows = conn.execute(
                "SELECT search FROM keywords ORDER BY updated_at"
            ).fetchall()
            if not rows:
                return
            terms, seen, latest = [], set(), {}
            for row in rows:
                search = json.loads(row["search"]) or {}
                if not isinstance(search, dict):
                    continue
                for term in _split_terms(search.get("terms", "")):
                    key = term.lower()
                    if key not in seen:
                        seen.add(key)
                        terms.append(term)
                if search:
                    latest = search  # rows are oldest→newest, so this ends newest
            merged = {
                "terms": ", ".join(terms),
                "matchMode": latest.get("matchMode", "partial"),
                "termLogic": latest.get("termLogic", "any"),
            }
            conn.execute(
                "INSERT INTO keywords (institution, search, version, updated_at) "
                "VALUES (?, ?, 1, ?)",
                (_GLOBAL_KEYWORDS, json.dumps(merged, separators=(",", ":")), _now()),
            )

    # -- reads ---------------------------------------------------------------

    def get_keywords(self, institution: str = "") -> dict:
        # Keywords are one GLOBAL list shared across all institutions and users;
        # the institution argument is accepted for API symmetry but ignored.
        with self._connect() as conn:
            row = conn.execute(
                "SELECT search, version FROM keywords WHERE institution = ?",
                (_GLOBAL_KEYWORDS,),
            ).fetchone()
        if row is None:
            return {"search": {}, "version": 0}
        return {"search": json.loads(row["search"]), "version": row["version"]}

    def get_shared(self, institution: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT marks, selections, version, updated_at "
                "FROM shared WHERE institution = ?",
                (institution,),
            ).fetchone()
        if row is None:
            return {"marks": {}, "selections": [], "version": 0, "updatedAt": ""}
        return {
            "marks": json.loads(row["marks"]),
            "selections": json.loads(row["selections"]),
            "version": row["version"],
            "updatedAt": row["updated_at"],
        }

    def get_notes(self, institution: str, user: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT notes, version, updated_at "
                "FROM annotations WHERE institution = ? AND user = ?",
                (institution, user),
            ).fetchone()
        if row is None:
            return {"notes": {}, "version": 0, "updatedAt": ""}
        return {
            "notes": json.loads(row["notes"]),
            "version": row["version"],
            "updatedAt": row["updated_at"],
        }

    def get_state(self, institution: str, user: str) -> dict:
        """Composite document for the client's initial load: shared marks +
        selections, the user's private notes, and the shared keyword list."""
        shared = self.get_shared(institution)
        notes = self.get_notes(institution, user)
        kw = self.get_keywords(institution)
        return {
            "marks": shared["marks"],
            "selections": shared["selections"],
            "notes": notes["notes"],
            "search": kw["search"],
            "version": notes["version"],          # per-user (notes) version
            "sharedVersion": shared["version"],   # shared (marks/selections) version
            "updatedAt": shared["updatedAt"],
        }

    # -- writes --------------------------------------------------------------

    def put_shared(self, institution: str, marks: dict, selections: list) -> dict:
        if not isinstance(marks, dict):
            raise ValueError("marks must be an object")
        if not isinstance(selections, list):
            raise ValueError("selections must be an array")
        now = _now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO shared (institution, marks, selections, version, updated_at)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(institution) DO UPDATE SET
                    marks=excluded.marks,
                    selections=excluded.selections,
                    version=shared.version + 1,
                    updated_at=excluded.updated_at
                """,
                (
                    institution,
                    json.dumps(marks, separators=(",", ":")),
                    json.dumps(selections, separators=(",", ":")),
                    now,
                ),
            )
            version = conn.execute(
                "SELECT version FROM shared WHERE institution = ?", (institution,)
            ).fetchone()["version"]
        return {"version": version, "updatedAt": now}

    def put_notes(self, institution: str, user: str, notes: dict) -> dict:
        if not isinstance(notes, dict):
            raise ValueError("notes must be an object")
        now = _now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO annotations (institution, user, notes, version, updated_at)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(institution, user) DO UPDATE SET
                    notes=excluded.notes,
                    version=annotations.version + 1,
                    updated_at=excluded.updated_at
                """,
                (institution, user, json.dumps(notes, separators=(",", ":")), now),
            )
            version = conn.execute(
                "SELECT version FROM annotations WHERE institution = ? AND user = ?",
                (institution, user),
            ).fetchone()["version"]
        return {"version": version, "updatedAt": now}

    def put_keywords(self, institution: str, search: dict) -> dict:
        # Writes to the single GLOBAL keyword row regardless of institution.
        if not isinstance(search, dict):
            raise ValueError("search must be an object")
        now = _now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO keywords (institution, search, version, updated_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(institution) DO UPDATE SET
                    search=excluded.search,
                    version=keywords.version + 1,
                    updated_at=excluded.updated_at
                """,
                (_GLOBAL_KEYWORDS, json.dumps(search, separators=(",", ":")), now),
            )
            version = conn.execute(
                "SELECT version FROM keywords WHERE institution = ?", (_GLOBAL_KEYWORDS,)
            ).fetchone()["version"]
        return {"version": version, "updatedAt": now}

    # -- backups -------------------------------------------------------------

    def backup_now(self, backup_dir: str) -> str:
        os.makedirs(backup_dir, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        dest_path = os.path.join(backup_dir, f"review-{stamp}.db")
        src = self._connect()
        dst = sqlite3.connect(dest_path)
        try:
            src.backup(dst)  # online, consistent snapshot even under concurrent writes
        finally:
            dst.close()
            src.close()
        return dest_path

    def start_backups(self, backup_dir: str, interval_seconds: int = 900,
                      keep: int = 48) -> None:
        def loop() -> None:
            while True:
                try:
                    self.backup_now(backup_dir)
                    backups = sorted(glob.glob(os.path.join(backup_dir, "review-*.db")))
                    for old in backups[:-keep]:
                        try:
                            os.remove(old)
                        except OSError:
                            pass
                except Exception:
                    pass  # never let a backup failure take down the server
                time.sleep(interval_seconds)

        thread = threading.Thread(target=loop, name="review-backups", daemon=True)
        thread.start()
