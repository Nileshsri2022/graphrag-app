import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { fetchExpand, type Subgraph } from "./api";

type Props = {
  subgraph: Subgraph | null;
  label: string;
};

function nodeStyle(type: string): Record<string, unknown> {
  if (type === "topic") {
    return {
      shape: "diamond",
      width: 22,
      height: 22,
      "background-color": "#D9B35A",
      label: "data(name)",
    };
  }
  if (type === "language") {
    return {
      shape: "hexagon",
      width: 24,
      height: 24,
      "background-color": "#74B28F",
      label: "data(name)",
    };
  }
  if (type === "package") {
    return {
      shape: "round-rectangle",
      width: 26,
      height: 18,
      "background-color": "#E06E78",
      label: "data(name)",
      "font-size": 8,
    };
  }
  if (type === "contributor") {
    return {
      shape: "triangle",
      width: 20,
      height: 20,
      "background-color": "#C792EA",
      label: "data(name)",
      "font-size": 7,
    };
  }
  if (type === "item") {
    return {
      shape: "round-rectangle",
      width: 30,
      height: 16,
      "background-color": "#8B8296",
      "border-width": 1,
      "border-color": "#B9B2C3",
      label: "data(name)",
      "font-size": 7,
    };
  }
  return {
    shape: "ellipse",
    width: 30,
    height: 30,
    "background-color": "#7FA6CC",
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
  const [hovered, setHovered] = useState<{ fullName?: string; stars?: number; language?: string; description?: string; url?: string } | null>(null);

  useEffect(() => {
    if (!containerRef.current || !subgraph) return;
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
            color: "#F2EEE7",
            "font-family": "Inter, sans-serif",
            "border-width": 1,
            "border-color": "#322D38",
            "text-outline-width": 4,
            "text-outline-color": "#131116",
          },
        },
        {
          selector: "node[type = 'repo']",
          style: nodeStyle("repo"),
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
            "line-color": "#4A4352",
            "target-arrow-color": "#4A4352",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            opacity: 0.6,
          },
        },
        {
          selector: "edge[type = 'HAS_TOPIC']",
          style: { "line-color": "#D9B35A", "target-arrow-color": "#D9B35A" },
        },
        {
          selector: "edge[type = 'HAS_LANGUAGE']",
          style: { "line-color": "#74B28F", "target-arrow-color": "#74B28F" },
        },
        {
          selector: "edge[type = 'DEPENDS_ON']",
          style: { "line-color": "#E06E78", "target-arrow-color": "#E06E78", width: 2.5 },
        },
        {
          selector: "edge[type = 'DEPENDS_ON_PKG']",
          style: { "line-color": "#E06E78", "target-arrow-color": "#E06E78", "line-style": "dashed" },
        },
        {
          selector: "edge[type = 'CONTRIBUTED_BY']",
          style: { "line-color": "#C792EA", "target-arrow-color": "#C792EA", "line-style": "dotted" },
        },
        {
          selector: "edge[type = 'LISTED_IN']",
          style: { "line-color": "#E09A5B", "target-arrow-shape": "none", "line-style": "dashed", opacity: 0.7 },
        },
        {
          selector: "node:selected",
          style: { "border-width": 3, "border-color": "#F2EEE7" },
        },
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 },
    });

    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      const data = node.data();
      if (data.type === "repo" || data.type === "item") {
        setHovered({ fullName: data.fullName ?? data.name, kind: data.type, stars: data.stars, language: data.language, description: data.description, url: data.url });
      }
    });

    cy.on("mouseover", "node", (evt) => {
      const data = evt.target.data();
      if (data.type === "repo" || data.type === "item") {
        setHovered({ fullName: data.fullName ?? data.name, kind: data.type, stars: data.stars, language: data.language, description: data.description, url: data.url });
      }
    });

    cyRef.current = cy;
    cy.fit(undefined, 50);
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
      cyRef.current.add([...nodeEls, ...edgeEls]);
      cyRef.current.layout({ name: "cose", animate: true, nodeRepulsion: 8000, idealEdgeLength: 80 }).run();
      cyRef.current.fit(undefined, 50);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingExpand(false);
    }
  };

  return (
    <div className="graph-panel">
      <div className="graph-toolbar">
        <span className="graph-label">{label || "No query yet — ask below"}</span>
        <span className="spacer" />
        <span className="toolbtn-group">
          <button className="btn" title="Fit to view" onClick={() => cyRef.current?.fit(undefined, 50)}>Fit</button>
          <button className="btn" title="Zoom in" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.25)}>+</button>
          <button className="btn" title="Zoom out" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 0.8)}>−</button>
        </span>
        <button className="btn" onClick={handleExpand} disabled={loadingExpand}>
          {loadingExpand ? <span className="spinner" /> : "Expand selected"}
        </button>
        <button className="btn" onClick={() => setLegendOpen((v) => !v)} aria-pressed={legendOpen}>
          Legend
        </button>
      </div>
      {subgraph ? (
        <div className="plate-wrap">
          <span className="plate-corner" />
          <span className="plate-corner br" />
          <div ref={containerRef} id="cy" />
          <div className="plate-caption">
            {subgraph.nodes.length} nodes · {subgraph.edges.length} edges
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
              Ask a question to load the subgraph
            </text>
          </svg>
        </div>
      )}
      {legendOpen && (
        <div className="legend">
          <h4>Legend</h4>
          <div className="legend-section">
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-repo)" }}>●</span> repo</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-topic)" }}>◆</span> topic</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-lang)" }}>⬢</span> language</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-pkg)" }}>▭</span> package</div>
            <div className="lg-item"><span className="lg-swatch" style={{ color: "var(--g-contrib)" }}>▲</span> contributor</div>
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
