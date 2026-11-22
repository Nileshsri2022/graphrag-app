# GraphRAG v2 — Design doc (Awesome as knowledge base)

Approved by user 2026-11-22. Goal: make graphrag-app useful for OTHER users so they
never need the official awesome site (a wall of lists, overwhelming to search).
All 7 improvements are FREE (no paid service). UI approved 2026-11-22: Stitch "best"
(dark premium #080b10/#0e1218 + lime #84cc16/#a3e635, radial glow, dot-matrix bg,
screen 5a02f291965f4f0891fa9e0d2de6e018). Style reference:
`~/workspace/your_files/stitch-designs/graphrag-graphrag-best-desktop.html`.

## Current state (verified 2026-11-22, main @ 1c89603)

- Graph: 5,421 nodes (1,148 sindresorhus repos + 2,855 topics + 1,418 items),
  14,862 edges. Items are the entries of the sindresorhus/awesome README only.
- Frontend (`frontend/src/App.tsx`): chat-first (chat + GraphView side by side).
  HARD-GATES on an LLM API key (`if (!provider.apiKey) open settings`) — no-key
  users cannot ask anything.
- Worker (`worker/src/retrieval.ts`): hand-written template intents only
  (compare / best-for / alternatives / deps / contributors / similar / lang /
  topic / "what is X" item lookup). Sorts by stars/forks. No freshness, no
  rating, no semantic matching.
- Sync (`.github/workflows/sync.yml`): daily cron exists, but (a) uses the
  WINDOWS path `.venv/Scripts/python.exe` on `ubuntu-latest` — almost certainly
  broken, (b) hardcodes `repoCount == 1148`, (c) UI never shows `meta.generatedAt`.
- Source of truth for the new knowledge base: `Nileshsri2022/awesome`
  (fork of sindresorhus/awesome; readme.md, 675 list entries, 28 sections;
  local copy at `~/workspace/awesome-readme.md`).

## The 7 improvements

### 1. Index items INSIDE the lists (biggest change)
- New script `scripts/sync_awesome.py` (extends `sync_data_v2.py`, does not break it):
  read the awesome README (local `~/workspace/awesome-readme.md` or via API) ->
  675 list entries (name, url, description, section) -> for each list repo,
  fetch its README via GitHub API (batched, cached, resume on 429: STOP, do not
  retry in a loop) -> parse list items (name, url, description).
- Nodes: `list` (675, type "list", with section + description + stars/pushedAt/
  archived of the list repo) + `item` (the tools inside, with url + description
  + parent list id). Edges: `LISTED_IN` (item -> list).
- Hard caps from sync.yml stay: nodes < 50,000, edges < 100,000. Expected:
  ~675 lists + ~15,000-25,000 items. If a list README cannot be fetched, skip
  it and record it in `meta.skippedLists` — never fail the whole sync.
- Keep the existing sindresorhus-repo nodes/topics/deps as-is (do not delete
  working data); the awesome layer is ADDED, and the UI surfaces items first.

### 2. No-key mode (default path)
- New worker endpoint `POST /api/answer` (no LLM): runs retrieval, returns
  ranked answer cards (JSON) — works with NO key at all. This becomes the
  DEFAULT search path in the frontend.
- LLM streaming (`/api/query`) stays for users WITH a key (BYOK) as an
  enhancement ("Ask the LLM" toggle). Remove the hard gate in `App.tsx`.
- Workers AI free tier (optional, capped): `env.AI` binding in `wrangler.toml`
  + a `POST /api/answer-llm` path using `@cf/meta/llama-3-8b-instruct` for short
  answers, capped (e.g. 20/day per IP + a global daily cap) so it stays free.
  When the cap is hit, fall back to template answers — NEVER spend money.
  If the AI binding is not configured, the endpoint returns 501 and the UI
  falls back silently.

### 3. Freshness + rating signals (on nodes, at sync time)
- Rating rubric (approved by user 2026-11-22, "how much used in current era"):
  5 = active <6mo + high stars, widely used; 4 = active <1yr, strong adoption;
  3 = niche but alive / declining, activity 1-2yr; 2 = 2-4yr no activity,
  superseded; 1 = 4-5yr+ no activity, archived, or obsolete tech.
  Rules: archived -> max 1. Stars alone never give 5 — activity is required.
- Compute at sync time for every list repo AND every item that links to a
  GitHub repo (batched GraphQL for pushedAt/stars/archived; fall back to the
  parent list's signals when the lookup fails). Store on the node:
  `rating` (1-5), `freshness` ("fresh" | "stale" | "outdated"),
  `lastActivity` (pushedAt date).
- Worker ranking: score = rating first, then stars, then freshness penalty
  (outdated items sink, archived items last). UI shows the rating (stars
  1-5) + a green "Fresh" / amber "Outdated" badge on every card.

### 4. Semantic search (free, build-time)
- NO paid embeddings and NO hosted vector DB. At sync time, build a TF-IDF
  index over item names + descriptions (+ list names) and store a compact
  inverted index in the graph bundle (or `worker/data/search.json`).
- Worker: TF-IDF cosine ranking + synonym expansion for common terms
  (e.g. "js" -> javascript, "db" -> database). This is the "meaning-based"
  search — it fixes keyword-only matching without any per-query cost.
- True neural embeddings are DELIBERATELY deferred: 20k items would exceed
  the Workers AI free allowance (10k neurons/day) in a single build. Record
  this in the README so nobody "upgrades" it into a bill.

### 5. Answer-first UI (approved Stitch "best")
- Apply the approved Stitch design to the frontend (tokens from
  `graphrag-graphrag-best-desktop.html`: bg #080b10/#0e1218, lime #84cc16/
  #a3e635, radial glow, dot-matrix bg, huge display type).
- Layout: hero (giant headline "Find the best tool. Skip the list." + big
  search bar + Ctrl-K hint + "No key needed" badge) -> use-case chips ->
  category filter bar WITH counts -> ranked answer cards (#1/#2/#3, thumbnail,
  name, one-line description, stars, last updated, 5-star rating, Fresh/
  Outdated badge, "why it fits" line, votes, "Open repo" button).
- Graph becomes an "Explore" secondary view (toggle), NOT side-by-side by
  default. Mobile: single column, no horizontal scroll, tap targets >=44px.
- Footer shows "Data as of <meta.generatedAt date>" + repo/item counts.

### 6. Guided discovery
- Use-case chips run template queries ("I want to build a website", "Best
  Python testing tool", "Lightweight static site generator", "Compare two
  tools"). Category filter bar with live counts (from list sections/topics).
- "Trending" section: top items by stars + recent activity, computed in the
  worker from node signals (no extra service).

### 7. Auto-refresh (fix + surface)
- Fix `sync.yml`: `.venv/Scripts/python.exe` -> `.venv/bin/python` on Linux
  (or `uv run`); replace the hardcoded `repoCount == 1148` assertion with a
  dynamic check (counts > 0 and under the hard caps). Keep the daily cron and
  the worker redeploy. The new `sync_awesome.py` runs in the same workflow.
- UI: "Data as of <date>" (from `meta.generatedAt`) in the footer. If the
  snapshot is older than 7 days, show a subtle "data may be stale" note.

## Cost guardrails (must hold)
- No paid service anywhere. Workers AI only behind a daily cap with template
  fallback. No OpenAI embeddings, no hosted vector DB. If the graph outgrows
  the Worker bundle, move it to KV/R2 free tier — do not pay for a bigger plan.
- GitHub API: batch + cache; on HTTP 429 stop immediately, resume next run.

## Verification (before PR)
- `worker`: `npm ci`, `tsc --noEmit`, `npm test` (add tests: rating bands,
  freshness, TF-IDF ranking, no-key endpoint, cap fallback).
- `scripts`: run the sync on a SMALL sample first (e.g. 5 lists) and verify
  node/edge counts + a known item; then the full run.
- `frontend`: `npm ci`, `npm run build`; browser check on the built SPA
  (search works with NO key, ranked cards render, filter bar counts match,
  mobile ~390px no horizontal overflow — phone check still needs the user).
- Do NOT push workflow files via the GitHub API (Apps cannot push
  `.github/workflows/*` without Workflows permission — 403). The `sync.yml`
  fix must be applied by the user on GitHub web, OR by committing it through
  the normal git push path if available; verify by read-back. If the API
  blocks it, tell the user the exact file to paste.

## Branch / PR
- Branch: `feat/awesome-kb-v2` from `main` (1c89603). PR to `main` with a
  summary of the 7 improvements + verification results. Do not merge without
  the user's approval.
