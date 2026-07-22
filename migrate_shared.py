"""Seed / re-seed the SHARED per-institution document (strike marks + selections)
from the reviewers' data.

Sources it can read (all still intact after the shared-model upgrade):
  * each reviewer's OLD per-user row in the ``annotations`` table
    (the new app never overwrites those marks/selections columns), and
  * the CURRENT ``shared`` row (any work done since the upgrade).

Modes
-----
  default            UNION of both reviewers' per-user data AND the current shared
                     row, selection wins. Lossless recovery — restores anyone who
                     went missing without dropping anyone's later work.
  --only-user NAME   Seed from JUST that reviewer's per-user data (e.g. aziz).
                     Discards the current shared row — use when you explicitly
                     want only that person's set back.

Merge rule: UNION marks (newer updated_at wins on a key) and selections, then for
every selected URL delete any mark on its spine (selection wins) — mirroring the
app's carve-out.

Safety
------
Refuses to overwrite a non-empty shared row unless --force. Always prints a
diagnostic of what each source holds first, so you can confirm (e.g.) that Aziz's
strikes/selections are still there BEFORE writing anything. Notes are never
touched. Run on the server next to review.db:

    python3 migrate_shared.py --dry-run                 # inspect, write nothing
    python3 migrate_shared.py --force                   # lossless union, overwrite
    python3 migrate_shared.py --only-user aziz --force  # restore ONLY aziz's set
"""

from __future__ import annotations

import argparse
import json
import sys

from store import ReviewStore


def governs(mark_url: str, sel_url: str) -> bool:
    """True if a branch mark at ``mark_url`` would strike ``sel_url`` — same node
    or an ancestor of it (by clean-URL prefix)."""
    base = mark_url.rstrip("/")
    return sel_url == mark_url or sel_url == base or sel_url.startswith(base + "/")


def read_per_user(store: ReviewStore, institution: str) -> dict:
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT user, marks, selections FROM annotations WHERE institution = ?",
            (institution,),
        ).fetchall()
    return {
        row["user"]: {
            "marks": json.loads(row["marks"] or "{}"),
            "selections": json.loads(row["selections"] or "[]"),
        }
        for row in rows
    }


def merge(sources: list[dict]) -> dict:
    """Union marks (newer updated_at wins) + selections, then selection wins."""
    marks: dict = {}
    selections: set[str] = set()
    for src in sources:
        for url, mark in (src.get("marks") or {}).items():
            existing = marks.get(url)
            if existing is None or str(mark.get("updatedAt", "")) >= str(existing.get("updatedAt", "")):
                marks[url] = mark
        selections.update(src.get("selections") or [])
    carved = 0
    for sel in selections:
        for murl in list(marks):
            if governs(murl, sel):
                del marks[murl]
                carved += 1
    return {"marks": marks, "selections": sorted(selections), "carved": carved}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true",
                        help="overwrite shared rows that already have data")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the plan, write nothing")
    parser.add_argument("--only-user", default=None,
                        help="seed from JUST this reviewer's per-user data")
    parser.add_argument("--institution", default=None,
                        help="only this institution (default: all with data)")
    args = parser.parse_args()

    store = ReviewStore()
    with store._connect() as conn:
        found = {r["institution"] for r in conn.execute("SELECT DISTINCT institution FROM annotations")}
        found |= {r["institution"] for r in conn.execute("SELECT institution FROM shared")}
    institutions = [args.institution] if args.institution else sorted(found)

    if not institutions:
        print("No annotation/shared data found — nothing to do.")
        return 0

    for institution in institutions:
        per_user = read_per_user(store, institution)
        current = store.get_shared(institution)

        # --- diagnostic: what does each source hold right now? ---
        print(f"\n=== {institution} ===")
        for user in sorted(per_user):
            pu = per_user[user]
            print(f"  annotations[{user}]: {len(pu['marks'])} marks, {len(pu['selections'])} selections")
        print(f"  current shared:     {len(current['marks'])} marks, "
              f"{len(current['selections'])} selections (version {current['version']})")

        # --- choose sources ---
        if args.only_user:
            if args.only_user not in per_user:
                print(f"  [!] user '{args.only_user}' has no per-user row here — skipping.")
                continue
            sources = [per_user[args.only_user]]
            plan = f"ONLY {args.only_user}'s per-user data (current shared discarded)"
        else:
            sources = list(per_user.values()) + [current]
            plan = "UNION of every reviewer + current shared (lossless)"

        result = merge(sources)
        print(f"  plan: {plan}")
        print(f"  -> {len(result['marks'])} marks, {len(result['selections'])} selections "
              f"(carved {result['carved']} strike(s) under selections)")

        if args.dry_run:
            continue
        has_shared = bool(current["marks"]) or bool(current["selections"])
        if has_shared and not args.force:
            print("  [skip] shared row already has data. Re-run with --force to overwrite.")
            continue
        store.put_shared(institution, result["marks"], result["selections"])
        print(f"  wrote shared row for {institution}.")

    print("\nDone." if not args.dry_run else "\nDry run complete — nothing written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
