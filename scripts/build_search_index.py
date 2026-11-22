"""Build a TF-IDF inverted index from a graph.json and write search.json.

Format (the worker loads exactly this -- do not change it):
  {"version": 1,
   "terms": {"<term>": {"idf": <float>,
                        "postings": [["<nodeId>", <weight>], ...]}},
   "norms": {"<nodeId>": <float>}}

Docs = item + repo + list nodes. Text = name + description (+ fullName
for repos). Tokenize lowercase alphanumeric, min length 2, drop a small
English stopword list. weight = (1 + ln(tf)) * idf; idf = ln(1 + N/df);
norms = sqrt(sum of squared weights) per doc. Postings sorted desc by
weight, max 50 per term. Terms with df < 2 are dropped UNLESS the term
appears in a node's name.

Size cap: search.json MUST be <= 20 MB. The index lives in Cloudflare R2
now (not in the Worker bundle), so the old 500 KB bundle budget no longer
applies; 20 MB is a sanity cap. The builder trims (lower postings cap, then
drops low-idf terms) until it fits.

Usage: python3 build_search_index.py [graph.json] [--out search.json]
Defaults: ../data/graph.json -> ../data/search.json
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_GRAPH = HERE.parent / "data" / "graph.json"
DEFAULT_OUT = HERE.parent / "data" / "search.json"
MAX_BYTES = 20 * 1024 * 1024  # 20 MB sanity cap (R2, not a bundle budget)
MAX_POSTINGS = 50

STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
    "by", "at", "from", "as", "is", "are", "was", "were", "be", "been",
    "it", "its", "this", "that", "these", "those", "you", "your", "we",
    "our", "they", "their", "he", "she", "his", "her", "not", "no", "do",
    "does", "did", "can", "could", "will", "would", "should", "may",
    "more", "most", "other", "some", "any", "all", "into", "over", "under",
    "up", "down", "out", "about", "between", "through", "after", "before",
    "when", "where", "which", "who", "whom", "what", "how", "why", "if",
    "then", "than", "so", "such", "only", "own", "same", "too", "very",
    "just", "also", "via", "per", "etc", "use", "used", "using", "based",
    "awesome", "list", "github",
}

TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(text):
    """Lowercase alphanumeric tokens, min length 2, stopwords dropped."""
    if not text:
        return []
    return [t for t in TOKEN_RE.findall(text.lower())
            if len(t) >= 2 and t not in STOPWORDS]


def doc_text(node):
    parts = [node.get("name", ""), node.get("description", "")]
    if node.get("type") == "repo" and node.get("fullName"):
        parts.append(node["fullName"])
    return " ".join(p for p in parts if p)


def build_index(graph, max_postings=MAX_POSTINGS, min_idf=None):
    """Return (index_dict, doc_count, term_count)."""
    docs = [n for n in graph.get("nodes", [])
            if n.get("type") in ("item", "repo", "list")]
    n_docs = len(docs)
    name_terms = defaultdict(set)  # term -> node ids where it is in the name
    tf = {}  # node id -> Counter(term -> tf)
    df = Counter()
    for node in docs:
        name_toks = tokenize(node.get("name", ""))
        toks = tokenize(doc_text(node))
        counts = Counter(toks)
        tf[node["id"]] = counts
        for t in counts:
            df[t] += 1
        for t in set(name_toks):
            name_terms[t].add(node["id"])
    terms = {}
    norms = {}
    for node in docs:
        counts = tf[node["id"]]
        norm_sq = 0.0
        for t, c in counts.items():
            if df[t] < 2 and node["id"] not in name_terms.get(t, ()): 
                continue
            idf = math.log(1 + n_docs / df[t])
            if min_idf is not None and idf < min_idf:
                continue
            w = (1 + math.log(c)) * idf
            norm_sq += w * w
        norms[node["id"]] = round(math.sqrt(norm_sq), 4) if norm_sq else 0.0
    # second pass: postings (skip terms pruned above by recomputing idf)
    postings = defaultdict(list)
    for node in docs:
        counts = tf[node["id"]]
        for t, c in counts.items():
            if df[t] < 2 and node["id"] not in name_terms.get(t, ()): 
                continue
            idf = math.log(1 + n_docs / df[t])
            if min_idf is not None and idf < min_idf:
                continue
            w = (1 + math.log(c)) * idf
            postings[t].append((node["id"], round(w, 4)))
    for t, plist in postings.items():
        plist.sort(key=lambda p: -p[1])
        terms[t] = {"idf": round(math.log(1 + n_docs / df[t]), 4),
                    "postings": [[nid, w] for nid, w in plist[:max_postings]]}
    return {"version": 1, "terms": terms, "norms": norms}, n_docs, len(terms)


def dump_size(index):
    return len(json.dumps(index, ensure_ascii=False, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("graph", nargs="?", default=str(DEFAULT_GRAPH))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    graph_path = Path(args.graph)
    out_path = Path(args.out)
    graph = json.loads(graph_path.read_text(encoding="utf-8"))

    index, n_docs, n_terms = build_index(graph)
    size = dump_size(index)
    # Trim until it fits the 10 MB cap (safety valve; the full graph is ~5 MB
    # and normally fits without trimming).
    cap = MAX_POSTINGS
    while size > MAX_BYTES and cap > 5:
        cap //= 2
        index, n_docs, n_terms = build_index(graph, max_postings=cap)
        size = dump_size(index)
    min_idf = 0.0
    while size > MAX_BYTES:
        min_idf += 0.5
        index, n_docs, n_terms = build_index(graph, max_postings=cap,
                                             min_idf=min_idf)
        size = dump_size(index)
        if min_idf > 5.0:
            break
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(index, ensure_ascii=False,
                                   separators=(",", ":")),
                        encoding="utf-8")
    print(f"docs: {n_docs}  terms: {n_terms}  "
          f"size: {size} bytes ({size / 1024:.1f} KB)  "
          f"limit: {MAX_BYTES} bytes  out: {out_path}")
    if size > MAX_BYTES:
        print("WARNING: search.json still exceeds 10 MB budget", file=sys.stderr)
        sys.exit(1)
    print("search index OK")


if __name__ == "__main__":
    main()
