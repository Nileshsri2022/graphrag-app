"""Add README list-item indexing to an EXISTING graph.json (no full re-fetch).

Fetches READMEs only for repos whose name starts with "awesome-" and merges
new "item" nodes + "LISTED_IN" edges into data/graph.json in place.

Usage:  GITHUB_TOKEN=$(gh auth token) python add_items_only.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "data" / "graph.json"
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()

if not TOKEN:
    print("FATAL: GITHUB_TOKEN env var required")
    sys.exit(1)

from sync_data_v2 import fetch_readme, parse_awesome_entries, slugify_item  # noqa: E402


def main() -> None:
    g = json.loads(GRAPH.read_text(encoding="utf-8"))
    nodes = g["nodes"]
    edges = g["edges"]
    by_id = {n["id"]: n for n in nodes}

    item_count = 0
    listed_count = 0
    repos = [n for n in nodes if n["type"] == "repo"]

    for i, r in enumerate(repos, 1):
        if not r["id"].lower().startswith("awesome-"):
            continue
        fn = r["fullName"]
        md = fetch_readme(fn)
        if not md:
            print(f"  [{i}/{len(repos)}] {fn}: no readme", flush=True)
            continue
        entries = parse_awesome_entries(md)
        if not entries:
            print(f"  [{i}/{len(repos)}] {fn}: 0 entries", flush=True)
            continue
        added = 0
        seen_items = set()
        for title, url in entries:
            iid = f"item:{slugify_item(title)}"
            if iid not in by_id:
                nodes.append({"id": iid, "type": "item", "name": title, "url": url})
                by_id[iid] = nodes[-1]
                item_count += 1
            ek = f"{iid}|{r['id']}|LISTED_IN"
            if ek not in g.get("_edge_keys", set()):
                edges.append({"source": iid, "target": r["id"], "type": "LISTED_IN"})
                g.setdefault("_edge_keys", set()).add(ek)
                listed_count += 1
                added += 1
        print(f"  [{i}/{len(repos)}] {fn}: +{added} listed-in edges ({len(entries)} entries)", flush=True)
        if i % 5 == 0:
            time.sleep(1)

    g.pop("_edge_keys", None)
    meta = g["meta"]
    meta["itemCount"] = sum(1 for n in nodes if n["type"] == "item")
    meta["listedInEdgeCount"] = sum(1 for e in edges if e["type"] == "LISTED_IN")
    meta["nodeCount"] = len(nodes)
    meta["edgeCount"] = len(edges)
    meta["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    GRAPH.write_text(json.dumps({"meta": meta, "nodes": nodes, "edges": edges}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in meta.items() if k in ("nodeCount", "edgeCount", "itemCount", "listedInEdgeCount", "repoCount")}, indent=2))


if __name__ == "__main__":
    main()
