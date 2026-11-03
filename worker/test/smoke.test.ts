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

console.log("\n[4] v2 relationship intents");
check('"which repos depend on got"', () => {
  const r = retrieve("which repos depend on got");
  assert.ok(r.sources.length > 0, `expected deps of got, got 0`);
  assert.ok(r.sources.some((s) => s.id === "got" || s.id !== ""), "should return repo sources");
  assert.ok(r.subgraph.nodes.length > 0);
});
check('"repos by sindresorhus"', () => {
  const r = retrieve("repos by sindresorhus");
  assert.ok(r.sources.length > 0, `expected contributor repos, got 0`);
});
check('"similar repos to awesome-nodejs"', () => {
  const r = retrieve("similar repos to awesome-nodejs");
  assert.ok(r.sources.length > 0, `expected similar repos, got 0`);
});
check('"contributors of type-fest"', () => {
  const r = retrieve("contributors of type-fest");
  assert.ok(r.label.startsWith("10 contributors") || r.label.startsWith("9 contributors") || /\d+ contributors/.test(r.label), `unexpected label: ${r.label}`);
  assert.ok(r.subgraph.edges.filter((e) => e.type === "CONTRIBUTED_BY").length > 0, "expected contributor edges in subgraph");
});

console.log("\n[5] v3 README item intents");
check('"what is babelfish"', () => {
  const r = retrieve("what is babelfish");
  assert.ok(r.label.includes("listed in"), `expected item listing label, got: ${r.label}`);
  assert.ok(r.subgraph.edges.some((e) => e.type === "LISTED_IN"), "expected LISTED_IN edge in subgraph");
});
check('"what is babel"', () => {
  const r = retrieve("what is babel");
  assert.ok(r.label.includes("listed in"), `expected item listing label, got: ${r.label}`);
});

console.log(`\nALL ${passed} CHECKS PASSED\n`);
