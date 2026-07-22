# URL Tree Explorer — webapp

Landing page → annotation views over the discovered URL tree, with keyword
search, strike/select review, and a selection pane. Review state lives in SQLite
on the server so it persists across browsers/machines and is visible to anyone
who opens the app.

- **Shared per institution:** the strike `marks`, `selections`, and the keyword
  list. Both reviewers (Aziz, Sudhamshu) curate one shared working set. Shared
  changes are adopted **on load** (no live polling for marks/selections); the
  keyword box is also polled every 20 s so it updates live when idle.
- **Private per reviewer:** `notes` on URLs. Notes are the only thing that
  differs between the two reviewers, and a URL you note stays visible (struck) in
  your selection pane even after it is removed, so the note is never lost.
- **Concurrency:** shared writes are whole-record last-writer-wins. Since changes
  are seen on load, a genuinely simultaneous edit resolves to whichever save
  lands last; note saves go to a separate per-user row and never touch the shared
  list.
- **Institution dropdown** (top-right) picks the dataset; add more datasets by
  dropping a data file in (see `data/README.md`).

## Files

| File | In git? | Notes |
|------|:------:|-------|
| `index.html` | yes | Landing page (Project Timeline links to a Google Sheet; two annotation views) |
| `tree.html` | yes | The explorer |
| `app.js`, `styles.css` | yes | Front end |
| `server.py`, `store.py` | yes | FastAPI app + SQLite storage |
| `migrate_shared.py` | yes | One-time: fold old per-user strikes/selections into the shared record (see below) |
| `export_annotations.py` | yes | Dump all annotation data for analysis (see below) |
| `requirements.txt`, `README.md`, `.gitignore` | yes | |
| `data/institutions.json`, `data/README.md` | yes | Institution manifest + docs |
| `data/tree-<id>.js` | **no** | The ~12 MB URL tree data — transfer separately |
| `review.db`, `backups/` | **no** | Created at runtime on the server |

## Run

```bash
cd webapp
pip install -r requirements.txt

# Local dev (open http://localhost:9070/):
uvicorn server:app --host 127.0.0.1 --port 9070

# Behind the Rutgers proxy (kiran-research2.comminfo.rutgers.edu/webhook5
# routes to localhost:9070/webhook5), run under that prefix:
BASE_PATH=/webhook5 uvicorn server:app --host 127.0.0.1 --port 9070
```

Then open `http://kiran-research2.comminfo.rutgers.edu/webhook5/`.
The front end uses relative URLs, so it works under the `/webhook5` prefix
automatically — no hardcoded paths.

### Upgrading an existing deploy to the shared model (run once)

If the server already has a `review.db` from the old per-user model, migrate it
**right after restarting the new server and before reviewers reload**, so nobody
seeds the shared record from a single browser first:

```bash
python3 migrate_shared.py --dry-run   # preview the merge, writes nothing
python3 migrate_shared.py             # union both reviewers, selection wins
```

It only writes shared rows that are still empty (use `--force` to re-merge).
Notes are untouched. A fresh database needs no migration.

### API (all under `BASE_PATH`)

```
GET  /api/institutions
GET  /api/keywords?institution=chase        PUT /api/keywords?institution=chase        {search}
GET  /api/state?institution=chase&user=aziz  (composite: shared marks/selections + your notes + keywords)
PUT  /api/shared?institution=chase          {marks, selections}   shared
PUT  /api/notes?institution=chase&user=aziz {notes}               private
GET  /api/health
```

For a long-running deploy, put it under systemd (or `nohup`) so it restarts on
reboot; example unit:

```ini
[Service]
WorkingDirectory=/home/USER/webapp
Environment=BASE_PATH=/webhook5
Environment=REVIEW_DB=/home/USER/data/review.db
ExecStart=/usr/bin/uvicorn server:app --host 127.0.0.1 --port 9070
Restart=always
```

## What to copy where

- **git / scp (source only):** the whole `webapp/` folder — it is small because
  `.gitignore` excludes the data file, database, and backups.
- **Transfer to the server separately (not git):** the data file, into
  `webapp/data/` on the server:
  ```bash
  scp data/tree-chase.js  USER@HOST:/path/to/webapp/data/tree-chase.js
  ```
  `review.db` is **not** transferred — it is created on first run. (Only copy an
  existing `review.db` up if you want to preserve annotations already made.)

## Exporting annotations for analysis

Run on the server (next to `review.db`), standard library only:

```bash
python3 export_annotations.py                 # all institutions
python3 export_annotations.py --institution chase
```

It writes one timestamped zip to `exports/` per run:
`annotations_export_<UTC>.zip`, with a folder per institution containing the
shared keyword list, the shared `selections.txt` and `strikes.tsv`, each
reviewer's `notes_<user>.tsv`, and `notes_by_url.txt` (every reviewer's note for a
URL together, sorted by URL so a path/subtree groups). `exports/` is gitignored.

## Backups & durability

- SQLite runs in **WAL mode**: it is ACID and crash-safe. A killed process or
  power loss never loses a committed write or corrupts the database.
- `server.py` starts a background thread that snapshots the database into
  `backups/` every 15 minutes (online backup, consistent even during writes) and
  keeps the most recent 48. Override the location with `REVIEW_BACKUP_DIR`.
- For disaster recovery (disk loss / accidental delete), keep `review.db` on an
  **EBS volume with scheduled snapshots** — that is the real off-box backup.

## Notes / current limitations

- No login: `?user=aziz` / `?user=sudhamshu` just namespace the private notes;
  anyone with the link can open either. Fine for a trusted two-person setup; add
  auth if that changes.
- Shared `marks`/`selections` are **whole-record last-write-wins** and are seen
  **on load** (no live polling). If both reviewers edit the shared list at the
  same time, the later save wins wholesale — reload to pick up the other's
  changes. Notes are per-user and independent. If simultaneous editing becomes
  common, upgrade to per-item merge (server-side, keyed by each mark's
  `updatedAt`, with removal tombstones).
- Switching institutions **reloads** the page (fast after the first load thanks to
  browser caching of the data file). Say the word if you want a no-reload swap.
