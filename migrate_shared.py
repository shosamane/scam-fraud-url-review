"""One-time migration: fold the two reviewers' PER-USER strikes & selections into
the new SHARED per-institution document.

Merge rule (chosen by the team): UNION both reviewers, SELECTION WINS.
  * selections := union of every reviewer's selections
  * marks      := union of every reviewer's marks (newer updated_at wins on a key)
  * then, for every selected URL, delete any mark on its spine (ancestor-or-self)
    so a selection is never struck — mirroring the app's carve-out behaviour.

Notes stay exactly where they are (per-user annotations.notes); they are not
touched.

Safety: refuses to overwrite a shared row that already has data unless --force,
so it can't clobber real shared work if run again after reviewers start using the
new model. Run it once, right after deploying the shared-model server:

    python3 migrate_shared.py            # migrate institutions whose shared row is empty
    python3 migrate_shared.py --force    # re-merge even if shared already has data
    python3 migrate_shared.py --dry-run  # show what would happen, write nothing
"""

from __future__ import annotations

import argparse
import json
import sys

from store import ReviewStore


def governs(mark_url: str, sel_url: str) -> bool:
    """True if a branch mark at ``mark_url`` would strike ``sel_url`` — i.e. it is
    the same node or an ancestor of it (by clean-URL prefix)."""
    base = mark_url.rstrip("/")
    return sel_url == mark_url or sel_url == base or sel_url.startswith(base + "/")


def merge_institution(store: ReviewStore, institution: str) -> dict:
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT user, marks, selections FROM annotations WHERE institution = ?",
            (institution,),
        ).fetchall()

    merged_marks: dict = {}
    selections: set[str] = set()
    for row in rows:
        marks = json.loads(row["marks"]) if row["marks"] else {}
        sels = json.loads(row["selections"]) if row["selections"] else []
        for url, mark in marks.items():
            existing = merged_marks.get(url)
            # Newer updated_at wins when both reviewers marked the same URL.
            if existing is None or str(mark.get("updatedAt", "")) >= str(existing.get("updatedAt", "")):
                merged_marks[url] = mark
        for url in sels:
            selections.add(url)

    # Selection wins: free the whole spine of every selected URL.
    carved = 0
    for sel_url in selections:
        for mark_url in list(merged_marks.keys()):
            if governs(mark_url, sel_url):
                del merged_marks[mark_url]
                carved += 1

    return {
        "marks": merged_marks,
        "selections": sorted(selections),
        "reviewers": [r["user"] for r in rows],
        "carved": carved,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="overwrite shared rows that already have data")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan, write nothing")
    args = parser.parse_args()

    store = ReviewStore()
    with store._connect() as conn:
        institutions = [r["institution"] for r in conn.execute(
            "SELECT DISTINCT institution FROM annotations ORDER BY institution"
        )]

    if not institutions:
        print("No per-user annotations found — nothing to migrate.")
        return 0

    for institution in institutions:
        existing = store.get_shared(institution)
        has_shared = bool(existing["marks"]) or bool(existing["selections"])
        if has_shared and not args.force:
            print(f"[skip] {institution}: shared row already has data "
                  f"({len(existing['marks'])} marks, {len(existing['selections'])} selections). "
                  f"Use --force to overwrite.")
            continue

        result = merge_institution(store, institution)
        print(f"[{institution}] reviewers={result['reviewers']} "
              f"-> {len(result['marks'])} marks, {len(result['selections'])} selections "
              f"(carved {result['carved']} strike(s) under selections)")

        if args.dry_run:
            continue
        store.put_shared(institution, result["marks"], result["selections"])
        print(f"         wrote shared row for {institution}.")

    print("Done." if not args.dry_run else "Dry run complete — nothing written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
