"use client";

// Detail view for a "landing" history item: { wireframe, competitors?, outline?, text? }.
// The wireframe is the product — first, full width. The scraped top-page skeletons (real
// structures of the ranking pages) sit right after it; the article outline the wireframe was
// grounded on is collapsed below (old records may have it as the only content). JSON in the
// toolbar downloads the WHOLE landing result — wireframe and competitors included.

import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, Check, Download, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { OutlineStructure, OutlineEntities, WireframeView, CompetitorSkeletons, SerpIntentPanel } from "@/components/SeoRenderers";
import { HistoryItem } from "@/lib/seo/history";

export default function SeoLandingDetail({ item }: { item: HistoryItem }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const data = (item.data || {}) as { outline?: any; wireframe?: any; competitors?: any[]; text?: string; wireframeError?: string };
  const { outline, wireframe, competitors, text, wireframeError } = data;

  function copyText() {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  function downloadJson() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `landing-${(item.keyword || "page").replace(/\s+/g, "-").slice(0, 40)}.json`;
    a.click();
  }

  const secCount = outline?.sections?.length || 0;
  const faqCount = outline?.faq?.length || 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <button onClick={() => router.push("/seo-tools/history")} style={btnGhost}><ArrowLeft size={15} /> {t("seoBackToHistory")}</button>
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{item.keyword}</h2>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoCreatedAt")}: {new Date(item.createdAt).toLocaleString()}</div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={downloadJson} style={btnGhost}><Download size={14} /> JSON</button>
        {text && <button onClick={copyText} style={btnGhost}>{copied ? <Check size={14} /> : <Copy size={14} />} {t("seoCopyShort")}</button>}
      </div>

      {(wireframe || wireframeError) && (wireframe
        ? <WireframeView wireframe={wireframe} keyword={item.keyword} />
        : (
          <div className="panel" style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
            ⚠️ Wireframe: {wireframeError === "parse_failed" ? t("seoErrParseJson") : wireframeError}
          </div>
        ))}

      <CompetitorSkeletons competitors={competitors || []} />

      {item.meta?.serpIntent && <SerpIntentPanel analysis={item.meta.serpIntent} />}

      {outline && (
        <div className="panel">
          <div onClick={() => setOutlineOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
            {outlineOpen ? <ChevronDown size={16} color="var(--color-text-secondary)" /> : <ChevronRight size={16} color="var(--color-text-secondary)" />}
            <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoLpOutlineToggle")}</span>
            {secCount > 0 && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>· {t("seoSections")}: {secCount}</span>}
            {faqCount > 0 && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>· FAQ: {faqCount}</span>}
          </div>
          {outlineOpen && (
            <div style={{ marginTop: "14px" }}>
              <OutlineStructure outline={outline} />
              <OutlineEntities outline={outline} />
            </div>
          )}
        </div>
      )}

      {text && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>{t("seoGeneratedText")}</h3>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "13px", lineHeight: 1.6, color: "var(--color-text-primary)", margin: 0, fontFamily: "inherit" }}>{text}</pre>
        </div>
      )}
    </div>
  );
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
