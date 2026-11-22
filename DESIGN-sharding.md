# DESIGN — Sharded / lazy-load data (Option B)

Status: implemented on branch `feat/sharded-data` (from main `40783a4`, which
includes PR #6). See also `DESIGN-v2.md` (the v2 design this replaces the
data-loading part of).

## 1. The problem (verified live 2026-11-22)

Data sync run `45023368383` succeeded and built the full graph:

- `data/graph.json` **37 MB** — 88,351 nodes, 110,860 edges, 83,676 items,
  672 lists
- `data/search.json` **18.5 MB** — 62,102 terms

Both were uploaded to R2 (`graphrag-data/graph.json`, `graphrag-data/search.json`)
and the Worker deployed with the MCP code. `POST /mcp initialize` and
`tools/list` work, but `search_best_tool`, `POST /api/answer`, `/api/trending`,
`/api/categories` all return **empty**, and `GET /api/health` returns
`{"ok":true,"meta":{}}`.

Diagnosis (verified): the data IS in R2 (the upload step has no `|| true`
and the run succeeded), the R2 keys match (`data.ts` loads
`bucket.get("graph.json")` / `bucket.get("search.json")`), and the binding
`DATA -> graphrag-data` is correct in `wrangler.toml`. So `loadOnce` in
`worker/src/data.ts` must be failing silently — its `try/catch` swallows the
error. The most likely cause: **37 MB of JSON + 18.5 MB of index, parsed
into JS objects + Maps for 88k nodes / 110k edges, expand well beyond the
free-tier Worker's 128 MB memory (and CPU) at cold start.** R2 solved the
1 MB *bundle* limit, not the runtime memory limit.

Measured on the real data (2026-11-22, `data/graph.json` @ `40783a4`):

| piece | size |
|---|---|
| full `graph.json` | 37 MB |
| full `search.json` | 18.5 MB |
| non-item "skeleton" (4,675 nodes, 13,388 edges) | 1.8 MB |
| catalog (meta + 28 sections + trending-50 + per-section top-10) | 74 KB |
| term-map (62,102 terms -> sections) | 1.1 MB |
| per-section shards, total | 52.1 MB |
| biggest single shard (Miscellaneous, 15,721 items) | 9.5 MB |
| cold start (catalog + term-map + skeleton) | ~3.0 MB |

Term -> #sections: 66% of terms live in exactly 1 section; 10% in >5 sections.
7.0% of items (5,831) are listed in lists spanning >1 section; duplicating
an item into every section it is listed in costs only a **1.09x** size factor
(91,487 assignments vs 83,676 unique items), so shards duplicate those items
for correctness (see §3). Every item has >= 1 `LISTED_IN` edge (0 orphans).

## 2. Goal and constraints

- All 88,351 nodes stay reachable; no data is dropped.
- Cold-start memory stays tiny (a few MB), so the free-tier Worker loads.
- Free tier only. No paid plan, no new paid service.
- MCP tool names, inputs, and response shapes unchanged.
- `/api/*` response shapes unchanged. Web UI unchanged.
- Rating / freshness logic unchanged (same rubric, `rating.ts` / `rating.py`).

## 3. R2 layout (new keys)

The sync uploads these keys (bucket `graphrag-data`). The Worker loads
exactly these keys — verified by grep (see §7). The old keys
`graph.json` / `search.json` are **no longer uploaded and no longer read**
(they stay committed in git as the build inputs / backup only).

| R2 key | contents | size | when loaded |
|---|---|---|---|
| `catalog.json` | `version`, `meta` (from the graph), `sections` (name/listCount/itemCount), `trending` (top-50 precomputed cards), `topBySection` (top-10 cards per section), `skeleton` (all non-item nodes + edges among them) | ~1.9 MB | cold start |
| `termmap.json` | `version`, `sections` (names, index order), `terms`: `{term: [sectionIdx, ...]}` — section indices sorted by posting count desc (most relevant section first) | ~1.1 MB | cold start |
| `shards/<slug>.json` | one file per README section (28). `version`, `section`, `nodes` (item nodes listed in this section + the section's list nodes), `edges` (`LISTED_IN` edges item -> list inside this section), `index` (per-section TF-IDF: `terms` with the **global** idf and postings capped at 20 per term per section, `norms` for docs in this shard) | 2 KB – 9.5 MB each, 52 MB total | on demand, per query |

Section slug: the section name lowercased, non-alphanumeric runs -> `-`
(e.g. `Programming Languages` -> `programming-languages`,
`Front-End Development` -> `front-end-development`,
`Health and Social Science` -> `health-and-social-science`,
`Other` -> `other`).

**Why per-section TF-IDF with the global idf:** the idf is a global
statistic (`ln(1 + N/df)` with N = total docs, df = global document
frequency), so a posting's weight is identical whether it is scored from
the global index or from a section shard. Scores are therefore comparable
across shards, and merging hits across loaded shards gives the same
ranking as the old global index (restricted to the loaded sections).
Postings are capped at **20 per term per section** (the old global cap was
50 per term total); the per-section top-20 are the most relevant docs in
that section, so ranking quality is preserved while shard size stays
bounded.

**Why items are duplicated across sections:** an item listed in lists of
2 sections lives in both shards. This makes `itemsOfList(listId)` correct
for every list (its items are in the shard of the list's section). Merging
across shards dedupes by node id (the existing `answerCards` `seen` map,
and the TF-IDF merge keeps the max score per id).

## 4. Worker flow

### Cold start (`ensureData`, once per isolate)

1. Fetch `catalog.json` + `termmap.json` from R2 **in parallel**.
2. Load the skeleton into the graph module (`loadSkeleton`): all non-item
   nodes (repos, lists, topics, languages, packages, contributors) and the
   edges among them. `meta`, `sectionsWithCounts` (from the catalog's
   precomputed sections), trending and per-section tops come from the
   catalog — no shard fetch needed.
3. Memory after cold start: ~3 MB of JSON parsed (~10 MB in memory).
   The full 37 MB graph is **never** loaded.

`ensureData` keeps its old contract: it never throws; a missing bucket /
object / invalid JSON leaves that feature disabled (empty catalog ->
empty results, never a crash). The old `loadGraphData` /
`loadSearchIndex` full-graph loaders stay in the code for tests and
local-dev fixtures; production never calls them for the full files.

### Per query (async handlers only)

The synchronous retrieval functions (`answerCards`, `retrieve`, `trending`,
`expand`, and the MCP tools) keep operating on loaded in-memory data.
Shard loading happens in the **async handlers**, before those functions
run:

1. Tokenize the question (`queryTerms`); take the content terms
   (the same `contentTerms` filter `answerCards` uses).
2. Look each term up in the term-map -> candidate sections, scored by
   posting count. Take the **top 3 sections** (bounded memory: the 3
   biggest shards are ~24 MB of JSON worst case, ~70 MB parsed — inside
   the 128 MB limit together with the ~10 MB cold-start state).
3. `ensureSections(env, sections)`: fetch those shards from R2 **in
   parallel**, merge each into the graph module (`loadShard`) and register
   its TF-IDF index. Shards already loaded are cached in memory
   (`globalThis`) and never re-fetched in the same isolate.
4. Run the existing synchronous retrieval on skeleton + loaded shards.

Call sites that ensure shards (all async):

| call site | what it ensures |
|---|---|
| `POST /api/answer` (`handleAnswer`) | sections for the question |
| `POST /api/query` (`handleQuery`, BYOK LLM) | sections for the question |
| `POST /api/answer-llm` (`answerLlm`) | sections for the question |
| `GET /api/expand?id=` (`handleExpand`, made async) | the shard of the node's section (list -> its section; item -> its sections via term-map on its name; repo/topic -> skeleton only) |
| `POST /mcp` (`handleMcp` -> `dispatchTool`, made async) | per tool: `search_best_tool` -> sections for the query; `get_tool_details` / `compare_tools` -> sections for the name tokens (URL: tokens from the last path segment); `find_awesome_section` -> the matched lists' sections; `get_trending_tools` -> no shard (catalog) unless a category names a non-section term, then its sections |

### No-shard paths (catalog only)

- `GET /api/health` -> `meta` from the catalog.
- `GET /api/categories` -> `sections` from the catalog.
- `GET /api/trending` -> precomputed `trending` top-50 from the catalog.
- MCP `get_trending_tools` without a category -> catalog trending.
  With a category: a section name -> that section's `topBySection` list;
  anything else -> sections for the category term, then filter the
  loaded items the same way the old code filtered `trending(50)`.

### Search across shards (ranking preserved)

`answerCards` is unchanged in shape. Its three hit sources now draw on
loaded shards:

- TF-IDF: `tfidfSearch` aggregates hits across **all loaded shard
  indexes** (scores use the global idf + per-doc norms, so they are
  comparable; dedupe by id keeping the max score).
- Item name/description matching: `allItems()` returns items in **loaded
  shards only** — which is exactly the candidate set for the query.
- Template retrieval (`retrieve`): runs on the skeleton (repos / topics /
  languages are always loaded), so the label and repo sources are
  unchanged. `itemLookup` ("what is X") uses `findItemsByName` over
  loaded shards.

The merge / sort in `answerCards` (items first by matchCount, then TF-IDF
score, then `compareRanked`; rest by `compareRanked`) is untouched.

## 5. Sync flow (what the builder does)

New script `scripts/build_shards.py` (run **after**
`build_search_index.py`, before the Commit step). Inputs: the just-built
`data/graph.json` + `data/search.json` (read-only). Outputs (written to
`data/shards/`):

- `data/shards/catalog.json`
- `data/shards/termmap.json`
- `data/shards/shards/<slug>.json` (28 files)

It also validates: every item id appears in >= 1 shard; the union of
shard items == all items; every `LISTED_IN` edge's item is in the shard
of the edge's list section; shard count == section count; term-map
covers every term in `search.json`; catalog trending top-1 is the
highest-`compareRanked` node (spot check). It prints sizes per shard and
the cold-start total, and fails the run if any check fails.

The sync workflow (`.github/workflows/sync.yml`) gains two steps (the
exact YAML is in the PR description for manual pasting — workflow files
cannot be pushed via API):

1. `Build data shards (catalog + term-map + per-section)` — runs
   `build_shards.py` after the TF-IDF step.
2. `Upload shards to R2` — uploads `catalog.json`, `termmap.json` and
   `shards/*.json` to `graphrag-data/`, replacing the old
   `graph.json` / `search.json` upload lines. The old upload step is
   removed (the Worker no longer reads those keys). The Commit step
   still commits `data/graph.json` + `data/search.json` (build inputs /
   git backup); the generated `data/shards/` directory is **not**
   committed (it is rebuilt every run; it is large and R2 is the store).

Order matters: shards are uploaded **before** the Build worker /
Deploy worker steps, so the newly deployed Worker finds the shards
already in R2. The first run after this PR merges deploys a Worker that
reads shards; until that run completes, the live Worker is the old one
(still reading `graph.json` / `search.json`, which stay in R2 until
overwritten — they are simply no longer read by the new Worker).

## 6. Tests

- Existing suites keep passing unchanged (smoke 18 + v2 41 + MCP 25 =
  84): they load the full fixture graph via `loadGraphData` /
  `loadSearchIndex`, which stays supported.
- New suite `worker/test/shards.test.ts` (mocked R2 bucket, small
  hand-built shards + a shard built from the fixture graph):
  - catalog + term-map load at cold start; `meta` populated; skeleton
    nodes/edges present; items absent until a shard loads.
  - `ensureSections` fetches only the requested shards, caches them
    (second call issues no R2 GET), merges nodes/edges, and the TF-IDF
    aggregate matches the global-index result for the same query.
  - `answerCards` on loaded shards returns the same top pick as on the
    full fixture graph for "best python testing tool".
  - trending / categories served from the catalog with no shard fetch.
  - `get_tool_details` / `compare_tools` resolve via name tokens.
  - unknown term -> no shard fetch, empty items, repo fallback intact.
  - invalid / missing shard JSON -> feature disabled, never a crash.

## 7. Verification (before claiming success)

- `python3 -m py_compile` on changed scripts; `tsc --noEmit` clean;
  full worker suite green (84 old + new shard tests).
- Local E2E (`wrangler dev --local`, local R2 seeded with shards built
  from the **real** committed graph — 37 MB `graph.json` + 18.5 MB
  `search.json`): `/api/health` meta populated (nodeCount ~88k);
  `POST /api/answer` "best python testing tool" returns ranked cards
  with pytest in the top results; `/api/trending` + `/api/categories`
  non-empty; `POST /mcp tools/call search_best_tool` returns the same
  ranking as `/api/answer`; a second identical search issues no new
  R2 shard GET (cache hit). Cold start loads only catalog + term-map
  (the full graph is never loaded in the test).
- `wrangler deploy --dry-run`: bundle well under 1 MB, `DATA` + `AI`
  bindings listed.
- R2 key check by grep: every key the Worker loads (`catalog.json`,
  `termmap.json`, `shards/<slug>.json`) is exactly a key the sync
  uploads, and vice versa.

## 8. Rollback / fallback

If the sharded Worker misbehaves live, the fix is a Worker redeploy of
the previous commit (the old Worker reads `graph.json` / `search.json`,
which remain in R2). The sync can also be reverted by restoring the old
upload steps. No data is deleted from R2 by this change.
