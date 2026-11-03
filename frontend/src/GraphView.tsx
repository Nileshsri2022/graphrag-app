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
      "background-color": "#e5a94e",
      label: "data(name)",
    };
  }
  if (type === "language") {
    return {
      shape: "hexagon",
      width: 24,
      height: 24,
      "background-color": "#3fb68b",
      label: "data(name)",
    };
  }
  if (type === "package") {
    return {
      shape: "round-rectangle",
      width: 26,
      height: 18,
      "background-color": "#e5666b",
      label: "data(name)",
      "font-size": 8,
    };
  }
  if (type === "contributor") {
    return {
      shape: "triangle",
      width: 20,
      height: 20,
      "background-color": "#c792ea",
      label: "data(name)",
      "font-size": 7,
    };
  }
  return {
    shape: "ellipse",
    width: 30,
    height: 30,
    "background-color": "#6c8cff",
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
            color: "#e8ebf0",
            "font-family": "Inter, sans-serif",
            "border-width": 1,
            "border-color": "#262c38",
            "text-outline-width": 4,
            "text-outline-color": "#0f1115",
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
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#2c3545",
            "target-arrow-color": "#2c3545",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            opacity: 0.6,
          },
        },
        {
          selector: "edge[type = 'HAS_TOPIC']",
          style: { "line-color": "#e5a94e", "target-arrow-color": "#e5a94e" },
        },
        {
          selector: "edge[type = 'HAS_LANGUAGE']",
          style: { "line-color": "#3fb68b", "target-arrow-color": "#3fb68b" },
        },
        {
          selector: "edge[type = 'DEPENDS_ON']",
          style: { "line-color": "#e5666b", "target-arrow-color": "#e5666b", width: 2.5 },
        },
        {
          selector: "edge[type = 'DEPENDS_ON_PKG']",
          style: { "line-color": "#e5666b", "target-arrow-color": "#e5666b", "line-style": "dashed" },
        },
        {
          selector: "edge[type = 'CONTRIBUTED_BY']",
          style: { "line-color": "#c792ea", "target-arrow-color": "#c792ea", "line-style": "dotted" },
        },
        {
          selector: "node:selected",
          style: { "border-width": 3, "border-color": "#e8ebf0" },
        },
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 },
    });

    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      const data = node.data();
      if (data.type === "repo") {
        setHovered({ fullName: data.fullName, stars: data.stars, language: data.language, description: data.description, url: data.url });
      }
    });

    cy.on("mouseover", "node", (evt) => {
      const data = evt.target.data();
      if (data.type === "repo") {
        setHovered({ fullName: data.fullName, stars: data.stars, language: data.language, description: data.description, url: data.url });
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
        <button className="btn" onClick={() => cyRef.current?.fit(undefined, 50)}>Fit</button>
        <button className="btn" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.25)}>+</button>
        <button className="btn" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 0.8)}>−</button>
        <button className="btn" onClick={handleExpand} disabled={loadingExpand}>
          {loadingExpand ? "…" : "Expand selected"}
        </button>
      </div>
      {subgraph ? (
        <div ref={containerRef} id="cy" />
      ) : (
        <div className="graph-empty">Subgraph will render here</div>
      )}
      <div style={{ position: "absolute", top: 44, right: 12, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px", fontSize: 11, zIndex: 10, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Legend</div>
        <div><span style={{ color: "#6c8cff" }}>●</span> repo</div>
        <div><span style={{ color: "#e5a94e" }}>◆</span> topic</div>
        <div><span style={{ color: "#3fb68b" }}>⬢</span> language</div>
        <div><span style={{ color: "#e5666b" }}>▭</span> package</div>
        <div><span style={{ color: "#c792ea" }}>▲</span> contributor</div>
        <div style={{ marginTop: 4, borderTop: "1px dashed var(--border)", paddingTop: 4 }}>
          <div><span style={{ color: "#e5666b" }}>─</span> depends on</div>
          <div><span style={{ color: "#e5666b" }}>┅</span> depends on package</div>
          <div><span style={{ color: "#c792ea" }}>┆</span> contributed by</div>
        </div>
      </div>
      {hovered && (
        <div style={{ position: "absolute", bottom: 40, left: 20, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px", maxWidth: 320, fontSize: 12, zIndex: 10 }}>
          <strong>{hovered.fullName}</strong>
          {hovered.stars !== undefined && <div>★ {hovered.stars.toLocaleString()} {hovered.language ? `· ${hovered.language}` : ""}</div>}
          {hovered.description && <div style={{ color: "var(--dim)", marginTop: 4 }}>{hovered.description.slice(0, 160)}</div>}
          {hovered.url && <a href={hovered.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>Open on GitHub →</a>}
        </div>
      )}
    </div>
  );
}
