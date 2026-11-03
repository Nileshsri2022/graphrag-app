// Hand-written template retrieval (per the Karpathy review: retrieval IS intent).
// No LLM in the loop for graph queries — deterministic, bounded, cheap.

import {
  allRepos,
  contributorsOf,
  findNodeByName,
  languageNames,
  reposByContributor,
  reposDependingOn,
  reposWithLanguage,
  reposWithTopic,
  subgraphAround,
  subgraphFromRoots,
  type Node,
  type Subgraph,
} from "./graph";

export type RetrievalResult = {
  subgraph: Subgraph;
  sources: Node[]; // primary repo nodes used as context for the LLM
  label: string;   // human-readable description of what matched
};

const LANGS = [
  "javascript", "typescript", "swift", "python", "go", "rust", "java",
  "shell", "html", "css", "objective-c", "c", "c++", "ruby", "php",
  "kotlin", "scala", "haskell", "elixir", "dart", "c#", "sql", "vim",
  "dockerfile", "makefile", "js", "ts", "objc",
];

const STOP = new Set([
  "show", "show", "list", "all", "the", "of", "in", "with", "for",
  "my", "me", "give", "what", "which", "who", "how", "many", "are",
  "is", "there", "repo", "repos", "repositories", "repository", "and",
  "or", "a", "an", "to", "their", "its", "his", "her", "top", "best",
  "most", "some", "any", "those", "these", "that", "this", "from",
  "by", "on", "at", "do", "does", "did", "can", "could", "please",
  "about", "around", "like", "using", "use", "used",
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s#+.-]/g, " ");
}

function langOf(q: string): string | null {
  const nq = norm(q);
  const canonical = languageNames(); // map lowercase -> exact stored name
  for (const l of LANGS) {
    const pat = new RegExp(`(^|\\s)${l.replace("+", "\\+").replace("#", "\\#")}($|\\s)`);
    if (pat.test(nq)) {
      const key = l === "js" ? "javascript" : l === "ts" ? "typescript" : l === "objc" ? "objective-c" : l;
      return canonical.get(key) ?? (l[0].toUpperCase() + l.slice(1));
    }
  }
  return null;
}

function topicOf(q: string): string | null {
  const nq = norm(q);
  // Prefer explicit phrasing
  const m = nq.match(/(?:about|related to|regarding|on|for)\s+([a-z0-9#+.-]{3,40})/);
  if (m) {
    const t = m[1];
    if (!STOP.has(t) && !LANGS.includes(t)) return t;
  }
  // Fallback: meaningful non-stopword
  const words = nq.split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
  if (words.length === 0) return null;
  return words[words.length - 1];
}

function starSort(dir: "desc" | "asc"): (a: Node, b: Node) => number {
  return dir === "desc"
    ? (a, b) => (b.stars ?? 0) - (a.stars ?? 0)
    : (a, b) => (a.stars ?? 0) - (b.stars ?? 0);
}

function jaccardSimilar(repos: Node[], seed: Node, k = 10): Node[] {
  const seedTopics = new Set<string>();
  const seedLang = seed.language ?? "";
  const ids = repos.map((r) => r.id);
  // reuse subgraph neighbor info cheaply: match on language + shared topic nodes via topic edges
  const topicLinks = new Map<string, Set<string>>();
  for (const r of ids) {
    topicLinks.set(r, new Set());
  }
  // gather topic ids per repo from graph (via subgraphFromRoots is heavy; approximate with language + topic name matching)
  // We use a lightweight pass: seed topics = topic nodes connected to seed (found via subgraphAround)
  const seedSg = subgraphAround([seed.id], 200);
  for (const n of seedSg.nodes) {
    if (n.type === "topic") seedTopics.add(n.id);
  }
  const scored: { repo: Node; score: number }[] = [];
  for (const r of repos) {
    if (r.id === seed.id) continue;
    let score = 0;
    if (seedLang && r.language === seedLang) score += 1;
    // cheap topic overlap: check if repo id shares topic ids w/ seed via inEdges of seed topics
    for (const t of seedTopics) {
      // membership check: does r connect to topic t? emulate by counting via reposWithTopic
      if (reposWithTopic(t.replace(/^topic:/, "")).some((x) => x.id === r.id)) score += 1;
    }
    scored.push({ repo: r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.repo);
}

export function retrieve(question: string, limit = 30): RetrievalResult {
  const q = norm(question);
  const lang = langOf(question);

  const wantsMostStarred = /\b(top|most|best|highest)\b.*\b(starred?|popular|used)\b|\bstarred?\b.*\b(top|most|highest)\b|\b(?:popular|best)\b.*\b(top|most)\b/.test(q);
  const wantsLeastStarred = /\b(least|fewest)\b.*\b(starred?|popular|used)\b/.test(q);
  const wantsForks = /\b(most|top|most)\b.*\bforks?\b|\bforks?\b.*\b(top|most)\b/.test(q);
  const wantsArchived = /\barchived?\b/.test(q);
  const wantsForked = /\b(?:forked|forks|fork)\b/.test(q);

  // NEW v2 intents
  const depMatch = q.match(/\b(?:depend|depends|dependencies|uses)\b.*\bon\s+([a-z0-9#+.-]{2,40})\b/);
  const dependOn = depMatch ? depMatch[1] : null;
  const userIdMatch = q.match(/\b(?:by|from|contributed by)\s+([a-z0-9_-]{2,40})\b/);
  const contributorId = userIdMatch ? userIdMatch[1] : null;
  const ofMatch = q.match(/\b(?:contributors? of|who contributed to)\s+([a-z0-9#+.-]{2,40})\b/);
  const contributorsOfRepo = ofMatch ? ofMatch[1] : null;
  const similarMatch = q.match(/\b(?:similar|related)\b.*\bto\s+([a-z0-9#+.-]{2,40})\b/);
  const similarTo = similarMatch ? similarMatch[1] : null;
  const wantsContributors = /\b(?:contributors?|who contributed)\b/.test(q);

  const flagIntent = wantsArchived || wantsForked || wantsMostStarred || wantsLeastStarred || (wantsForks && lang === null)
    || dependOn !== null || contributorId !== null || similarTo !== null || wantsContributors || contributorsOfRepo !== null;
  const topic = flagIntent ? null : topicOf(question);

  let repos: Node[];
  let label: string;

  if (contributorsOfRepo) {
    const target = findNodeByName(contributorsOfRepo);
    const contribs = target ? contributorsOf(target.id) : [];
    label = contribs.length
      ? `${contribs.length} contributors to “${contributorsOfRepo}”`
      : `no contributor data for “${contributorsOfRepo}”`;
    // return the repo itself as source so the LLM has context; contributors ride in subgraph
    repos = target && target.type === "repo" ? [target] : [];
    const subgraph = target ? subgraphAround([target.id], 200) : { nodes: [], edges: [] };
    return { subgraph, sources: repos, label };
  } else if (dependOn) {
    const target = findNodeByName(dependOn);
    repos = target ? reposDependingOn(target.id) : [];
    label = repos.length
      ? `${repos.length} repos depend on “${dependOn}”`
      : `no repos found that depend on “${dependOn}”`;
    if (repos.length === 0) {
      repos = allRepos();
    }
  } else if (similarTo) {
    const seed = findNodeByName(similarTo);
    if (seed && seed.type === "repo") {
      repos = jaccardSimilar(allRepos(), seed, limit);
      label = `${repos.length} repos most similar to “${similarTo}”`;
    } else {
      repos = allRepos();
      label = `could not find “${similarTo}”; showing top-starred`;
    }
  } else if (contributorId) {
    const unode = findNodeByName(`user:${contributorId}`) ?? findNodeByName(contributorId);
    repos = unode ? reposByContributor(unode.id) : [];
    label = repos.length
      ? `${repos.length} repos contributed to by “${contributorId}”`
      : `no repos found for contributor “${contributorId}”`;
    if (repos.length === 0) repos = allRepos();
  } else if (lang) {
    repos = reposWithLanguage(lang);
    label = `${repos.length} repos written in ${lang}`;
  } else if (topic) {
    repos = reposWithTopic(topic);
    label = repos.length
      ? `${repos.length} repos about “${topic}”`
      : `no topic match for “${topic}”; showing top-starred fallback`;
    if (repos.length === 0 && !(wantsArchived || wantsForked)) {
      repos = allRepos();
    }
  } else {
    repos = allRepos();
    label = "all repos";
  }

  if (wantsArchived) {
    repos = repos.filter((r) => r.archived);
    label += " (archived)";
  } else if (wantsForked) {
    repos = repos.filter((r) => r.isFork);
    label += " (forks)";
  }

  if (wantsMostStarred) {
    repos = [...repos].sort(starSort("desc"));
    label += " · sorted by stars (desc)";
  } else if (wantsLeastStarred) {
    repos = [...repos].sort(starSort("asc"));
    label += " · sorted by stars (asc)";
  } else if (wantsForks) {
    repos = [...repos].sort((a, b) => (b.forks ?? 0) - (a.forks ?? 0));
    label += " · sorted by forks (desc)";
  } else {
    repos = [...repos].sort(starSort("desc"));
  }

  const top = repos.slice(0, limit);
  const subgraph = repos.length > 0 ? subgraphAround(top.map((r) => r.id), 200) : { nodes: [], edges: [] };

  return { subgraph, sources: top, label };
}

/** Expand a node id into its neighborhood (for click-to-expand in the SPA). */
export function expand(nodeId: string, nodeCap = 30): Subgraph {
  return subgraphFromRoots([nodeId], nodeCap);
}

export function formatSources(sources: Node[]): string {
  return sources
    .map((r) => {
      const desc = r.description ? ` — ${r.description.slice(0, 120)}` : "";
      return `- ${r.fullName ?? r.id} (★${r.stars ?? 0}, ${r.language ?? "n/a"}${r.archived ? ", archived" : ""})${desc}`;
    })
    .join("\n");
}

export function formatRelationships(sg: Subgraph): string {
  const lines: string[] = [];
  for (const e of sg.edges) {
    if (e.type === "HAS_LANGUAGE" || e.type === "HAS_TOPIC") continue;
    const s = e.source.replace(/^user:/, "").replace(/^pkg:/, "");
    const t = e.target.replace(/^user:/, "").replace(/^pkg:/, "");
    const rel =
      e.type === "DEPENDS_ON" ? `${s} depends on ${t}`
      : e.type === "DEPENDS_ON_PKG" ? `${s} depends on package ${t}`
      : e.type === "CONTRIBUTED_BY" ? `${s} contributed to ${t}`
      : `${s} --${e.type}--> ${t}`;
    lines.push(`- ${rel}`);
  }
  return lines.slice(0, 120).join("\n");
}
