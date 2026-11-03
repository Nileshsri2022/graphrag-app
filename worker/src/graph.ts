// In-memory graph over the repo snapshot. Loaded once at worker startup.

import graphData from "../data/graph.json";

export type Node = {
  id: string;
  type: "repo" | "language" | "topic" | "package" | "contributor";
  name?: string;
  fullName?: string;
  description?: string;
  language?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  archived?: boolean;
  isFork?: boolean;
  url?: string;
  homepage?: string;
};

export type EdgeType = "HAS_LANGUAGE" | "HAS_TOPIC" | "DEPENDS_ON" | "DEPENDS_ON_PKG" | "CONTRIBUTED_BY";

export type Edge = {
  source: string;
  target: string;
  type: EdgeType;
};

export type Subgraph = {
  nodes: Node[];
  edges: Edge[];
};

const NODES = graphData.nodes as Node[];
const EDGES = graphData.edges as Edge[];

const byId = new Map<string, Node>(NODES.map((n) => [n.id, n]));
const outEdges = new Map<string, Edge[]>();
const inEdges = new Map<string, Edge[]>();
for (const e of EDGES) {
  (outEdges.get(e.source) ?? outEdges.set(e.source, []).get(e.source)!).push(e);
  (inEdges.get(e.target) ?? inEdges.set(e.target, []).get(e.target)!).push(e);
}

export const meta = graphData.meta as Record<string, unknown>;

export function getNode(id: string): Node | undefined {
  return byId.get(id);
}

export function neighbors(id: string, max = 50): { node: Node; via: Edge }[] {
  const out: { node: Node; via: Edge }[] = [];
  for (const e of outEdges.get(id) ?? []) {
    const n = byId.get(e.target);
    if (n) out.push({ node: n, via: e });
    if (out.length >= max) break;
  }
  for (const e of inEdges.get(id) ?? []) {
    const n = byId.get(e.source);
    if (n) out.push({ node: n, via: e });
    if (out.length >= max) break;
  }
  return out;
}

export function allRepos(): Node[] {
  return NODES.filter((n) => n.type === "repo");
}

export function reposWithTopic(topic: string): Node[] {
  const tid = `topic:${topic.toLowerCase()}`;
  const ids = (inEdges.get(tid) ?? []).map((e) => e.source);
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

let langMapCache: Map<string, string> | null = null;

/** lowercase -> exact stored language name (e.g. "typescript" -> "TypeScript"). */
export function languageNames(): Map<string, string> {
  if (!langMapCache) {
    langMapCache = new Map();
    for (const n of NODES) {
      if (n.type === "language" && n.name) {
        langMapCache.set(n.name.toLowerCase(), n.name);
      }
    }
  }
  return langMapCache;
}

/** Repos that depend on the given repo/package id (incoming DEPENDS_ON / DEPENDS_ON_PKG). */
export function reposDependingOn(id: string): Node[] {
  const ids = (inEdges.get(id) ?? [])
    .filter((e) => e.type === "DEPENDS_ON" || e.type === "DEPENDS_ON_PKG")
    .map((e) => e.source);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

/** Contributors of a repo (outgoing to user nodes), and repos a user contributed to. */
export function contributorsOf(id: string): Node[] {
  const ids = (outEdges.get(id) ?? [])
    .filter((e) => e.type === "CONTRIBUTED_BY")
    .map((e) => e.target);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

export function reposByContributor(userId: string): Node[] {
  const ids = (inEdges.get(userId) ?? [])
    .filter((e) => e.type === "CONTRIBUTED_BY")
    .map((e) => e.source);
  return ids.map((x) => byId.get(x)!).filter(Boolean);
}

export function findNodeByName(name: string): Node | undefined {
  const n = name.toLowerCase().replace(/^@/, "").replace("_", "-");
  const exact = byId.get(n) ?? byId.get(`topic:${n}`) ?? byId.get(`pkg:${n}`) ?? byId.get(`user:${n}`);
  if (exact) return exact;
  for (const node of allRepos()) {
    if (node.id.toLowerCase() === n) return node;
  }
  return undefined;
}

export function reposWithLanguage(lang: string): Node[] {
  const lid = `lang:${lang}`;
  const ids = (inEdges.get(lid) ?? []).map((e) => e.source);
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

/** Build a bounded subgraph around the given repo ids (1-hop). */
export function subgraphAround(ids: string[], nodeCap = 200): Subgraph {
  const wanted = new Set<string>(ids);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seenEdges = new Set<string>();
  const pushEdge = (e: Edge) => {
    const key = `${e.source}|${e.target}|${e.type}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push(e);
    }
  };

  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    nodes.push(n);
    for (const e of outEdges.get(id) ?? []) {
      pushEdge(e);
      if (wanted.has(e.target)) continue;
      if (nodes.length < nodeCap) {
        const t = byId.get(e.target);
        if (t) {
          nodes.push(t);
          wanted.add(e.target);
        }
      }
    }
    for (const e of inEdges.get(id) ?? []) {
      pushEdge(e);
      if (!wanted.has(e.source)) {
        const s = byId.get(e.source);
        if (s) {
          nodes.push(s);
          wanted.add(e.source);
        }
      }
    }
  }
  return { nodes: nodes.slice(0, nodeCap), edges };
}

/** Bounded subgraph from a list of topic/language root ids. */
export function subgraphFromRoots(roots: string[], nodeCap = 200): Subgraph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const seenEdges = new Set<string>();
  for (const r of roots) {
    const root = byId.get(r);
    if (!root || seen.has(r)) continue;
    seen.add(r);
    nodes.push(root);
    for (const e of outEdges.get(r) ?? []) {
      const key = `${e.source}|${e.target}|${e.type}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push(e);
      }
      if (nodes.length < nodeCap && !seen.has(e.target)) {
        const t = byId.get(e.target);
        if (t) {
          seen.add(e.target);
          nodes.push(t);
        }
      }
    }
    for (const e of inEdges.get(r) ?? []) {
      const key = `${e.source}|${e.target}|${e.type}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push(e);
      }
      if (nodes.length < nodeCap && !seen.has(e.source)) {
        const s = byId.get(e.source);
        if (s) {
          seen.add(e.source);
          nodes.push(s);
        }
      }
    }
  }
  return { nodes, edges };
}
