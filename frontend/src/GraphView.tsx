import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { fetchExpand, type Subgraph } from "./api";
import CompareTable from "./CompareTable";

type Props = {
  subgraph: Subgraph | null;
  label: string;
};

function nodeStyle(type: string): Record<string, unknown> {
  if (type === "list") {
    return {
      shape: "square",
      width: 26,
      height: 26,
      "background-color": "#a3e635",
      label: "data(name)",
      "font-size": 8,
    };
  }
  if (type === "topic") {
    return {
      shape: "diamond",
      width: 22,
      height: 22,
      "background-color": "#e7c9ff",
      label: "data(name)",
    };
  }
  if (type === "language") {
    return {
      shape: "hexagon",
      width: 24,
      height: 24,
      "background-color": "#84cc16",
      label: "data(name)",
    };
  }
  if (type === "package") {
    return {
      shape: "round-rectangle",
      width: 26,
      height: 18,
      "background-color": "#ffb4ab",
      label: "data(name)",
      "font-size": 8,
    };
  }
  if (type === "contributor") {
    return {
      shape: "triangle",
      width: 20,
      height: 20,
      "background-color": "#c1cab0",
      label: "data(name)",
      "font-size": 7,
    };
  }
  if (type === "item") {
    return {
      shape: "round-rectangle",
      width: 30,
      height: 16,
      "background-color": "#8b947d",
      "border-width": 1,
      "border-color": "#c1cab0",
      label: "data(name)",
      "font-size": 7,
    };
  }
  return {
    shape: "ellipse",
    width: 30,
    height: 30,
    "background-color": "#7bd0ff",
    label: "data(label)",
    "font-size": 9,
    "text-wrap": "wrap",
    "text-max-width": 90,
  };
}

export default function GraphView({ subgraph, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [loadingExpand, setLoadingExpand] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandNote, setExpandNote] = useState<string | null>(null);
  // Live node/edge counts for the caption. The caption must NOT read the
  // `subgraph` prop (the initial snapshot) — expand adds elements to the
  // Cytoscape instance imperatively, so the prop never changes and the
  // caption stayed at "2 nodes · 1 edges" after the graph grew. Counts are
  // re-read from the live Cytoscape element set after every change.
  const [counts, setCounts] = useState<{ nodes: number; edges: number } | null>(null);
  const [hovered, setHovered] = useState<{ fullName?: string; kind?: string; stars?: number; language?: string; description?: string; url?: string } | null>(null);

  useEffect(() => {
    if (!containerRef.current || !subgraph) return;
    // A new subgraph means a fresh canvas: clear selection + expand feedback.
    setSelectedId(null);
    setExpandNote(null);
    const elements: ElementDefinition[] = [
      ...subgraph.nodes.map((n) => ({
        data: {
          id: n.id,
          type: n.type,
          name: n.name ?? n.fullName ?? n.id,
          label: n.type === "repo" ? (n.fullName?.split("/")[1] ?? n.id) : n.name,
          fullName: n.fullName,
          stars: n.stars,
          language: n.language,
          description: n.description,
          url: n.url,
        },
      })),
      ...subgraph.edges.map((e) => ({
        data: {
          id: `${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          type: e.type,
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            color: "#dfe2eb",
            "font-family": "Geist, Inter, sans-serif",
            "border-width": 1,
            "border-color": "#424936",
            "text-outline-width": 4,
            "text-outline-color": "#080b10",
            // Labels sit BELOW the node shape (centred). The previous
            // default centred the label on the node, so the text overlapped
            // the top edge of small node shapes (list/item nodes).
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 3,
          },
        },
        {
          selector: "node[type = 'repo']",
          style: nodeStyle("repo"),
        },
        {
          selector: "node[type = 'list']",
          style: nodeStyle("list"),
        },
        {
          selector: "node[type = 'topic']",
          style: nodeStyle("topic"),
        },
        {
          selector: "node[type = 'language']",
          style: nodeStyle("language"),
        },
        {
          selector: "node[type = 'package']",
          style: nodeStyle("package"),
        },
        {
          selector: "node[type = 'contributor']",
          style: nodeStyle("contributor"),
        },
        {
          selector: "node[type = 'item']",
          style: nodeStyle("item"),
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#424936",
            "target-arrow-color": "#424936",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            opacity: 0.6,
          },
        },
        {
          selector: "edge[type = 'HAS_TOPIC']",
          style: { "line-color": "#e7c9ff", "target-arrow-color": "#e7c9ff" },
        },
        {
          selector: "edge[type = 'HAS_LANGUAGE']",
          style: { "line-color": "#84cc16", "target-arrow-color": "#84cc16" },
        },
        {
          selector: "edge[type = 'DEPENDS_ON']",
          style: { "line-color": "#ffb4ab", "target-arrow-color": "#ffb4ab", width: 2.5 },
        },
        {
          selector: "edge[type = 'DEPENDS_ON_PKG']",
          style: { "line-color": "#ffb4ab", "target-arrow-color": "#ffb4ab", "line-style": "dashed" },
        },
        {
          selector: "edge[type = 'CONTRIBUTED_BY']",
          style: { "line-color": "#c1cab0", "target-arrow-color": "#c1cab0", "line-style": "dotted" },
        },
        {
          selector: "edge[type = 'LISTED_IN']",
          style: { "line-color": "#84cc16", "target-arrow-shape": "none", "line-style": "dashed", opacity: 0.7 },
        },
        {
          selector: "node:selected",
          style: { "border-width": 3, "border-color": "#dfe2eb" },
        },
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 },
    });

    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      const data = node.data();
      if (data.type === "repo" || data.type === "item" || data.type === "list") {
        setHovered({ fullName: data.fullName ?? data.name, kind: data.type, stars: data.stars, language: data.language, description: data.description, url: data.url });
      }
    });

    cy.on("mouseover", "node", (evt) => {
      const data = evt.target.data();
      if (data.type === "repo" || data.type === "item" || data.type === "list") {
        setHovered({ fullName: data.fullName ?? data.name, kind: data.type, stars: data.stars, language: data.language, description: data.description, url: data.url });
      }
    });

    // Track selection so "Expand selected" can be disabled when nothing is
    // selected (previously it silently did nothing, which looked broken).
    cy.on("select", "node", (evt) => setSelectedId(evt.target.id()));
    cy.on("unselect", "node", () => setSelectedId(null));

    cyRef.current = cy;
    cy.fit(undefined, 50);
    setCounts({ nodes: cy.nodes().length, edges: cy.edges().length });
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [subgraph]);

  const handleExpand = async () => {
    if (!cyRef.current) return;
    const sel = cyRef.current.$("node:selected");
    if (sel.length === 0) return;
    const id = sel[0].id();
    setLoadingExpand(true);
    setExpandNote(null);
    try {
      const sg = await fetchExpand(id);
      const existingIds = new Set(cyRef.current.nodes().map((n) => n.id()));
      const nodeEls = sg.nodes
        .filter((n) => !existingIds.has(n.id))
        .map((n) => ({
          data: { id: n.id, type: n.type, name: n.name ?? n.fullName ?? n.id, label: n.type === "repo" ? (n.fullName?.split("/")[1] ?? n.id) : n.name, fullName: n.fullName, stars: n.stars, language: n.language, description: n.description, url: n.url },
        }));
      // only add edges whose endpoints exist (after adding the new nodes)
      const allIds = new Set([...existingIds, ...nodeEls.map((e) => e.data.id)]);
      const edgeEls = sg.edges
        .filter((e) => allIds.has(e.source) && allIds.has(e.target))
        .map((e) => ({ data: { id: `${e.source}->${e.target}`, source: e.source, target: e.target, type: e.type } }));
      // Dedupe edges already on the canvas so re-expanding a node does not
      // stack duplicate edges.
      const existingEdgeIds = new Set(cyRef.current.edges().map((e) => e.id()));
      const newEdgeEls = edgeEls.filter((e) => !existingEdgeIds.has(e.data.id));
      const added = nodeEls.length + newEdgeEls.length;
      if (added === 0) {
        setExpandNote("No new neighbours for this node.");
        return;
      }
      cyRef.current.add([...nodeEls, ...newEdgeEls]);
      // Re-read the live counts so the caption reflects the grown graph.
      setCounts({ nodes: cyRef.current.nodes().length, edges: cyRef.current.edges().length });
      cyRef.current.layout({ name: "cose", animate: true, nodeRepulsion: 8000, idealEdgeLength: 80 }).run();
      cyRef.current.fit(undefined, 50);
    } catch (err) {
      console.error(err);
      setExpandNote("Expand failed — try again.");
    } finally {
      setLoadingExpand(false);
    }
  };

  return (
    <div className="graph-panel">
      {label.startsWith("compare:") && subgraph && (
        <CompareTable subgraph={subgraph} label={label} />
      )}
      <div className="graph-toolbar">
        <span className="graph-label">{label || "Run a search to load the subgraph"}</span>
        <span className="spacer" />
        <span className="toolbtn-group">
          <button className="btn" title="Fit to view" onClick={() => cyRef.current?.fit(undefined, 50)}>Fit</button>
          <button className="btn" title="Zoom in" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.25)}>+</button>
          <button className="btn" title="Zoom out" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 0.8)}>−</button>
        </span>
        <button
          className="btn"
          onClick={handleExpand}
          disabled={loadingExpand || selectedId === null}
          title={selectedId === null ? "Select a node first" : "Expand the selected node"}
        >
          {loadingExpand ? <span className="spinner" /> : "Expand selected"}
        </button>
        <button className="btn" onClick={() => setLegendOpen((v) => !v)} aria-pressed={legendOpen}>
          Legend
        </button>
      </div>
      {expandNote && <div className="expand-note" role="status">{expandNote}</div>}
      {subgraph ? (
        <div className="plate-wrap">
          <span className="plate-corner" />
          <span className="plate-corner br" />
          <div ref={containerRef} id="cy" />
          <div className="plate-caption">
            {counts ? `${counts.nodes} nodes · ${counts.edges} edges` : `${subgraph.nodes.length} nodes · ${subgraph.edges.length} edges`}
          </div>
        </div>
      ) : (
        <div className="graph-empty">
          <svg width="180" height="120" viewBox="0 0 180 120" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--accent)" />
                <stop offset="1" stopColor="var(--accent-deep)" />
              </linearGradient>
            </defs>
            <circle cx="90" cy="48" r="18" fill="url(#eg)" opacity="0.9" />
            <circle cx="38" cy="84" r="11" fill="var(--g-topic)" opacity="0.85" />
            <circle cx="146" cy="80" r="13" fill="var(--g-lang)" opacity="0.85" />
            <path d="M82 40 L46 76" stroke="var(--g-dep)" strokeWidth="1.6" strokeDasharray="3 3" />
            <path d="M100 42 L136 74" stroke="var(--g-edge)" strokeWidth="1.6" />
            <text x="90" y="112" textAnchor="middle" fontSize="11" fill="var(--dim)" fontFamily="Inter, sans-serif">
              Run a search, then explore the subgraph
            </text>
          </svg>
        </div>
      )}
      {legendOpen && (
        <div className="legend">
          <h4>Legend</h4>
          <div className="legend-section">
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-repo)" }}>●</span> repo</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-list)" }}>■</span> list</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-topic)" }}>◆</span> topic</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-lang)" }}>⬢</span> language</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-pkg)" }}>▭</span> package</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-contrib)" }}>▲</span> contributor</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-item)" }}>▭</span> item</div>
          </div>
          <div className="legend-section edges">
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-dep)" }}>─</span> depends on</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-dep)" }}>┅</span> depends pkg</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-contrib)" }}>┆</span> contributed</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-topic)" }}>·</span> topic edge</div>
          </div>
        </div>
      )}
      {hovered && (
        <div className="node-tip">
          <strong>{hovered.fullName}</strong>
          {hovered.stars !== undefined && <div className="tip-meta">★ {hovered.stars.toLocaleString()} {hovered.language ? `· ${hovered.language}` : ""}</div>}
          {hovered.description && <div className="tip-desc">{hovered.description.slice(0, 160)}</div>}
          {hovered.url && <a className="tip-link" href={hovered.url} target="_blank" rel="noreferrer">Open on GitHub →</a>}
        </div>
      )}
    </div>
  );
}
