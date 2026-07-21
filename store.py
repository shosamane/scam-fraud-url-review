"""SQLite-backed store for the URL tree explorer.

Data model
----------
- Per (institution, user): the manual strike ``marks`` and ``selections``.
  Aziz and Sudhamshu each have their own private annotations.
- Per institution: the shared keyword ``search`` list. When one user edits the
  keywords, everyone on that institution sees them.

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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
            # Migration: add the notes column to databases created before notes
            # existed (preserves existing rows).
            have = [r["name"] for r in conn.execute("PRAGMA table_info(annotations)")]
            if "notes" not in have:
                conn.execute(
                    "ALTER TABLE annotations ADD COLUMN notes TEXT NOT NULL DEFAULT '{}'"
                )
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

    # -- reads ---------------------------------------------------------------

    def get_keywords(self, institution: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT search, version FROM keywords WHERE institution = ?",
                (institution,),
            ).fetchone()
        if row is None:
            return {"search": {}, "version": 0}
        return {"search": json.loads(row["search"]), "version": row["version"]}

    def get_state(self, institution: str, user: str) -> dict:
        with self._connect() as conn:
            ann = conn.execute(
                "SELECT marks, selections, notes, version, updated_at "
                "FROM annotations WHERE institution = ? AND user = ?",
                (institution, user),
            ).fetchone()
            kw = conn.execute(
                "SELECT search FROM keywords WHERE institution = ?", (institution,)
            ).fetchone()
        return {
            "marks": json.loads(ann["marks"]) if ann else {},
            "selections": json.loads(ann["selections"]) if ann else [],
            "notes": json.loads(ann["notes"]) if ann else {},
            "search": json.loads(kw["search"]) if kw else {},
            "version": ann["version"] if ann else 0,
            "updatedAt": ann["updated_at"] if ann else "",
        }

    # -- writes --------------------------------------------------------------

    def put_state(self, institution: str, user: str, marks: dict,
                  selections: list, search: dict, notes: dict | None = None) -> dict:
        if not isinstance(marks, dict):
            raise ValueError("marks must be an object")
        if not isinstance(selections, list):
            raise ValueError("selections must be an array")
        if not isinstance(search, dict):
            raise ValueError("search must be an object")
        if notes is None:
            notes = {}
        if not isinstance(notes, dict):
            raise ValueError("notes must be an object")
        now = _now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO annotations (institution, user, marks, selections, notes, version, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(institution, user) DO UPDATE SET
                    marks=excluded.marks,
                    selections=excluded.selections,
                    notes=excluded.notes,
                    version=annotations.version + 1,
                    updated_at=excluded.updated_at
                """,
                (
                    institution, user,
                    json.dumps(marks, separators=(",", ":")),
                    json.dumps(selections, separators=(",", ":")),
                    json.dumps(notes, separators=(",", ":")),
                    now,
                ),
            )
            # Shared keyword list for the institution.
            conn.execute(
                """
                INSERT INTO keywords (institution, search, version, updated_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(institution) DO UPDATE SET
                    search=excluded.search,
                    version=keywords.version + 1,
                    updated_at=excluded.updated_at
                """,
                (institution, json.dumps(search, separators=(",", ":")), now),
            )
            version = conn.execute(
                "SELECT version FROM annotations WHERE institution = ? AND user = ?",
                (institution, user),
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
