"""v2 enrichment: real GitHub topics + package.json dependencies + contributors.

Reads the v1 repo list (xlsx), fetches per repo:
  - official topics          (GET /repos/{o}/{r}/topics)
  - package.json deps        (GET /repos/{o}/{r}/contents/package.json)
  - contributors (top 10)    (GET /repos/{o}/{r}/contributors?per_page=10)

Output: ../data/graph.json (same shape as v1, with richer node/edge types):
  nodes: repo | topic | language | package | contributor
  edges: HAS_TOPIC | HAS_LANGUAGE | DEPENDS_ON (repo→repo) | DEPENDS_ON_PKG (repo→package)
         | CONTRIBUTED_BY (contributor→repo)

Parallel + checkpointed: resumes from last completed repo (cache in .v2_cache.json).
Requires GITHUB_TOKEN (gh auth token).
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / ".." / "reports" / "sindresorhus_repos.xlsx"
OUT = ROOT / "data" / "graph.json"
CACHE = Path(__file__).resolve().parent / ".v2_cache.json"
API = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
CONTRIBUTOR_CAP = 10
PACKAGE_MIN_INBOUND = 3
THREADS = 8
MAX_FILE_BYTES = 1_000_000  # package.json size cap (C3)
MAX_DEPS_PER_REPO = 200
MAX_TOPICS_PER_REPO = 50

if not TOKEN:
    print("FATAL: GITHUB_TOKEN env var required (GITHUB_TOKEN=$(gh auth token) python sync_data_v2.py)")
    sys.exit(1)

import openpyxl  # noqa: E402


def api(path: str, max_bytes: int = 5_000_000) -> dict | list:
    req = urllib.request.Request(f"{API}{path}", headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "graphrag-v2-sync",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                # C3: cap response size (size bombs)
                if int(resp.headers.get("Content-Length", 0) or 0) > max_bytes:
                    print(f"  oversized response for {path}", flush=True)
                    return {}
                data = resp.read(max_bytes + 1)
                if len(data) > max_bytes:
                    print(f"  oversized response (read) for {path}", flush=True)
                    return {}
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as e:
            if e.code == 403 and attempt < 3:
                wait = 25 * (attempt + 1)
                print(f"  403 → sleeping {wait}s", flush=True)
                time.sleep(wait)
                continue
            if e.code == 404:
                return {}
            return {}
        except Exception:  # noqa: BLE001
            time.sleep(2)
    return {}


def clean_name(raw: str) -> str:
    """C3: normalize ids — lowercase, control-char-strip, no '|' nor '->'."""
    s = "".join(ch for ch in raw if ch.isprintable())
    s = s.replace("|", "").replace("->", "-")
    return s.strip().lower()[:80]


def read_v1_repos() -> list[dict]:
    wb = openpyxl.load_workbook(XLSX, read_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    next(rows)
    repos = []
    for row in rows:
        if not row[0] or not row[1]:
            continue
        repos.append({
            "id": row[0],
            "fullName": row[1],
            "description": row[2] or "",
            "homepage": row[3] or "",
            "language": row[4] or "",
            "stars": int(row[5] or 0),
            "forks": int(row[6] or 0),
            "openIssues": int(row[7] or 0),
            "sizeKB": int(row[9] or 0),
            "isFork": str(row[10] or "").strip().lower() == "yes",
            "archived": str(row[11] or "").strip().lower() == "yes",
            "createdAt": str(row[12] or "")[:10],
            "updatedAt": str(row[13] or "")[:10],
            "pushedAt": str(row[14] or "")[:10],
            "url": row[15] or f"https://github.com/{row[1]}",
        })
    return repos


def fetch_topics(full_name: str) -> list[str]:
    d = api(f"/repos/{full_name}/topics")
    if not isinstance(d, dict):
        return []
    out = []
    for t in d.get("names", [])[:MAX_TOPICS_PER_REPO]:
        if isinstance(t, str) and t.strip():
            out.append(clean_name(t))
    return out


def fetch_package_deps(full_name: str) -> list[str]:
    d = api(f"/repos/{full_name}/contents/package.json", max_bytes=MAX_FILE_BYTES)
    if not isinstance(d, dict) or not d.get("content"):
        return []
    try:
        text = base64.b64decode(d["content"]).decode("utf-8", errors="replace")
        pkg = json.loads(text)
    except Exception:  # noqa: BLE001 — malformed JSON → skip repo
        return []
    if not isinstance(pkg, dict):
        return []
    deps = set()
    for section in ("dependencies", "devDependencies"):
        sec = pkg.get(section)
        if isinstance(sec, dict):
            deps.update(k for k in sec.keys() if isinstance(k, str))
    out = []
    for name in deps:
        if len(out) >= MAX_DEPS_PER_REPO:
            break
        out.append(clean_name(name.split("/")[-1]))
    return out


def fetch_contributors(full_name: str) -> list[str]:
    d = api(f"/repos/{full_name}/contributors?per_page={CONTRIBUTOR_CAP}")
    if not isinstance(d, list):
        return []
    out = []
    for c in d:
        login = c.get("login", "") if isinstance(c, dict) else ""
        if isinstance(login, str) and login.strip():
            out.append(clean_name(login))
    return out


def enrich_one(full_name: str) -> dict:
    return {
        "topics": fetch_topics(full_name),
        "deps": fetch_package_deps(full_name),
        "contributors": fetch_contributors(full_name),
    }


def main() -> None:
    repos = read_v1_repos()
    print(f"repos: {len(repos)}", flush=True)

    # load checkpoint
    cache: dict[str, dict] = {}
    if CACHE.exists():
        try:
            cache = json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            cache = {}

    todo = [r["fullName"] for r in repos if r["fullName"] not in cache]
    print(f"cached: {len(cache)}  todo: {len(todo)}", flush=True)

    if todo:
        with ThreadPoolExecutor(max_workers=THREADS) as ex:
            futs = {ex.submit(enrich_one, fn): fn for fn in todo}
            done = 0
            for fut in as_completed(futs):
                fn = futs[fut]
                try:
                    cache[fn] = fut.result()
                except Exception:  # noqa: BLE001
                    cache[fn] = {"topics": [], "deps": [], "contributors": []}
                done += 1
                if done % 200 == 0:
                    print(f"  … {done}/{len(todo)}", flush=True)
        CACHE.write_text(json.dumps(cache), encoding="utf-8")
        print("checkpoint saved", flush=True)

    # ---- build graph ----
    repo_names = {r["id"].lower(): r["id"] for r in repos}
    dep_counts = Counter()
    for fn, c in cache.items():
        dep_counts.update(set(c["deps"]))

    nodes: list[dict] = []
    seen: set[str] = set()

    def add(n: dict) -> None:
        if n["id"] not in seen:
            seen.add(n["id"])
            nodes.append(n)

    for r in repos:
        add({"id": r["id"], "type": "repo", **r})
        c = cache.get(r["fullName"], {"topics": [], "deps": [], "contributors": []})
        if r["language"]:
            add({"id": f"lang:{r['language']}", "type": "language", "name": r["language"]})
        for topic in c["topics"]:
            add({"id": f"topic:{topic}", "type": "topic", "name": topic})
        for dep in c["deps"]:
            if dep in repo_names:
                add({"id": dep, "type": "repo", **next(x for x in repos if x["id"].lower() == dep)})
            elif dep_counts[dep] >= PACKAGE_MIN_INBOUND:
                add({"id": f"pkg:{dep}", "type": "package", "name": dep})
        for contrib in c["contributors"]:
            add({"id": f"user:{contrib}", "type": "contributor", "name": contrib})

    edges: list[dict] = []
    edge_seen: set[str] = set()

    def edge(s: str, t: str, typ: str) -> None:
        key = f"{s}|{t}|{typ}"
        if key not in edge_seen and s in seen and t in seen:
            edge_seen.add(key)
            edges.append({"source": s, "target": t, "type": typ})

    for r in repos:
        c = cache.get(r["fullName"], {"topics": [], "deps": [], "contributors": []})
        if r["language"]:
            edge(r["id"], f"lang:{r['language']}", "HAS_LANGUAGE")
        for topic in c["topics"]:
            edge(r["id"], f"topic:{topic}", "HAS_TOPIC")
        for dep in c["deps"]:
            if dep in repo_names:
                edge(r["id"], dep, "DEPENDS_ON")
            elif dep_counts[dep] >= PACKAGE_MIN_INBOUND:
                edge(r["id"], f"pkg:{dep}", "DEPENDS_ON_PKG")
        for contrib in c["contributors"]:
            edge(f"user:{contrib}", r["id"], "CONTRIBUTED_BY")

    meta = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "GitHub API v2 enrichment (topics/deps/contributors) + xlsx snapshot",
        "repoCount": len(repos),
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "topicCount": sum(1 for n in nodes if n["type"] == "topic"),
        "packageCount": sum(1 for n in nodes if n["type"] == "package"),
        "contributorCount": sum(1 for n in nodes if n["type"] == "contributor"),
        "depEdgeCount": sum(1 for e in edges if e["type"].startswith("DEPENDS_ON")),
    }
    OUT.write_text(json.dumps({"meta": meta, "nodes": nodes, "edges": edges}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
