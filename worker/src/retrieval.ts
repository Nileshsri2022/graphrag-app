// Hand-written template retrieval (per the Karpathy review: retrieval IS intent).
// No LLM in the loop for graph queries — deterministic, bounded, cheap.

import {
  allRepos,
  languageNames,
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

export function retrieve(question: string, limit = 30): RetrievalResult {
  const q = norm(question);
  const lang = langOf(question);

  const wantsMostStarred = /\b(top|most|best|highest)\b.*\b(starred?|popular|used)\b|\bstarred?\b.*\b(top|most|highest)\b|\b(?:popular|best)\b.*\b(top|most)\b/.test(q);
  const wantsLeastStarred = /\b(least|fewest)\b.*\b(starred?|popular|used)\b/.test(q);
  const wantsForks = /\b(most|top|most)\b.*\bforks?\b|\bforks?\b.*\b(top|most)\b/.test(q);
  const wantsArchived = /\barchived?\b/.test(q);
  const wantsForked = /\b(?:forked|forks|fork)\b/.test(q);

  const flagIntent = wantsArchived || wantsForked || wantsMostStarred || wantsLeastStarred || (wantsForks && lang === null);
  const topic = flagIntent ? null : topicOf(question);

  let repos: Node[];
  let label: string;

  if (lang) {
    repos = reposWithLanguage(lang);
    label = `${repos.length} repos written in ${lang}`;
  } else if (topic) {
    repos = reposWithTopic(topic);
    label = repos.length
      ? `${repos.length} repos about “${topic}”`
      : `no topic match for “${topic}”; showing top-starred fallback`;
    // topic miss + no flag -> keep all repos so flag filters can still apply
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
