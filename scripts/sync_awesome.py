"""Build the awesome layer of the GraphRAG v2 knowledge base.

Reads the awesome README (Nileshsri2022/awesome, 675 list entries,
28 sections) -> for each list repo fetches its README via the GitHub API
(batched, cached, resume on 429: STOP, do not retry in a loop) -> parses
list items -> merges list + item nodes and LISTED_IN edges into a copy of
the current graph (worker/data/graph.json is the base; existing nodes and
edges are kept as-is).

Usage:
  python3 sync_awesome.py [--readme PATH] [--max-lists N]
                          [--only-list SUBSTR] [--full]
  --full   write the merged graph to <repo>/data/graph.json
           (without --full, sample mode: scripts/sample-output/sample-graph.json)
  --max-lists N   process only the first N lists (sample runs)
  --only-list SUBSTR   process only lists whose fullName contains SUBSTR
                       (repeatable; e.g. --only-list awesome-python)

Cache: scripts/.awesome_cache.json, keyed by repo fullName. Reruns resume
from the cache and only fetch what is missing; entries older than 7 days
are refetched so the daily sync picks up list updates. On HTTP 429 fetching stops
immediately (no retry loop); what was fetched stays cached, the graph is
built from fetched data, the rest are recorded as skipped with reason
"rate-limited", and the script exits 0.

Item GitHub metadata (stars/pushedAt/archived) comes from batched GraphQL
lookups (aliases, max 50/query), capped at 5000 lookups per run. Without a
token (GraphQL requires auth) or on failure/miss, an item inherits its
parent list's rating/freshness.

Hard caps: nodes < 50,000, edges < 100,000. A list whose README cannot be
fetched is skipped and recorded in meta.skippedLists -- the sync never
fails as a whole because of one list.

Requires no token for sample runs (unauthenticated REST = 60 req/hr);
set GITHUB_TOKEN for the full run (GitHub Actions provides it).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rating import rate_repo  # noqa: E402
from sync_data_v2 import parse_awesome_entries, slugify_item  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_README = Path.home() / "workspace" / "awesome-readme.md"
DEFAULT_BASE = ROOT / "worker" / "data" / "graph.json"
CACHE_PATH = HERE / ".awesome_cache.json"
API = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
MAX_NODES = 50_000
MAX_EDGES = 100_000
GRAPHQL_BATCH = 50
GRAPHQL_CAP = 5000
ITEM_URL_MAX = 300
CACHE_TTL_DAYS = 7  # cached list READMEs older than this are refetched

LIST_LINK_RE = re.compile(
    r"^\s*[-*]\s+\[([^\]]+)\]\((https://[^)]+)\)\s*(?:-\s*(.*))?$")


class RateLimited(Exception):
    """Raised when GitHub answers 429 (or 403 with an exhausted quota)."""


def log(msg):
    print(msg, flush=True)


def gh_headers(extra=None):
    h = {"Accept": "application/vnd.github+json",
         "User-Agent": "graphrag-awesome-sync"}
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    if extra:
        h.update(extra)
    return h


def gh_get(path, accept=None, timeout=30):
    """GET a GitHub API path. Returns parsed JSON, raw text, or None (404).

    Raises RateLimited on 429 / exhausted-rate-limit 403. Other HTTP
    errors return None (the caller records a skip).
    """
    url = f"{API}{path}"
    req = urllib.request.Request(url, headers=gh_headers(
        {"Accept": accept} if accept else None))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read(5_000_000)
            if accept == "application/vnd.github.raw":
                return data.decode("utf-8", errors="replace")
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RateLimited(f"429 on {path}")
        if e.code == 403:
            remaining = e.headers.get("X-RateLimit-Remaining")
            if remaining == "0":
                raise RateLimited(f"rate limit exhausted on {path}")
            log(f"  403 on {path} (not rate-limit exhaustion) -- skipping")
            return None
        if e.code == 404:
            return None
        log(f"  HTTP {e.code} on {path} -- skipping")
        return None
    except Exception as exc:  # noqa: BLE001 -- network blip: skip, don't die
        log(f"  error on {path}: {exc} -- skipping")
        return None


def parse_awesome_readme(md):
    """Parse the awesome README into list entries.

    Returns (entries, section_count) where each entry is
    {"name", "url", "section", "fullName"} for github.com list repos.
    The Contents section (TOC links) is skipped: its links are anchors,
    not https URLs. Verified count against the local copy: 675 entries.
    """
    entries = []
    section = None
    sections = set()
    for line in md.splitlines():
        m = re.match(r"^## (.+)$", line)
        if m:
            section = m.group(1).strip()
            sections.add(section)
            continue
        if not section or section == "Contents":
            continue
        m = LIST_LINK_RE.match(line)
        if not m:
            continue
        name = re.sub(r"[*_`]+", "", m.group(1).strip())
        url = m.group(2).strip()
        parsed = urlparse(url)
        parts = [p for p in parsed.path.split("/") if p]
        if parsed.netloc != "github.com" or len(parts) < 2:
            continue
        full_name = f"{parts[0]}/{parts[1]}"
        entries.append({"name": name, "url": url, "section": section,
                        "fullName": full_name})
    return entries, len(sections)


def parse_list_items(md):
    """Parse a list repo's README into items with descriptions.

    Same bullet-link rule as sync_data_v2.parse_awesome_entries, plus the
    free text after the link ("- [name](url) - description").
    Returns [{"name", "url", "description"}] in document order.
    """
    out = []
    seen = set()
    for title, url in parse_awesome_entries(md):
        out.append({"name": title, "url": url, "description": ""})
        seen.add((title, url))
    # Second pass for descriptions (kept in sync with the same order).
    descs = {}
    for line in md.splitlines():
        m = LIST_LINK_RE.match(line)
        if not m:
            continue
        title = re.sub(r"[*_`]+", "", m.group(1).strip())
        url = m.group(2).strip()
        desc = (m.group(3) or "").strip()
        descs[(title, url)] = desc
    for item in out:
        item["description"] = descs.get((item["name"], item["url"]), "")
    return out


def github_repo_of(url):
    """Return 'owner/repo' for a github.com URL, else None."""
    parsed = urlparse(url)
    if parsed.netloc != "github.com":
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def fetch_list_meta(full_name):
    """REST /repos/{owner}/{repo}: stars, forks, archived, pushedAt."""
    d = gh_get(f"/repos/{full_name}")
    if not isinstance(d, dict) or not d:
        return None
    return {
        "stars": int(d.get("stargazers_count") or 0),
        "forks": int(d.get("forks_count") or 0),
        "archived": bool(d.get("archived")),
        "pushedAt": (d.get("pushed_at") or "")[:10] or None,
        "updatedAt": (d.get("updated_at") or "")[:10] or None,
        "description": d.get("description") or "",
    }


def fetch_list_readme(full_name):
    """Raw README text of a list repo, or None if it cannot be fetched."""
    text = gh_get(f"/repos/{full_name}/readme",
                  accept="application/vnd.github.raw")
    return text if isinstance(text, str) and text else None


def graphql_item_meta(full_names):
    """Batched GraphQL lookups for item repos.

    Returns {fullName: meta-dict}. Requires a token; without one (or on
    any failure) returns {} and callers fall back to the parent list.
    Capped at GRAPHQL_CAP lookups per run, GRAPHQL_BATCH per query.
    """
    if not TOKEN or not full_names:
        return {}
    out = {}
    names = sorted(set(full_names))[:GRAPHQL_CAP]
    for i in range(0, len(names), GRAPHQL_BATCH):
        batch = names[i:i + GRAPHQL_BATCH]
        fields = []
        for j, fn in enumerate(batch):
            owner, repo = fn.split("/", 1)
            fields.append(
                f'r{j}: repository(owner: "{owner}", name: "{repo}") {{ '
                f"stargazersCount pushedAt updatedAt isArchived }}")
        query = "query { " + " ".join(fields) + " }"
        req = urllib.request.Request(
            f"{API}/graphql",
            data=json.dumps({"query": query}).encode("utf-8"),
            headers={**gh_headers(), "Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read(5_000_000))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise RateLimited("429 on GraphQL")
            log(f"  GraphQL HTTP {e.code} -- remaining items inherit parent")
            return out
        except Exception as exc:  # noqa: BLE001
            log(f"  GraphQL error: {exc} -- remaining items inherit parent")
            return out
        data = payload.get("data") or {}
        for j, fn in enumerate(batch):
            r = data.get(f"r{j}")
            if not r:
                continue
            out[fn] = {
                "stars": int(r.get("stargazersCount") or 0),
                "archived": bool(r.get("isArchived")),
                "pushedAt": (r.get("pushedAt") or "")[:10] or None,
                "updatedAt": (r.get("updatedAt") or "")[:10] or None,
            }
        log(f"  GraphQL: {len(out)} item repos resolved so far")
    return out


def load_cache():
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}
    return {}


def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False),
                          encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--readme", default=str(DEFAULT_README))
    ap.add_argument("--max-lists", type=int, default=None)
    ap.add_argument("--only-list", action="append", default=[])
    ap.add_argument("--full", action="store_true",
                    help="write the merged graph to <repo>/data/graph.json")
    ap.add_argument("--base", default=str(DEFAULT_BASE))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    # ---- 1. awesome README ----
    readme_path = Path(args.readme)
    if readme_path.exists():
        md = readme_path.read_text(encoding="utf-8")
        log(f"awesome README: local {readme_path}")
    else:
        log("local awesome README not found -- fetching via GitHub API")
        md = gh_get("/repos/Nileshsri2022/awesome/readme",
                    accept="application/vnd.github.raw")
        if not md:
            log("FATAL: cannot read the awesome README locally or via API")
            sys.exit(1)
    entries, n_sections = parse_awesome_readme(md)
    log(f"awesome lists parsed: {len(entries)} entries, {n_sections} sections")
    if args.only_list:
        entries = [e for e in entries
                   if any(s.lower() in e["fullName"].lower()
                          for s in args.only_list)]
        log(f"after --only-list filter: {len(entries)} lists")
    if args.max_lists is not None:
        entries = entries[:args.max_lists]
        log(f"after --max-lists {args.max_lists}: {len(entries)} lists")

    cache = load_cache()
    skipped = []          # fullNames skipped this run
    skip_reasons = {}     # fullName -> reason (logged, not stored in meta)
    rate_limited = False
    fetched_lists = {}    # fullName -> {"meta", "items"}

    def cache_fresh(entry):
        """A cached entry is usable only if it has a README + meta and is
        younger than CACHE_TTL_DAYS (so the daily sync eventually picks
        up list updates instead of serving stale READMEs forever)."""
        if not entry or not entry.get("readme") or not entry.get("meta"):
            return False
        try:
            fetched = datetime.strptime(entry.get("fetchedAt", ""),
                                        "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            return False
        return (datetime.now(timezone.utc).replace(tzinfo=None) - fetched).days < CACHE_TTL_DAYS

    # ---- 2. fetch each list (README + repo meta), cached ----
    for idx, entry in enumerate(entries, 1):
        fn = entry["fullName"]
        cached = cache.get(fn)
        if cache_fresh(cached):
            fetched_lists[fn] = {"meta": cached["meta"],
                                 "items": cached.get("items", [])}
            continue
        if rate_limited:
            skipped.append(fn)
            skip_reasons[fn] = "rate-limited"
            continue
        log(f"[{idx}/{len(entries)}] {fn}")
        try:
            readme = fetch_list_readme(fn)
            meta = fetch_list_meta(fn)
        except RateLimited as exc:
            log(f"  RATE LIMITED ({exc}) -- stopping fetches, "
                "building from what was fetched")
            rate_limited = True
            skipped.append(fn)
            skip_reasons[fn] = "rate-limited"
            continue
        if readme is None or meta is None:
            log(f"  skip {fn}: README or metadata unavailable")
            skipped.append(fn)
            skip_reasons[fn] = "unavailable"
            continue
        items = parse_list_items(readme)
        fetched_lists[fn] = {"meta": meta, "items": items}
        cache[fn] = {"meta": meta, "items": items,
                     "readme": readme,
                     "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                 time.gmtime())}
        save_cache(cache)
        log(f"  {len(items)} items, stars={meta['stars']}, "
            f"pushedAt={meta['pushedAt']}")
    if rate_limited:
        # remaining uncached lists were already marked skipped above
        pass
    log(f"lists fetched: {len(fetched_lists)}, skipped: {len(skipped)}")

    # ---- 3. item GitHub metadata (batched GraphQL, capped) ----
    item_repo_names = []
    for fn, data in fetched_lists.items():
        for item in data["items"]:
            repo = github_repo_of(item["url"])
            if repo:
                item_repo_names.append(repo)
    log(f"item GitHub repos to resolve: {len(set(item_repo_names))} unique")
    item_meta = {}
    try:
        item_meta = graphql_item_meta(item_repo_names)
    except RateLimited:
        log("RATE LIMITED during GraphQL -- items inherit parent signals")
    log(f"item repos resolved via GraphQL: {len(item_meta)}")

    # ---- 4. merge into a copy of the base graph ----
    base = json.loads(Path(args.base).read_text(encoding="utf-8"))
    nodes = list(base.get("nodes", []))
    edges = list(base.get("edges", []))
    node_ids = {n["id"] for n in nodes}
    edge_keys = {(e["source"], e["target"], e["type"]) for e in edges}
    node_by_id = {n["id"]: n for n in nodes}

    def add_node(n):
        if n["id"] in node_ids:
            return False
        if len(nodes) >= MAX_NODES:
            return False
        node_ids.add(n["id"])
        node_by_id[n["id"]] = n
        nodes.append(n)
        return True

    def add_edge(s, t, typ):
        key = (s, t, typ)
        if key in edge_keys or s not in node_ids or t not in node_ids:
            return False
        if len(edges) >= MAX_EDGES:
            return False
        edge_keys.add(key)
        edges.append({"source": s, "target": t, "type": typ})
        return True

    lists_added = 0
    items_added = 0
    listed_in_added = 0
    for entry in entries:
        fn = entry["fullName"]
        if fn not in fetched_lists:
            continue
        data = fetched_lists[fn]
        meta = data["meta"]
        last_activity = meta.get("pushedAt") or meta.get("updatedAt")
        rating, freshness = rate_repo(meta["archived"], last_activity,
                                      meta["stars"])
        list_id = f"list:{slugify_item(fn)}"
        if len(nodes) >= MAX_NODES or len(edges) >= MAX_EDGES:
            skipped.append(fn)
            skip_reasons[fn] = "cap-reached"
            continue
        added = add_node({
            "id": list_id, "type": "list", "name": entry["name"],
            "fullName": fn,
            "description": meta.get("description") or "",
            "section": entry["section"], "url": entry["url"],
            "stars": meta["stars"], "forks": meta["forks"],
            "archived": meta["archived"], "pushedAt": meta["pushedAt"],
            "lastActivity": last_activity,
            "rating": rating, "freshness": freshness,
        })
        if added:
            lists_added += 1
        for item in data["items"]:
            item_id = f"item:{slugify_item(item['name'])}"
            repo = github_repo_of(item["url"])
            im = item_meta.get(repo) if repo else None
            if im is not None:
                ia = im.get("pushedAt") or im.get("updatedAt")
                irating, ifresh = rate_repo(im["archived"], ia,
                                            im["stars"])
            else:
                ia, irating, ifresh = last_activity, rating, freshness
            if item_id not in node_ids:
                if len(nodes) >= MAX_NODES:
                    break
                add_node({
                    "id": item_id, "type": "item", "name": item["name"],
                    "url": item["url"][:ITEM_URL_MAX],
                    "description": item.get("description", ""),
                    "rating": irating, "freshness": ifresh,
                    "lastActivity": ia,
                })
                items_added += 1
            else:
                existing = node_by_id[item_id]
                for k, v in (("rating", irating), ("freshness", ifresh),
                             ("lastActivity", ia)):
                    if k not in existing and v is not None:
                        existing[k] = v
            if add_edge(item_id, list_id, "LISTED_IN"):
                listed_in_added += 1

    meta_out = dict(base.get("meta", {}))
    meta_out.update({
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "GitHub API awesome-layer sync (sync_awesome.py) over "
                  "v2 enrichment base",
        "listCount": lists_added,
        "skippedLists": sorted(set(skipped)),
        "searchIndex": None,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "itemCount": sum(1 for n in nodes if n.get("type") == "item"),
        "listedInEdgeCount": sum(1 for e in edges
                                 if e["type"] == "LISTED_IN"),
    })
    graph = {"meta": meta_out, "nodes": nodes, "edges": edges}

    if args.out:
        out_path = Path(args.out)
    elif args.full:
        out_path = ROOT / "data" / "graph.json"
    else:
        out_path = HERE / "sample-output" / "sample-graph.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(graph, ensure_ascii=False),
                        encoding="utf-8")
    log(f"lists added: {lists_added}  items added: {items_added}  "
        f"LISTED_IN edges added: {listed_in_added}")
    log(f"total: {len(nodes)} nodes, {len(edges)} edges "
        f"(caps: {MAX_NODES} / {MAX_EDGES})")
    log(f"skipped lists ({len(meta_out['skippedLists'])}): "
        f"{meta_out['skippedLists'][:20]}")
    for fn, reason in skip_reasons.items():
        log(f"  skipped {fn}: {reason}")
    log(f"wrote {out_path}")
    log("sample mode -- pass --full to write <repo>/data/graph.json"
        if not args.full else "full mode -- wrote <repo>/data/graph.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
