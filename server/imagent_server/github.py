"""Read-only access to a project's source on GitHub, for diagnosing issues.

A project connects ``owner/repo`` (plus a branch and a sub-folder when the app lives in a
monorepo) and a token that can read it. Diagnosis lists the repo's files, reads the few
behind a failure, and searches for the agent/tool names in it. Nothing is ever written.

"Connect GitHub" uses a GitHub App with device flow (``IMAGENT_GITHUB_CLIENT_ID``): the UI
shows a short code, the user approves it on github.com, and the project gets a token that
can read only the repos the app is installed on (Contents: read). No callback URL, so it
works the same on localhost and behind Cloudflare Access. A pasted token still works.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import posixpath
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API = "https://api.github.com"
CLIENT_ID = os.getenv("IMAGENT_GITHUB_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("IMAGENT_GITHUB_CLIENT_SECRET", "")  # only needed to refresh expiring tokens
APP_SLUG = os.getenv("IMAGENT_GITHUB_APP_SLUG", "")
CODE_EXT = (".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rb", ".java", ".kt", ".rs", ".cs", ".php",
            ".md", ".txt", ".yaml", ".yml", ".toml", ".json", ".jinja", ".j2", ".prompt")
SKIP_DIRS = ("node_modules/", ".venv/", "venv/", "dist/", "build/", "__pycache__/", ".git/", "vendor/",
             "site-packages/", ".next/", "coverage/")
MAX_FILE_BYTES = 400_000
CACHE_SECONDS = 600
_cache: dict[tuple, tuple[float, Any]] = {}


def config_for(project: dict[str, Any] | None) -> dict[str, str] | None:
    p = project or {}
    if not p.get("github_repo"):
        return None
    return {"repo": p["github_repo"], "token": p.get("github_token") or "", "branch": p.get("github_branch") or "",
            "path": (p.get("github_path") or "").strip("/")}


def _get(cfg: dict[str, str], url: str, *, raw: bool = False, timeout: float = 30) -> Any:
    headers = {"Accept": "application/vnd.github.raw" if raw else "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "imagent"}
    if cfg.get("token"):
        headers["Authorization"] = f"Bearer {cfg['token']}"
    req = urllib.request.Request(url if url.startswith("http") else API + url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — fixed GitHub host
        body = r.read()
    return body.decode(errors="replace") if raw else json.loads(body)


def _cached(key: tuple, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def branch(cfg: dict[str, str]) -> str:
    if cfg.get("branch"):
        return cfg["branch"]
    return _cached(("branch", cfg["repo"]), lambda: _get(cfg, f"/repos/{cfg['repo']}")["default_branch"])


def head_commit(cfg: dict[str, str]) -> str:
    ref = urllib.parse.quote(branch(cfg), safe="")
    return _cached(("head", cfg["repo"], ref), lambda: _get(cfg, f"/repos/{cfg['repo']}/commits/{ref}")["sha"])


def tree(cfg: dict[str, str]) -> list[str]:
    """Source file paths in the repo (under the project's folder), repo-relative."""
    def load() -> list[str]:
        sha = head_commit(cfg)
        data = _get(cfg, f"/repos/{cfg['repo']}/git/trees/{sha}?recursive=1", timeout=60)
        prefix = f"{cfg['path']}/" if cfg.get("path") else ""
        return [t["path"] for t in data.get("tree", [])
                if t.get("type") == "blob" and t["path"].startswith(prefix) and t.get("size", 0) <= MAX_FILE_BYTES
                and t["path"].endswith(CODE_EXT) and not any(f"/{d}" in f"/{t['path']}" for d in SKIP_DIRS)]
    return _cached(("tree", cfg["repo"], cfg.get("branch"), cfg.get("path")), load)


def read(cfg: dict[str, str], path: str) -> str:
    def load() -> str:
        ref = urllib.parse.quote(head_commit(cfg), safe="")
        return _get(cfg, f"/repos/{cfg['repo']}/contents/{urllib.parse.quote(path)}?ref={ref}", raw=True)
    return _cached(("file", cfg["repo"], cfg.get("branch"), path), load)


def search(cfg: dict[str, str], term: str, limit: int = 8) -> list[str]:
    """Files mentioning ``term`` (GitHub code search: default branch only; best effort)."""
    if not term or not cfg.get("token"):
        return []
    q = urllib.parse.quote(f'"{term}" repo:{cfg["repo"]}' + (f" path:{cfg['path']}" if cfg.get("path") else ""))
    try:
        data = _cached(("search", cfg["repo"], cfg.get("path"), term), lambda: _get(cfg, f"/search/code?q={q}&per_page={limit}"))
    except (urllib.error.URLError, ValueError, KeyError):
        return []
    return [i["path"] for i in data.get("items", [])][:limit]


def check(cfg: dict[str, str]) -> dict[str, Any]:
    """Can we read this repo? Reports the branch, commit and how many source files."""
    try:
        files = tree(cfg)
        return {"ok": True, "branch": branch(cfg), "commit": head_commit(cfg)[:10], "files": len(files)}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        hint = " — check the repo name and that the token can read it" if exc.code in (401, 403, 404) else ""
        return {"ok": False, "error": f"HTTP {exc.code}{hint}: {detail}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:300]}


# ── Connect GitHub (device flow) ────────────────────────────────────────────

def app_status() -> dict[str, Any]:
    return {"enabled": bool(CLIENT_ID), "app_slug": APP_SLUG,
            "install_url": f"https://github.com/apps/{APP_SLUG}/installations/new" if APP_SLUG else ""}


def _post_form(url: str, fields: dict[str, str]) -> dict[str, Any]:
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Accept": "application/json", "User-Agent": "imagent"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 — fixed GitHub host
        return json.loads(r.read())


def device_start() -> dict[str, Any]:
    """Begin "Connect GitHub": a code for the user to enter at github.com/login/device."""
    return _post_form("https://github.com/login/device/code", {"client_id": CLIENT_ID})


def _token_fields(d: dict[str, Any]) -> dict[str, str]:
    expires = ""
    if d.get("expires_in"):
        expires = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=int(d["expires_in"]) - 300)).isoformat()
    return {"token": d["access_token"], "refresh": d.get("refresh_token", ""), "expires": expires}


def device_poll(device_code: str) -> dict[str, Any]:
    """One poll: {"status": "pending" | "slow_down" | "expired" | "denied" | "connected", …token fields}."""
    d = _post_form("https://github.com/login/oauth/access_token", {
        "client_id": CLIENT_ID, "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
    if d.get("access_token"):
        login = _get({"token": d["access_token"]}, "/user").get("login", "")
        return {"status": "connected", "login": login, **_token_fields(d)}
    err = d.get("error", "")
    return {"status": {"authorization_pending": "pending", "slow_down": "slow_down", "expired_token": "expired",
                       "access_denied": "denied"}.get(err, "error"), "error": d.get("error_description", err),
            "interval": d.get("interval")}


def needs_refresh(project: dict[str, Any]) -> bool:
    exp = project.get("github_expires") or ""
    return bool(exp and project.get("github_refresh") and dt.datetime.fromisoformat(exp) <= dt.datetime.now(dt.timezone.utc))


def refresh(refresh_token: str) -> dict[str, str]:
    """New token for an expiring one (GitHub requires the app's client secret for this)."""
    if not CLIENT_SECRET:
        raise RuntimeError("the GitHub token expired — reconnect GitHub in Settings "
                           "(or turn off token expiry in the GitHub App, or set IMAGENT_GITHUB_CLIENT_SECRET)")
    d = _post_form("https://github.com/login/oauth/access_token", {
        "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "grant_type": "refresh_token",
        "refresh_token": refresh_token})
    if not d.get("access_token"):
        raise RuntimeError(f"couldn't refresh the GitHub token: {d.get('error_description') or d.get('error')} — reconnect GitHub")
    return _token_fields(d)


def repos(token: str) -> list[dict[str, Any]]:
    """Repos this connection can read: those the GitHub App is installed on (or, for a pasted
    token, the user's own)."""
    cfg = {"token": token}
    out: list[dict[str, Any]] = []
    try:
        installs = _get(cfg, "/user/installations?per_page=100").get("installations", [])
    except urllib.error.HTTPError:
        installs = None  # a classic/fine-grained PAT can't list installations
    if installs is not None:
        for inst in installs:
            page = 1
            while page <= 10:
                d = _get(cfg, f"/user/installations/{inst['id']}/repositories?per_page=100&page={page}")
                out += d.get("repositories", [])
                if len(d.get("repositories", [])) < 100:
                    break
                page += 1
    else:
        out = _get(cfg, "/user/repos?per_page=100&sort=pushed")
    seen, repos_ = set(), []
    for r in out:
        if r["full_name"] not in seen:
            seen.add(r["full_name"])
            repos_.append({"full_name": r["full_name"], "default_branch": r.get("default_branch", "main"),
                           "private": bool(r.get("private")), "pushed_at": r.get("pushed_at", "")})
    return sorted(repos_, key=lambda r: r["pushed_at"] or "", reverse=True)


_MANIFESTS = ("pyproject.toml", "requirements.txt", "setup.py", "package.json", "go.mod", "Cargo.toml")


def suggest_folder(cfg: dict[str, str], names: list[str]) -> dict[str, Any]:
    """Which folder of the repo is the app: the project folder (nearest one with a pyproject /
    package.json …) holding the files that mention the app's agent and tool names."""
    every = dict(cfg, path="")
    try:
        paths = _cached(("alltree", cfg["repo"], cfg.get("branch")), lambda: _all_paths(every))
    except Exception:  # noqa: BLE001
        return {"path": "", "matched": []}
    roots = {posixpath.dirname(p) for p in paths if posixpath.basename(p) in _MANIFESTS}
    votes: dict[str, int] = {}
    matched: list[str] = []
    for name in names[:4]:
        for hit in search(every, name, 10):
            matched.append(hit)
            d = posixpath.dirname(hit)
            while d and d not in roots:
                d = posixpath.dirname(d)
            votes[d] = votes.get(d, 0) + 1
    best = max(votes, key=lambda k: (votes[k], k.count("/")), default="")
    return {"path": best, "matched": matched[:10]}


def _all_paths(cfg: dict[str, str]) -> list[str]:
    sha = head_commit(cfg)
    data = _get(cfg, f"/repos/{cfg['repo']}/git/trees/{sha}?recursive=1", timeout=60)
    return [t["path"] for t in data.get("tree", []) if t.get("type") == "blob"]


async def config_for_project(project: dict[str, Any] | None) -> dict[str, str] | None:
    """The project's repo settings, refreshing a connected account's expired token first."""
    import asyncio

    from . import projects
    if project and needs_refresh(project):
        f = await asyncio.to_thread(refresh, project["github_refresh"])
        await projects.set_github_auth(project["id"], token=f["token"], refresh=f["refresh"], expires=f["expires"])
        project = await projects.get(project["id"])
    return config_for(project)


# ── Fix branches (write) ────────────────────────────────────────────────────

class WriteError(RuntimeError):
    pass


def _send(cfg: dict[str, str], method: str, url: str, body: dict[str, Any]) -> Any:
    req = urllib.request.Request(API + url, data=json.dumps(body).encode(), method=method, headers={
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "imagent",
        "Authorization": f"Bearer {cfg['token']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 — fixed GitHub host
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        if exc.code in (403, 404) and ("not accessible" in detail or exc.code == 404):
            raise WriteError("imagent can't write to this repo. In the GitHub App's settings set Repository permissions → "
                             "Contents and Pull requests to Read & write, then accept the new permissions on the "
                             "installation (GitHub emails you a link).") from exc
        raise WriteError(f"GitHub {method} {url.split('?')[0]} → HTTP {exc.code}: {detail}") from exc


def latest(cfg: dict[str, str]) -> tuple[str, str]:
    """(branch, head commit) right now — not cached."""
    b = branch(cfg)
    sha = _get(cfg, f"/repos/{cfg['repo']}/commits/{urllib.parse.quote(b, safe='')}")["sha"]
    return b, sha


def read_at(cfg: dict[str, str], path: str, ref: str) -> str | None:
    """A file at a commit; None when it doesn't exist there."""
    try:
        return _get(cfg, f"/repos/{cfg['repo']}/contents/{urllib.parse.quote(path)}?ref={ref}", raw=True)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def create_fix_branch(cfg: dict[str, str], *, base_sha: str, branch_name: str, files: dict[str, str],
                      message: str) -> dict[str, str]:
    """Commit ``files`` (path → new content) on top of ``base_sha`` as a new branch."""
    repo = cfg["repo"]
    base_tree = _get(cfg, f"/repos/{repo}/git/commits/{base_sha}")["tree"]["sha"]
    tree = _send(cfg, "POST", f"/repos/{repo}/git/trees", {
        "base_tree": base_tree,
        "tree": [{"path": p, "mode": "100644", "type": "blob", "content": c} for p, c in files.items()]})
    commit = _send(cfg, "POST", f"/repos/{repo}/git/commits", {"message": message, "tree": tree["sha"], "parents": [base_sha]})
    name = branch_name
    for n in range(2, 20):
        try:
            _send(cfg, "POST", f"/repos/{repo}/git/refs", {"ref": f"refs/heads/{name}", "sha": commit["sha"]})
            break
        except WriteError as exc:
            if "Reference already exists" not in str(exc):
                raise
            name = f"{branch_name}-{n}"
    return {"branch": name, "commit": commit["sha"], "url": f"https://github.com/{repo}/tree/{name}"}


def open_pr(cfg: dict[str, str], *, head: str, base: str, title: str, body: str) -> dict[str, Any]:
    """A draft PR (a regular one where drafts aren't available, e.g. private repos on free plans)."""
    payload = {"title": title, "head": head, "base": base, "body": body, "draft": True}
    try:
        pr = _send(cfg, "POST", f"/repos/{cfg['repo']}/pulls", payload)
    except WriteError as exc:
        if "draft" not in str(exc).lower():
            raise
        pr = _send(cfg, "POST", f"/repos/{cfg['repo']}/pulls", payload | {"draft": False})
    return {"number": pr["number"], "url": pr["html_url"], "draft": bool(pr.get("draft"))}
