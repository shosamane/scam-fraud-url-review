"""FastAPI server for the URL tree explorer.

Serves the static app and a small JSON API backed by SQLite. The strike
``marks``, ``selections`` and keyword ``search`` list are SHARED across reviewers
per institution; each reviewer's ``notes`` are PRIVATE per (institution, user).
An institution dropdown lets you pick which dataset to review; add
``data/tree-<id>.js`` + an entry in ``data/institutions.json`` and it shows up
automatically.

Reverse proxy
-------------
Behind the Rutgers proxy the app is reached at
``http://kiran-research2.comminfo.rutgers.edu/webhook5`` and the traffic arrives
here as ``/webhook5/...``. Set ``BASE_PATH=/webhook5`` so the routes live under
that prefix, and run on port 9070:

    pip install -r requirements.txt
    BASE_PATH=/webhook5 uvicorn server:app --host 127.0.0.1 --port 9070

Locally (no proxy) just run without BASE_PATH and open http://localhost:9070/ .

API (all under BASE_PATH):
    GET  /api/institutions                          -> [{id, label}]
    GET  /api/keywords?institution=chase            -> {search, version}
    PUT  /api/keywords?institution=chase            body {search}
    GET  /api/state?institution=chase&user=aziz     -> {marks, selections, notes, search, ...}
    PUT  /api/shared?institution=chase              body {marks, selections}   (shared)
    PUT  /api/notes?institution=chase&user=aziz     body {notes}               (private)
    GET  /api/health
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from store import ReviewStore

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
BACKUP_DIR = os.environ.get("REVIEW_BACKUP_DIR", os.path.join(HERE, "backups"))
BASE_PATH = os.environ.get("BASE_PATH", "").rstrip("/")  # e.g. "/webhook5"

ALLOWED_USERS = {"aziz", "sudhamshu"}


def _is_blocked(path: str) -> bool:
    """Never serve the database, its backups, dotfiles (.git, .gitignore), or the
    server source over the static handler."""
    parts = [p for p in path.replace("\\", "/").strip("/").split("/")
             if p and p not in (".", "..")]
    if any(p.startswith(".") for p in parts):        # .git/, .gitignore, ...
        return True
    if parts and parts[0] == "backups":              # DB snapshots
        return True
    base = parts[-1] if parts else ""
    if base.endswith((".py", ".db", ".db-wal", ".db-shm")):
        return True
    if base == "requirements.txt":
        return True
    return False


store = ReviewStore()
store.start_backups(BACKUP_DIR)

app = FastAPI(title="URL Tree Review")
api = APIRouter()


class SharedBody(BaseModel):
    marks: Dict[str, Any] = {}
    selections: List[str] = []


class NotesBody(BaseModel):
    notes: Dict[str, str] = {}


class KeywordsBody(BaseModel):
    search: Dict[str, Any] = {}


def _institutions() -> List[dict]:
    """Available institutions, from data/institutions.json, else derived from the
    tree-<id>.js files present in data/."""
    manifest = os.path.join(DATA_DIR, "institutions.json")
    if os.path.exists(manifest):
        try:
            with open(manifest, encoding="utf-8") as handle:
                items = json.load(handle)
            return [i for i in items if isinstance(i, dict) and i.get("id")]
        except (json.JSONDecodeError, OSError):
            pass
    found = []
    for path in sorted(os.listdir(DATA_DIR)) if os.path.isdir(DATA_DIR) else []:
        if path.startswith("tree-") and path.endswith(".js"):
            ident = path[len("tree-"):-len(".js")]
            found.append({"id": ident, "label": ident.title()})
    return found


def _valid_user(user: str) -> str:
    if user not in ALLOWED_USERS:
        raise HTTPException(status_code=400, detail="unknown user")
    return user


@api.get("/health")
def health() -> dict:
    return {"ok": True}


@api.get("/institutions")
def institutions() -> List[dict]:
    return _institutions()


@api.get("/keywords")
def get_keywords(institution: str = "chase") -> dict:
    return store.get_keywords(institution)


@api.put("/keywords")
def put_keywords(body: KeywordsBody, institution: str = "chase") -> dict:
    return store.put_keywords(institution, body.search)


@api.get("/state")
def get_state(institution: str = "chase", user: str = "sudhamshu") -> dict:
    return store.get_state(institution, _valid_user(user))


@api.put("/shared")
def put_shared(body: SharedBody, institution: str = "chase") -> dict:
    # Shared across reviewers, whole-record last-writer-wins.
    return store.put_shared(institution, body.marks, body.selections)


@api.put("/notes")
def put_notes(body: NotesBody, institution: str = "chase", user: str = "sudhamshu") -> dict:
    # Private to each reviewer.
    return store.put_notes(institution, _valid_user(user), body.notes)


app.include_router(api, prefix=f"{BASE_PATH}/api")


class _SafeStatic(StaticFiles):
    """Static files, but never hand out the server source or the database."""

    async def get_response(self, path: str, scope):
        if _is_blocked(path):
            return PlainTextResponse("Not found", status_code=404)
        return await super().get_response(path, scope)


if BASE_PATH:
    @app.get(BASE_PATH)
    def _slash() -> RedirectResponse:
        return RedirectResponse(url=f"{BASE_PATH}/")

# Mounted last so the API routes above win.
app.mount(BASE_PATH or "/", _SafeStatic(directory=HERE, html=True), name="static")
