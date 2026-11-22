# worker/data — test fixtures + sync base graph

`graph.json` and `search.json` here are checked-in files with two roles:

1. **Test fixtures** — the worker tests (`worker/test/smoke.test.ts` and
   `v2.test.ts`) load them explicitly. They are **not bundled** into the
   Worker.
2. **Sync base graph** — `scripts/sync_awesome.py` reads `graph.json` as the
   base and merges the awesome layer on top of it (output goes to
   `data/graph.json`).

Live data lives in Cloudflare R2 (bucket `graphrag-data`, keys `graph.json`
and `search.json`); the worker loads it at cold start (see
`worker/src/data.ts`). The sync workflow writes the fresh snapshot to
`data/` (repo root) and uploads it to R2 — it never writes here.
