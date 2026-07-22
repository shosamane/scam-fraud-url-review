#!/usr/bin/env python3
"""Export all annotation data from review.db for analysis.

The strike ``marks``, ``selections`` and keyword list are SHARED per institution;
each reviewer's ``notes`` are private. This dumps the shared working set plus
every reviewer's notes as organized text/TSV files, then zips one timestamped
archive per run (easy to store, copy, and diff). Standard library only — run it
on the server next to review.db.

Usage
-----
    python3 export_annotations.py                     # all institutions
    python3 export_annotations.py --institution chase
    python3 export_annotations.py --db /path/review.db --out-dir /path/exports

Archive layout  (annotations_export_<UTC>.zip)
----------------------------------------------
    00_MANIFEST.txt                     run metadata + overall counts
    <institution>/
        00_summary.txt                  counts, keywords
        keywords.txt                    the shared keyword list, one per line
        selections.txt                  shared selected paths, one per line
        strikes.tsv                     shared: url, scope, reason, note, updated_at
        notes_by_url.txt                per URL, EVERY reviewer's note together
                                        (sorted by URL, so a path/subtree groups)
        notes_<user>.tsv                url + note (newlines escaped) for loading

Notes
-----
Selections are the reviewers' *selected nodes* (a leaf = that URL; a branch =
that branch root, which the app expands to its non-struck subtree). Strikes are
the excluded paths. Everything is keyed by clean URL. If the DB predates the
shared model, marks/selections are reconstructed as the union of both reviewers'
old per-user sets (selection wins).
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.environ.get("REVIEW_DB", os.path.join(HERE, "review.db"))


def _esc(text: str) -> str:
    """Make a note safe for one TSV cell (no tabs/newlines)."""
    return text.replace("\\", "\\\\").replace("\t", " ").replace("\r", " ").replace("\n", "\\n")


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _governs(mark_url: str, sel_url: str) -> bool:
    base = mark_url.rstrip("/")
    return sel_url == mark_url or sel_url == base or sel_url.startswith(base + "/")


def _union_legacy(users: dict[str, dict]) -> dict:
    """Fallback for pre-shared databases: union both reviewers' marks/selections,
    selection wins (carve out any strike governing a selection)."""
    marks: dict = {}
    selections: set[str] = set()
    for u in users.values():
        for url, mark in u.get("marks", {}).items():
            existing = marks.get(url)
            if existing is None or str(mark.get("updatedAt", "")) >= str(existing.get("updatedAt", "")):
                marks[url] = mark
        selections.update(u.get("selections", []))
    for sel in selections:
        for murl in list(marks):
            if _governs(murl, sel):
                del marks[murl]
    return {"marks": marks, "selections": sorted(selections)}


def _load(db_path: str):
    conn = _connect(db_path)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    # Shared marks/selections per institution.
    shared: dict[str, dict] = {}
    if "shared" in tables:
        for row in conn.execute("SELECT institution, marks, selections FROM shared"):
            shared[row["institution"]] = {
                "marks": json.loads(row["marks"] or "{}"),
                "selections": json.loads(row["selections"] or "[]"),
            }

    # Per-user rows: notes (current), plus legacy marks/selections for fallback.
    cols = [r[1] for r in conn.execute("PRAGMA table_info(annotations)")]
    has_notes = "notes" in cols
    per_user: dict[str, dict[str, dict]] = {}
    for row in conn.execute("SELECT institution, user, marks, selections, "
                            + ("notes" if has_notes else "'{}' AS notes")
                            + " FROM annotations ORDER BY institution, user"):
        per_user.setdefault(row["institution"], {})[row["user"]] = {
            "marks": json.loads(row["marks"] or "{}"),
            "selections": json.loads(row["selections"] or "[]"),
            "notes": json.loads(row["notes"]) if row["notes"] else {},
        }

    keywords: dict[str, dict] = {}
    for row in conn.execute("SELECT institution, search FROM keywords"):
        keywords[row["institution"]] = json.loads(row["search"] or "{}")
    conn.close()
    return shared, per_user, keywords


def _keyword_list(search: dict) -> list[str]:
    terms = search.get("terms", "") if isinstance(search, dict) else ""
    out = []
    for line in terms.replace(",", "\n").splitlines():
        term = line.strip()
        if term:
            out.append(term)
    return out


def _write_institution(folder: str, institution: str, shared: dict,
                       users: dict[str, dict], search: dict) -> dict:
    os.makedirs(folder, exist_ok=True)
    user_names = sorted(users)
    keywords = _keyword_list(search)

    # Prefer the shared record; fall back to a union of legacy per-user data.
    if shared and (shared.get("marks") or shared.get("selections")):
        marks = shared.get("marks", {})
        selections = sorted(set(shared.get("selections", [])))
    else:
        legacy = _union_legacy(users)
        marks = legacy["marks"]
        selections = legacy["selections"]

    # keywords.txt (shared)
    with open(os.path.join(folder, "keywords.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(keywords) + ("\n" if keywords else ""))

    # selections.txt (shared)
    with open(os.path.join(folder, "selections.txt"), "w", encoding="utf-8") as f:
        for url in selections:
            f.write(url + "\n")

    # strikes.tsv (shared)
    with open(os.path.join(folder, "strikes.tsv"), "w", encoding="utf-8") as f:
        f.write("url\tscope\treason\tnote\tupdated_at\n")
        for url, mark in sorted(marks.items()):
            if not isinstance(mark, dict):
                continue
            f.write("\t".join([
                url, str(mark.get("scope", "")), str(mark.get("reason", "")),
                _esc(str(mark.get("note", ""))), str(mark.get("updatedAt", "")),
            ]) + "\n")

    # per-user notes
    for u in user_names:
        with open(os.path.join(folder, f"notes_{u}.tsv"), "w", encoding="utf-8") as f:
            f.write("url\tnote\n")
            for url, note in sorted(users[u]["notes"].items()):
                f.write(f"{url}\t{_esc(str(note))}\n")

    # notes_by_url.txt — every reviewer's note for a URL, together, sorted by URL
    note_urls = sorted(set().union(*[set(users[u]["notes"]) for u in user_names]) if user_names else set())
    with open(os.path.join(folder, "notes_by_url.txt"), "w", encoding="utf-8") as f:
        for url in note_urls:
            f.write("=" * 78 + "\n" + url + "\n")
            for u in user_names:
                note = users[u]["notes"].get(url)
                f.write(f"  [{u}]\n")
                if note and str(note).strip():
                    for line in str(note).splitlines() or [str(note)]:
                        f.write(f"      {line}\n")
                else:
                    f.write("      (no note)\n")
            f.write("\n")

    counts = {
        "users": user_names,
        "keywords": len(keywords),
        "selections": len(selections),
        "strikes": len(marks),
        "notes": {u: len(users[u]["notes"]) for u in user_names},
        "notes_urls": len(note_urls),
    }

    with open(os.path.join(folder, "00_summary.txt"), "w", encoding="utf-8") as f:
        f.write(f"Annotation summary — {institution}\n{'=' * 50}\n")
        f.write(f"Reviewers (notes): {', '.join(user_names) or '(none)'}\n")
        f.write(f"Shared keywords: {len(keywords)}\n")
        f.write(f"Shared selections: {len(selections)}\n")
        f.write(f"Shared strikes: {len(marks)}\n\n")
        for u in user_names:
            f.write(f"[{u}]  notes={counts['notes'][u]}\n")
        f.write(f"\nURLs with at least one note: {len(note_urls)}\n")
        f.write("\nKeywords:\n")
        for term in keywords:
            f.write(f"  {term}\n")
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=DEFAULT_DB, help=f"SQLite path (default {DEFAULT_DB})")
    parser.add_argument("--institution", default=None, help="Only this institution (default: all)")
    parser.add_argument("--out-dir", default=os.path.join(HERE, "exports"),
                        help="Where to write the zip (default: ./exports)")
    args = parser.parse_args()

    if not os.path.exists(args.db):
        raise SystemExit(f"database not found: {args.db}")

    shared, per_user, keywords = _load(args.db)
    institutions = ([args.institution] if args.institution
                    else sorted(set(shared) | set(per_user) | set(keywords)))
    if not institutions:
        raise SystemExit("no annotation data found in the database")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    os.makedirs(args.out_dir, exist_ok=True)
    zip_path = os.path.join(args.out_dir, f"annotations_export_{stamp}.zip")

    with tempfile.TemporaryDirectory() as tmp:
        overall = []
        for inst in institutions:
            counts = _write_institution(
                os.path.join(tmp, inst), inst,
                shared.get(inst, {}), per_user.get(inst, {}), keywords.get(inst, {})
            )
            overall.append((inst, counts))
        with open(os.path.join(tmp, "00_MANIFEST.txt"), "w", encoding="utf-8") as f:
            f.write("Annotation export\n" + "=" * 50 + "\n")
            f.write(f"Extracted (UTC): {datetime.now(timezone.utc).isoformat()}\n")
            f.write(f"Database: {os.path.abspath(args.db)}\n")
            f.write(f"Institutions: {', '.join(institutions)}\n\n")
            for inst, counts in overall:
                f.write(f"[{inst}] reviewers={','.join(counts['users']) or '-'}  "
                        f"keywords={counts['keywords']}  "
                        f"selections={counts['selections']}  strikes={counts['strikes']}  "
                        f"noted_urls={counts['notes_urls']}\n")

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(tmp):
                for name in files:
                    full = os.path.join(root, name)
                    zf.write(full, os.path.relpath(full, tmp))

    print(f"wrote {zip_path}")
    for inst, counts in overall:
        print(f"  {inst}: selections={counts['selections']} strikes={counts['strikes']} "
              f"notes={counts['notes']}")


if __name__ == "__main__":
    main()
