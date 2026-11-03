// Smoke suite — retrieval gates (Karpathy F3). Run: npm test
// Uses only node:assert + tsx; no external test framework.

import assert from "node:assert/strict";
import { retrieve } from "../src/retrieval";
import { meta, allRepos } from "../src/graph";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\n[1] graph integrity");
check("repoCount is 1148", () => {
  assert.equal(meta.repoCount, 1148);
});
check("graph has nodes + edges", () => {
  assert.ok(meta.nodeCount > 1000);
  assert.ok(meta.edgeCount > 1000);
});
check("all repos carry required fields", () => {
  const repos = allRepos();
  assert.ok(repos.length >= 1000);
  for (const r of repos.slice(0, 200)) {
    assert.ok(typeof r.id === "string" && r.id.length > 0);
    assert.ok(typeof r.stars === "number");
    assert.ok(typeof r.url === "string");
  }
});

console.log("\n[2] canned-question retrieval gates (5)");
const gates: [string, (r: ReturnType<typeof retrieve>) => void][] = [
  [
    "top typescript repos",
    (r) => {
      assert.ok(r.sources.length >= 20, `expected >=20 sources, got ${r.sources.length}`);
      assert.equal(r.sources[0].language, "TypeScript");
      assert.ok(r.subgraph.nodes.length > 50);
    },
  ],
  [
    "repos about electron",
    (r) => {
      assert.ok(r.sources.length >= 10, `expected >=10 electron repos, got ${r.sources.length}`);
      assert.ok(r.sources.some((s) => s.id === "awesome-electron"));
    },
  ],
  [
    "most forked repos",
    (r) => {
      assert.ok(r.sources.length > 0);
      assert.ok(r.sources.every((s) => s.isFork === true));
    },
  ],
  [
    "archived repos",
    (r) => {
      assert.ok(r.sources.length > 0);
      assert.ok(r.sources.every((s) => s.archived === true));
    },
  ],
  [
    "top repos",
    (r) => {
      assert.equal(r.sources[0].id, "awesome");
      assert.equal(r.sources[0].stars, 530153);
    },
  ],
];

for (const [q, gate] of gates) {
  check(`"${q}"`, () => gate(retrieve(q)));
}

console.log("\n[3] bounded subgraphs");
check("subgraph ≤ 200 nodes", () => {
  for (const q of ["top typescript repos", "repos about electron"]) {
    assert.ok(retrieve(q).subgraph.nodes.length <= 200);
  }
});

console.log(`\nALL ${passed} CHECKS PASSED\n`);
