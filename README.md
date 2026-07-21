# URL Tree Explorer — webapp

Landing page → per-reviewer annotation views over the discovered URL tree, with
keyword search, strike/select review, and a selection pane. Review state lives in
SQLite on the server so it persists across browsers/machines and is visible to
anyone who opens the app.

- **Two reviewers**, Aziz and Sudhamshu, each with **private** strikes and
  selections.
- **Shared keyword list** per institution — one reviewer's edits show up for the
  other (adopted on load, and polled every 20 s so it updates live when idle).
- **Institution dropdown** (top-right) picks the dataset; add more datasets by
  dropping a data file in (see `data/README.md`).

## Files

| File | In git? | Notes |
|------|:------:|-------|
| `index.html` | yes | Landing page (Project Timeline links to a Google Sheet; two annotation views) |
| `tree.html` | yes | The explorer |
| `app.js`, `styles.css` | yes | Front end |
| `server.py`, `store.py` | yes | FastAPI app + SQLite storage |
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
shared keyword list, per-reviewer selections/strikes/notes, a `selections_by_url.tsv`
agreement matrix, and `notes_by_url.txt` (every reviewer's note for a URL together,
sorted by URL so a path/subtree groups). `exports/` is gitignored.

## Backups & durability

- SQLite runs in **WAL mode**: it is ACID and crash-safe. A killed process or
  power loss never loses a committed write or corrupts the database.
- `server.py` starts a background thread that snapshots the database into
  `backups/` every 15 minutes (online backup, consistent even during writes) and
  keeps the most recent 48. Override the location with `REVIEW_BACKUP_DIR`.
- For disaster recovery (disk loss / accidental delete), keep `review.db` on an
  **EBS volume with scheduled snapshots** — that is the real off-box backup.

## Notes / current limitations

- No login: `?user=aziz` / `?user=sudhamshu` just namespace the storage; anyone
  with the link can open either. Fine for a trusted two-person setup; add auth if
  that changes.
- Annotation writes are **last-write-wins per (institution, user)** — correct
  because each reviewer only writes their own. Keywords are shared and also
  last-write-wins; the 20 s poll keeps the idle reviewer's box current.
- Switching institutions **reloads** the page (fast after the first load thanks to
  browser caching of the data file). Say the word if you want a no-reload swap.
