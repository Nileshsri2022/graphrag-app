"""Build sharded data from a graph.json + search.json (DESIGN-sharding.md).

Reads the full graph (data/graph.json) and TF-IDF index (data/search.json)
and emits, under data/shards/:

  catalog.json   -- meta + sections + trending top-50 + per-section top-10
                    + skeleton (all non-item nodes + edges among them)
  termmap.json   -- term -> [section indices, most relevant first]
  shards/<slug>.json (one per README section)
    -- item nodes listed in that section (an item in lists of 2 sections
       lives in both shards) + the section's list nodes
       + LISTED_IN edges (item -> list inside the section, plus the
         v1-style item -> repo edges for those items)
       + per-section TF-IDF index (global idf, postings capped at 20 per
         term per section, norms for docs in this shard)
       + per-section BM25 data: "docLens" (token count per doc in this
         shard, same tokenization as build_search_index.py) and "avgdl"
         (global average doc length across ALL docs). The Worker needs
         these for length-normalised BM25; they are NOT derivable from
         the TF-IDF weights alone (weights conflate tf with idf, and
         norms are L2 weight norms, not token counts). The global
         search.json is NOT given docLens (it would push it over its
         20 MB cap and trigger posting trims); the legacy full-graph
         path keeps TF-IDF only and BM25 falls back to TF-IDF there.

Inputs are read-only; the builder never edits graph.json / search.json.
Validation fails the run if: an item is in no shard; the union of shard
items != all items; a LISTED_IN edge's item is missing from the shard of
the edge's list section; shard count != section count; the term-map misses
a term from search.json; or the catalog trending top-1 is not the highest
compareRanked node.

Usage: python3 build_shards.py [graph.json] [search.json] [--out data/shards]
Defaults: ../data/graph.json, ../data/search.json -> ../data/shards
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_GRAPH = HERE.parent / "data" / "graph.json"
DEFAULT_SEARCH = HERE.parent / "data" / "search.json"
DEFAULT_OUT = HERE.parent / "data" / "shards"

MAX_POSTINGS_PER_TERM_PER_SECTION = 20
TRENDING_TOP = 50
SECTION_TOP = 10
MAX_SHARDS_PER_QUERY = 3  # documented bound; the worker enforces it too

# Must match worker/src/data.ts `slugifySection` exactly.
SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify_section(name: str) -> str:
    slug = SLUG_RE.sub("-", name.lower()).strip("-")
    return slug or "other"


# ---- rating / freshness (mirrors scripts/rating.py + worker/src/rating.ts) ----
DAYS_PER_MONTH = 30.44
HIGH_STARS = 1000


def months_since(date_str):
    if not date_str:
        return None
    try:
        d = date.fromisoformat(str(date_str)[:10])
    except ValueError:
        return None
    return max(0, (date.today() - d).days // 30)


def rate_node(node):
    """Return (rating 1-5, freshness). Stored values win when present."""
    if node.get("rating") is not None and node.get("freshness"):
        return (node["rating"], node["freshness"])
    if node.get("archived"):
        return (1, "outdated")
    months = months_since(node.get("lastActivity") or node.get("pushedAt"))
    if months is None:
        return (2, "stale")
    stars = node.get("stars") or 0
    if months < 6:
        rating = 5 if stars >= HIGH_STARS else 4
    elif months < 12:
        rating = 4 if stars >= HIGH_STARS else 3
    elif months < 24:
        rating = 3
    elif months < 48:
        rating = 2
    else:
        rating = 1
    freshness = "fresh" if months < 12 else ("stale" if months < 48 else "outdated")
    return (rating, freshness)


FRESH_ORDER = {"fresh": 0, "stale": 1, "outdated": 2}


def compare_ranked_key(node):
    """Sort key replicating worker/src/rating.ts compareRanked (ascending)."""
    rating, freshness = rate_node(node)
    return (
        1 if node.get("archived") else 0,
        FRESH_ORDER[freshness],
        -rating,
        -(node.get("stars") or 0),
    )


def to_card(node, rank, list_name=None):
    # NOTE: no `why` here — the Worker adds it at serve time via
    # buildWhyText (fresh relative time). This entry is an AnswerCard
    # without `why` (see worker/src/retrieval.ts catalogCardToAnswerCard).
    rating, freshness = rate_node(node)
    card = {
        "rank": rank,
        "id": node["id"],
        "type": node["type"],
        "name": node.get("name") or node.get("fullName") or node["id"],
    }
    for key in ("fullName", "url", "description", "language"):
        if node.get(key):
            card[key] = node[key]
    if isinstance(node.get("stars"), int):
        card["stars"] = node["stars"]
    if isinstance(node.get("forks"), int):
        card["forks"] = node["forks"]
    last = node.get("lastActivity") or node.get("pushedAt")
    if last:
        card["lastActivity"] = last
    card["rating"] = rating
    card["freshness"] = freshness
    if list_name:
        card["listName"] = list_name
    return card


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("graph", nargs="?", default=str(DEFAULT_GRAPH))
    ap.add_argument("search", nargs="?", default=str(DEFAULT_SEARCH))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    graph = json.loads(Path(args.graph).read_text(encoding="utf-8"))
    index = json.loads(Path(args.search).read_text(encoding="utf-8"))
    out_dir = Path(args.out)
    shards_dir = out_dir / "shards"
    shards_dir.mkdir(parents=True, exist_ok=True)

    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    meta = graph.get("meta", {})
    by_id = {n["id"]: n for n in nodes}
    lists = [n for n in nodes if n["type"] == "list"]
    items = [n for n in nodes if n["type"] == "item"]
    non_items = [n for n in nodes if n["type"] != "item"]
    item_ids = {n["id"] for n in items}

    list_section = {l["id"]: (l.get("section") or "Other") for l in lists}
    sections = sorted({(l.get("section") or "Other") for l in lists} | {"Other"})
    sec_idx = {s: i for i, s in enumerate(sections)}

    # item -> sections it is listed in (via LISTED_IN to a list node).
    # Items with no list edge (only v1 repo edges) go to "Other".
    item_sections = defaultdict(set)
    item_list_name = {}
    for e in edges:
        if e["type"] != "LISTED_IN":
            continue
        src = e["source"]
        if src not in item_ids:
            continue
        tgt = e["target"]
        if tgt in list_section:
            item_sections[src].add(list_section[tgt])
            # first list seen wins for the card's listName
            item_list_name.setdefault(src, by_id[tgt].get("name") or by_id[tgt].get("fullName") or tgt)
    for it in items:
        if not item_sections[it["id"]]:
            item_sections[it["id"]].add("Other")

    sec_items = defaultdict(list)
    for it in items:
        for s in item_sections[it["id"]]:
            sec_items[s].append(it)

    # ---- skeleton: non-item nodes + edges whose endpoints are both non-item ----
    skel_edges = [e for e in edges
                  if e["source"] not in item_ids and e["target"] not in item_ids]
    skeleton = {"nodes": non_items, "edges": skel_edges}

    # ---- per-section shards ----
    # doc -> sections (items: their sections; lists: their own section;
    # repos/etc: none -- they live in the skeleton, not in a shard).
    doc_sections = {}
    for it in items:
        doc_sections[it["id"]] = item_sections[it["id"]]
    for l in lists:
        doc_sections[l["id"]] = {(l.get("section") or "Other")}

    # per-section TF-IDF: global idf, postings capped per term per section.
    sec_terms = defaultdict(lambda: defaultdict(list))
    sec_norms = defaultdict(dict)
    terms = index.get("terms", {})
    norms = index.get("norms", {})
    for term, entry in terms.items():
        idf = entry["idf"]
        for nid, w in entry["postings"]:
            for s in doc_sections.get(nid, ()):  # repo docs: no section -> skipped
                sec_terms[s][term].append((nid, w))
    for nid, nv in norms.items():
        for s in doc_sections.get(nid, ()):
            sec_norms[s][nid] = nv

    # BM25 data: per-doc token counts + the global average doc length.
    # Same tokenization as build_search_index.py (imported, not duplicated,
    # so the lengths match the index exactly). avgdl is global (all docs)
    # so BM25 scores stay comparable across shards. docLens is per-section
    # (only the docs whose norms live in that shard).
    from build_search_index import doc_text, tokenize
    doc_lens: dict[str, int] = {}
    total_len = 0
    for node in nodes:
        if node.get("type") not in ("item", "repo", "list"):
            continue
        ln = len(tokenize(doc_text(node)))
        doc_lens[node["id"]] = ln
        total_len += ln
    avgdl = round(total_len / len(doc_lens), 4) if doc_lens else 0.0
    sec_doc_lens: dict[str, dict[str, int]] = {}
    for s in sections:
        sec_doc_lens[s] = {nid: doc_lens[nid] for nid in sec_norms.get(s, {})
                           if nid in doc_lens}

    shard_files = {}
    for s in sections:
        its = sec_items.get(s, [])
        sec_lists = [l for l in lists if (l.get("section") or "Other") == s]
        its_ids = {i["id"] for i in its}
        # LISTED_IN edges: item -> list inside this section, plus v1
        # item -> repo edges for items in this shard (repo lives in skeleton).
        shard_edges = [
            e for e in edges
            if e["type"] == "LISTED_IN" and e["source"] in its_ids
            and (e["target"] in list_section and list_section[e["target"]] == s
                 or e["target"] not in list_section)
        ]
        tmap = {}
        for t, plist in sec_terms.get(s, {}).items():
            plist = sorted(plist, key=lambda p: -p[1])[:MAX_POSTINGS_PER_TERM_PER_SECTION]
            tmap[t] = {"idf": terms[t]["idf"],
                       "postings": [[nid, w] for nid, w in plist]}
        shard = {
            "version": 1,
            "section": s,
            "nodes": its + sec_lists,
            "edges": shard_edges,
            "index": {"version": 1, "terms": tmap, "norms": sec_norms.get(s, {}),
                      "docLens": sec_doc_lens.get(s, {}), "avgdl": avgdl},
        }
        slug = slugify_section(s)
        path = shards_dir / f"{slug}.json"
        path.write_text(json.dumps(shard, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        shard_files[s] = (slug, path)

    # ---- term-map: term -> [section indices, most relevant first] ----
    termmap_terms = {}
    for term in terms:
        per_sec = Counter()
        for nid, _w in terms[term]["postings"]:
            for s in doc_sections.get(nid, ()):
                per_sec[s] += 1
        if per_sec:
            termmap_terms[term] = [sec_idx[s] for s, _ in per_sec.most_common()]
    termmap = {"version": 1, "sections": sections, "terms": termmap_terms}

    # ---- catalog: meta + sections + trending + per-section tops + skeleton ----
    sec_counts = []
    for s in sections:
        sec_counts.append({
            "name": s,
            "listCount": len([l for l in lists if (l.get("section") or "Other") == s]),
            "itemCount": len(sec_items.get(s, [])),
        })
    cands = [n for n in nodes if n["type"] in ("item", "repo")]
    cands.sort(key=compare_ranked_key)
    trending = []
    for i, n in enumerate(cands[:TRENDING_TOP]):
        ln = item_list_name.get(n["id"]) if n["type"] == "item" else None
        trending.append(to_card(n, i + 1, ln))
    top_by_section = {}
    for s in sections:
        top = sorted(sec_items.get(s, []), key=compare_ranked_key)[:SECTION_TOP]
        top_by_section[s] = [
            to_card(n, i + 1, item_list_name.get(n["id"])) for i, n in enumerate(top)
        ]
    catalog = {
        "version": 1,
        "meta": meta,
        "sections": sec_counts,
        "trending": trending,
        "topBySection": top_by_section,
        "skeleton": skeleton,
    }

    (out_dir / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out_dir / "termmap.json").write_text(
        json.dumps(termmap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ---- validation ----
    errors = []
    # every item in >= 1 shard
    covered = set()
    for s, its in sec_items.items():
        covered.update(i["id"] for i in its)
    if covered != item_ids:
        errors.append(f"shard item union != all items: missing {len(item_ids - covered)}")
    # every LISTED_IN edge's item is in the shard of the edge's list section
    for e in edges:
        if e["type"] != "LISTED_IN":
            continue
        tgt = e["target"]
        if tgt in list_section:
            s = list_section[tgt]
            if e["source"] not in {i["id"] for i in sec_items.get(s, [])}:
                errors.append(f"LISTED_IN edge item {e['source']} missing from shard {s}")
                break
    if len(shard_files) != len(sections):
        errors.append(f"shard count {len(shard_files)} != section count {len(sections)}")
    # BM25 data complete: every shard's docLens covers exactly its norms
    # docs, and the global average doc length is positive.
    if avgdl <= 0:
        errors.append("BM25 avgdl is not positive")
    for s in sections:
        if set(sec_doc_lens.get(s, {})) != set(sec_norms.get(s, {})):
            errors.append(f"shard {slugify_section(s)}: docLens keys != norms keys")
            break
    # term-map covers every term that has >= 1 posting in a sectioned doc
    # (item or list). Terms whose postings are ONLY in repo docs are
    # legitimately absent: repos live in the skeleton and are found via
    # template retrieval, not via shard routing.
    sectioned_terms = set()
    for term in terms:
        for nid, _w in terms[term]["postings"]:
            if doc_sections.get(nid):
                sectioned_terms.add(term)
                break
    if set(termmap_terms) != sectioned_terms:
        errors.append("term-map misses sectioned terms: "
                      f"{len(sectioned_terms - set(termmap_terms))}")
    # trending top-1 is the highest compareRanked node
    if trending and trending[0]["id"] != cands[0]["id"]:
        errors.append("catalog trending top-1 mismatch")
    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)

    # ---- report ----
    def fsize(p):
        return Path(p).stat().st_size
    cat_size = fsize(out_dir / "catalog.json")
    tm_size = fsize(out_dir / "termmap.json")
    total_shard = 0
    print(f"sections: {len(sections)}  items: {len(items)}  lists: {len(lists)}  "
          f"BM25 avgdl: {avgdl} (docLens in every shard index)")
    print(f"catalog.json: {cat_size/1024:.0f} KB  termmap.json: {tm_size/1024:.0f} KB  "
          f"cold start: {(cat_size + tm_size)/1024:.0f} KB")
    for s in sections:
        slug, path = shard_files[s]
        sz = fsize(path)
        total_shard += sz
        print(f"  shard {slug}.json: {len(sec_items.get(s, []))} items, "
              f"{len(sec_terms.get(s, {}))} terms, {sz/1024:.0f} KB")
    print(f"total shards: {total_shard/1024/1024:.1f} MB  "
          f"trending top-1: {trending[0]['name'] if trending else '-'}")
    print("shards OK")


if __name__ == "__main__":
    main()
