"use client";

import { useEffect, useState, useMemo } from "react";
import { GitFork, Download, Info, RefreshCw, AlertCircle, Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface DomainNode {
  id: string;
  domain: string;
  pages: number;
}

export default function IndexerLinksPage() {
  const { t } = useLanguage();
  const [domains, setDomains] = useState<DomainNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [topology, setTopology] = useState<"mesh" | "ring" | "pyramid">("ring");
  const [nodePositions, setNodePositions] = useState<Array<{ id: string; domain: string; x: number; y: number }>>([]);
  const [isLarge, setIsLarge] = useState(false);

  const fetchDomains = async () => {
    try {
      const res = await fetch("/api/indexer/domains");
      if (res.ok) {
        const d = await res.json();
        setDomains(d.map((x: any) => ({ id: x.id, domain: x.domain, pages: x.pagesCount })));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDomains();
    setIsLarge(window.innerWidth > 960);
  }, []);

  // Compute node positions on a circle inside the SVG coordinate space (400x300)
  useEffect(() => {
    if (domains.length === 0) return;

    const width = 500;
    const height = 280;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.35;

    const positions = domains.map((d, index) => {
      const angle = (index / domains.length) * 2 * Math.PI - Math.PI / 2;
      
      // For pyramid, let's skew coordinates vertically
      let x = cx + radius * Math.cos(angle);
      let y = cy + radius * Math.sin(angle);

      if (topology === "pyramid") {
        const tier = index % 3; // 3 tiers: 0 (top), 1 (mid), 2 (low)
        const itemsInTier = domains.filter((_, idx) => idx % 3 === tier).length;
        const tierIndex = Math.floor(index / 3);
        
        y = 50 + tier * 90;
        x = (width / (itemsInTier + 1)) * (tierIndex + 1);
      }

      return {
        id: d.id,
        domain: d.domain,
        x,
        y
      };
    });

    setNodePositions(positions);
  }, [domains, topology]);

  // Compute edges based on topology selection
  const edges = useMemo(() => {
    if (nodePositions.length < 2) return [];
    const list: Array<{ from: typeof nodePositions[0]; to: typeof nodePositions[0]; id: string }> = [];

    if (topology === "ring") {
      // Connect in circular chain
      for (let i = 0; i < nodePositions.length; i++) {
        const from = nodePositions[i];
        const to = nodePositions[(i + 1) % nodePositions.length];
        list.push({ from, to, id: `${from.id}-${to.id}` });
      }
    } else if (topology === "mesh") {
      // Connect each node with 2 other random nodes deterministically
      for (let i = 0; i < nodePositions.length; i++) {
        const from = nodePositions[i];
        const next1 = nodePositions[(i + 1) % nodePositions.length];
        const next2 = nodePositions[(i + 2) % nodePositions.length];
        list.push({ from, to: next1, id: `${from.id}-${next1.id}` });
        list.push({ from, to: next2, id: `${from.id}-${next2.id}` });
      }
    } else if (topology === "pyramid") {
      // Low tiers link to mid tiers, mid tiers link to top tier
      for (let i = 0; i < nodePositions.length; i++) {
        const from = nodePositions[i];
        const fromTier = i % 3;
        if (fromTier > 0) {
          // Find nodes in upper tier (tier - 1)
          const targetTier = fromTier - 1;
          const targets = nodePositions.filter((_, idx) => idx % 3 === targetTier);
          if (targets.length > 0) {
            // Link to one of them deterministically
            const to = targets[i % targets.length];
            list.push({ from, to, id: `${from.id}-${to.id}` });
          }
        }
      }
    }

    return list;
  }, [nodePositions, topology]);

  const copyLinkMapCode = () => {
    if (domains.length === 0) return;
    let code = "<!-- OpenGSC Cross-linking map export -->\n";
    if (topology === "ring") {
      domains.forEach((d, idx) => {
        const nextD = domains[(idx + 1) % domains.length];
        code += `<a href="https://${nextD.domain}/" target="_blank">${nextD.domain} deals</a>\n`;
      });
    } else {
      domains.forEach(d => {
        code += `<a href="https://${d.domain}/" target="_blank">visit ${d.domain}</a>\n`;
      });
    }
    navigator.clipboard.writeText(code);
    alert(t("linksAlertCopied"));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Description Banner */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "4px"
      }}>
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
          {t("indexerTabLinks")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}>
          {t("indexerTabDescLinks")}
        </p>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: isLarge ? "1fr 1.3fr" : "1fr",
        gap: "24px",
        alignItems: "start",
      }}>
      {/* Configuration Controls */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px"
      }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
          {t("linksTitle")}
        </h3>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>
          {t("linksDesc")}
        </p>

        {/* Selection */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
            {t("linksTopologyType")}
          </span>
          {[
            { id: "ring", label: t("linksRingLabel"), desc: t("linksRingDesc") },
            { id: "mesh", label: t("linksMeshLabel"), desc: t("linksMeshDesc") },
            { id: "pyramid", label: t("linksPyramidLabel"), desc: t("linksPyramidDesc") }
          ].map(top => (
            <div
              key={top.id}
              onClick={() => setTopology(top.id as any)}
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: "10px",
                padding: "12px",
                cursor: "pointer",
                background: topology === top.id ? "rgba(41,151,255,0.06)" : "transparent",
                borderColor: topology === top.id ? "var(--color-accent-blue)" : "var(--color-border)",
                transition: "all 0.15s",
                display: "flex",
                flexDirection: "column",
                gap: "4px"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyItems: "center", gap: "8px" }}>
                <input
                  type="radio"
                  checked={topology === top.id}
                  onChange={() => {}}
                  style={{ accentColor: "var(--color-accent-blue)" }}
                />
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>
                  {top.label}
                </span>
              </div>
              <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 0 20px" }}>
                {top.desc}
              </p>
            </div>
          ))}
        </div>

        <button
          onClick={copyLinkMapCode}
          disabled={domains.length === 0}
          style={{
            padding: "10px",
            borderRadius: "8px",
            background: "var(--color-accent-blue)",
            color: "#fff",
            fontSize: "13px",
            fontWeight: 600,
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            opacity: domains.length === 0 ? 0.7 : 1,
            transition: "background 0.15s"
          }}
          onMouseOver={e => { if (domains.length > 0) e.currentTarget.style.background = "var(--color-accent-blue-dark)"; }}
          onMouseOut={e => { if (domains.length > 0) e.currentTarget.style.background = "var(--color-accent-blue)"; }}
        >
          <Download size={14} />
          {t("linksExportButton")}
        </button>
      </div>

      {/* Visual Canvas */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px"
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyItems: "center", gap: "8px" }}>
          <GitFork size={16} color="var(--color-accent-blue)" />
          <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
            {t("linksVisualTitle")}
          </h3>
        </div>

        {loading ? (
          <div style={{ height: "300px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)" }}>
            <RefreshCw size={20} className="spin" style={{ marginRight: "8px" }} />
            {t("linksCalculating")}
          </div>
        ) : domains.length === 0 ? (
          <div style={{
            height: "300px",
            border: "1px dashed var(--color-border)",
            borderRadius: "12px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            color: "var(--color-text-secondary)",
            padding: "0 24px",
            textAlign: "center"
          }}>
            <AlertCircle size={24} />
            {t("linksNoDomainsTitle")}
            <span style={{ fontSize: "11px" }}>{t("linksNoDomainsDesc")}</span>
          </div>
        ) : (
          <div style={{ background: "var(--color-bg)", borderRadius: "12px", border: "1px solid var(--color-border-soft)", padding: "10px", display: "flex", justifyContent: "center" }}>
            <svg viewBox="0 0 500 280" style={{ width: "100%", height: "280px" }}>
              {/* Edges / Connections */}
              {edges.map((edge) => (
                <path
                  key={edge.id}
                  d={`M ${edge.from.x} ${edge.from.y} L ${edge.to.x} ${edge.to.y}`}
                  stroke="rgba(41,151,255,0.25)"
                  strokeWidth="1.5"
                  fill="none"
                  markerEnd="url(#arrow)"
                />
              ))}

              {/* Arrow definitions */}
              <defs>
                <marker
                  id="arrow"
                  viewBox="0 0 10 10"
                  refX="18"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(41,151,255,0.6)" />
                </marker>
              </defs>

              {/* Node Circles */}
              {nodePositions.map((node) => (
                <g key={node.id}>
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r="8"
                    fill="var(--color-card)"
                    stroke="var(--color-accent-blue)"
                    strokeWidth="3"
                  />
                  <text
                    x={node.x}
                    y={node.y - 12}
                    textAnchor="middle"
                    fill="var(--color-text-primary)"
                    fontSize="9px"
                    fontWeight="700"
                    style={{ background: "var(--color-bg)" }}
                  >
                    {node.domain.split(".")[0]}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        )}

        <div style={{
          display: "flex",
          gap: "8px",
          padding: "10px 14px",
          borderRadius: "8px",
          background: "rgba(255,255,255,0.02)",
          border: "1px solid var(--color-border-soft)",
          fontSize: "12px",
          color: "var(--color-text-secondary)",
          alignItems: "flex-start"
        }}>
          <Info size={14} color="var(--color-accent-blue)" style={{ marginTop: "2px", flexShrink: 0 }} />
          <span>
            {t("linksFooterNote")}
          </span>
        </div>
      </div>
      </div>
    </div>
  );
}
