# data/

Large generated data files live here. They are **not** in version control
(see `.gitignore`) — transfer them to the server separately.

## Per institution

For each institution `<id>` you need:

1. `tree-<id>.js` — the URL tree data. It must assign the global, e.g.:
   ```js
   window.URL_TREE_DATA = { ...payload... };
   ```
   Generate it with `generate_url_tree_visualizers.py` (rename its output from
   `tree-data.js` to `data/tree-<id>.js`).

2. An entry in `institutions.json`:
   ```json
   [ { "id": "chase", "label": "Chase" },
     { "id": "wellsfargo", "label": "Wells Fargo" } ]
   ```

The institution dropdown in the app is populated from `institutions.json`
(falling back to whatever `tree-*.js` files are present). Adding a file + a
manifest entry is all it takes for a new institution to appear.
