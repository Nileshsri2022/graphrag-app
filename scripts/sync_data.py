"""Build a graph snapshot of sindresorhus repos from the exported xlsx.

Output: ../data/graph.json  { nodes: [...], edges: [...], meta: {...} }

Node types:
  repo     — one per repository (id = repo name)
  language — primary language node
  topic    — keyword extracted from description (appears in >= 2 repos)

Edge types:
  HAS_LANGUAGE (repo -> language)
  HAS_TOPIC   (repo -> topic)

This is a metadata-only graph (no file-level indexing) per the MVP scope.
"""

from __future__ import annotations

import json
import re
import string
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / ".." / "reports" / "sindresorhus_repos.xlsx"
OUT = ROOT / "data" / "graph.json"

STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "for", "with", "that", "this",
    "from", "your", "you", "are", "was", "were", "has", "have", "had",
    "not", "can", "all", "its", "his", "her", "their", "they", "them",
    "what", "which", "when", "where", "how", "into", "over", "under",
    "about", "than", "then", "there", "these", "those", "will", "would",
    "should", "could", "does", "doing", "made", "make", "making", "using",
    "used", "use", "etc", "e", "g", "like", "just", "also", "even",
    "more", "most", "some", "such", "only", "own", "other", "any",
    "new", "now", "one", "two", "get", "got", "see", "via", "etc",
    "resources", "resource", "tool", "tools", "list", "lists", "awesome",
    "app", "apps", "project", "projects", "stuff", "things", "thing",
    "http", "https", "com", "org", "net", "www", "github",
}

def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")

def extract_keywords(description: str) -> list[str]:
    if not description:
        return []
    text = description.lower()
    # strip the [NOTICE] / [SUBMISSIONS...] style brackets
    text = re.sub(r"\[[^\]]*\]", " ", text)
    tokens = re.findall(r"[a-z][a-z0-9\-]{2,}", text)
    words = []
    for t in tokens:
        t = t.strip("-")
        if len(t) < 4 or t in STOPWORDS or t in words:
            continue
        words.append(t)
    return words[:8]

def row_to_repo(row: tuple) -> dict | None:
    (name, full_name, description, homepage, language, stars, forks,
     open_issues, watchers, size_kb, is_fork, archived, created,
     updated, last_push, url) = row
    if not name or not full_name:
        return None
    return {
        "id": name,
        "fullName": full_name,
        "description": description or "",
        "homepage": homepage or "",
        "language": language or "",
        "stars": int(stars or 0),
        "forks": int(forks or 0),
        "openIssues": int(open_issues or 0),
        "sizeKB": int(size_kb or 0),
        "isFork": str(is_fork).strip().lower() == "yes",
        "archived": str(archived).strip().lower() == "yes",
        "createdAt": str(created or "")[:10],
        "updatedAt": str(updated or "")[:10],
        "pushedAt": str(last_push or "")[:10],
        "url": url or f"https://github.com/{full_name}",
    }

def main() -> None:
    wb = openpyxl.load_workbook(XLSX, read_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    header = next(rows)

    repos: list[dict] = []
    for row in rows:
        repo = row_to_repo(row)
        if repo:
            repos.append(repo)

    # ---- keyword extraction across all repos ----
    kw_count: dict[str, int] = {}
    for repo in repos:
        for kw in extract_keywords(repo["description"]):
            kw_count[kw] = kw_count.get(kw, 0) + 1

    # topics shared by >= 2 repos (keeps graph meaningful + bounded)
    topics = sorted(k for k, c in kw_count.items() if c >= 2)

    # ---- build nodes/edges ----
    nodes: list[dict] = []
    edges: list[dict] = []
    seen: set[str] = set()

    def add_node(node: dict) -> None:
        if node["id"] not in seen:
            seen.add(node["id"])
            nodes.append(node)

    for repo in repos:
        add_node({"id": repo["id"], "type": "repo", **repo})
        if repo["language"]:
            lang_id = f"lang:{repo['language']}"
            add_node({"id": lang_id, "type": "language", "name": repo["language"]})
            edges.append({"source": repo["id"], "target": lang_id, "type": "HAS_LANGUAGE"})
        for kw in extract_keywords(repo["description"]):
            if kw not in topics:
                continue
            topic_id = f"topic:{kw}"
            add_node({"id": topic_id, "type": "topic", "name": kw})
            edges.append({"source": repo["id"], "target": topic_id, "type": "HAS_TOPIC"})

    meta = {
        "generatedAt": __import__("datetime").datetime.now().utcnow().isoformat() + "Z",
        "source": "sindresorhus_repos.xlsx (GitHub snapshot)",
        "repoCount": len(repos),
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "topicCount": len(topics),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"meta": meta, "nodes": nodes, "edges": edges}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(meta, indent=2))

if __name__ == "__main__":
    main()
