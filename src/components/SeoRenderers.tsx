"use client";

import { useState } from "react";
import { FileText, Wand2, Download, Loader2, ChevronDown, ChevronRight, BarChart3, LayoutTemplate, Globe } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { wireframeToMarkdown } from "@/lib/seo/outlineFormat";

const W_COLOR = (w: number) => w >= 9 ? "#ff453a" : w >= 7 ? "#ff9f0a" : "#2997ff";
const PRI: Record<string, string> = { high: "#ff453a", medium: "#ff9f0a", low: "#34c759" };
const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };

const ents = (arr: any[]): { name: string; weight?: number }[] =>
  (arr || []).map(e => typeof e === "string" ? { name: e } : { name: e.name, weight: e.weight });
const wc = (sec: any) => sec.word_count_total || sec.word_count;

// ─── Content structure (sections, titles, FAQ) ───────────────────────────────────
export function OutlineStructure({ outline }: { outline: any }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });
  const meta = outline.meta || {};
  return (
    <div>
      {meta.title_options?.length > 0 && <Block title={t("seoTitleOptions")}>{meta.title_options.map((x: string, i: number) => <Pill key={i} text={x} />)}</Block>}
      {meta.description_options?.length > 0 && <Block title={t("seoDescOptions")}>{meta.description_options.map((x: string, i: number) => <Pill key={i} text={x} />)}</Block>}
      {meta.slug_options?.length > 0 && <Block title={t("seoSlugOptions")}>{meta.slug_options.map((x: string, i: number) => <Pill key={i} text={x} />)}</Block>}

      {outline.sections?.length > 0 && (
        <div style={{ marginTop: "16px" }}>
          <div className="tool-section-label">{t("seoSections")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {outline.sections.map((sec: any, i: number) => (
              <div key={i} style={{ border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
                <div onClick={() => setOpen(o => ({ ...o, [i]: !o[i] }))} style={{ display: "flex", alignItems: "center", gap: "9px", padding: "10px 12px", cursor: "pointer" }}>
                  {open[i] ? <ChevronDown size={15} color="var(--color-text-secondary)" /> : <ChevronRight size={15} color="var(--color-text-secondary)" />}
                  <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-accent-blue)", background: "rgba(41,151,255,0.12)", padding: "2px 7px", borderRadius: "5px" }}>{sec.h_level}</span>
                  <span style={{ flex: 1, fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{sec.heading}</span>
                  {Array.isArray(wc(sec)) && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{wc(sec)[0]}–{wc(sec)[1]} {t("seoWordsShort")}</span>}
                  {sec.needs_real_experience && <span title={t("seoNeedExperience")} style={{ fontSize: "10px", color: "var(--color-accent-orange)" }}>● {t("seoNeedExperience")}</span>}
                </div>
                {open[i] && (
                  <div style={{ padding: "0 12px 14px 36px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6, display: "flex", flexDirection: "column", gap: "8px" }}>
                    {Array.isArray(sec.word_count_self) && <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{wc(sec)?.[0]}–{wc(sec)?.[1]} {t("seoWcTotal")} · {sec.word_count_self[0]}–{sec.word_count_self[1]} {t("seoWcSelf")}</div>}
                    {sec.summary && <div><b style={{ color: "var(--color-text-primary)" }}>{t("seoSummaryLabel")}:</b> {sec.summary}</div>}
                    {ents(sec.entities_to_cover).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", alignItems: "center" }}>
                        {ents(sec.entities_to_cover).map((e, j) => <WeightPill key={j} name={e.name} weight={e.weight} />)}
                      </div>
                    )}
                    {sec.keywords?.length > 0 && <div><b style={{ color: "var(--color-text-primary)" }}>{t("seoKeysLabel")}</b> {sec.keywords.join(", ")}</div>}
                    {sec.visual_elements?.length > 0 && (
                      <div>
                        <b style={{ color: "var(--color-text-primary)" }}>{t("seoVisualElements")}:</b>
                        <ul style={{ margin: "4px 0 0", paddingLeft: "16px" }}>
                          {sec.visual_elements.map((v: any, j: number) => (
                            <li key={j}>{typeof v === "string" ? v : <><b>{v.type}{v.title ? ` · ${v.title}` : ""}</b>{v.description ? ` — ${v.description}` : ""}</>}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {sec.copywriter_notes && <div style={{ fontStyle: "italic", padding: "8px 10px", background: "var(--color-bg)", borderRadius: "6px" }}><b style={{ fontStyle: "normal", color: "var(--color-text-primary)" }}>{t("seoCopywriterNotes")}:</b> {sec.copywriter_notes}</div>}
                    {sec.entity_connections?.length > 0 && (
                      <div>
                        <b style={{ color: "var(--color-text-primary)" }}>{t("seoEntityConnections")}:</b>
                        <div style={{ display: "flex", flexDirection: "column", gap: "3px", marginTop: "4px" }}>
                          {sec.entity_connections.map((c: any, j: number) => <Triplet key={j} c={c} />)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {outline.faq?.length > 0 && (
        <Block title={t("seoFaq")}>
          <div style={{ width: "100%" }}>
            {outline.faq.map((f: any, i: number) => (
              <div key={i} style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "4px" }}>
                <b style={{ color: "var(--color-text-primary)" }}>{f.question}</b> — {f.answer_guideline}
              </div>
            ))}
          </div>
        </Block>
      )}

      {outline.authority_fields_to_fill_by_user?.length > 0 && (
        <div style={{ marginTop: "14px", padding: "12px 14px", borderRadius: "8px", background: "rgba(255,159,10,0.06)", border: "1px solid rgba(255,159,10,0.22)" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-accent-orange)", marginBottom: "5px" }}>{t("seoFillManually")}</div>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {outline.authority_fields_to_fill_by_user.map((a: string, i: number) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Entity analysis (sub-intents, EAV table, analysis) ──────────────────────────
export function OutlineEntities({ outline }: { outline: any }) {
  const { t } = useLanguage();
  return (
    <div>
      {outline.sub_intents?.length > 0 && (
        <Block title={t("seoSubIntentMap")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
            {outline.sub_intents.map((si: any, i: number) => typeof si === "string"
              ? <Pill key={i} text={si} />
              : (
                <div key={i} style={{ fontSize: "12px", color: "var(--color-text-secondary)", padding: "7px 10px", border: "1px solid var(--color-border)", borderRadius: "7px" }}>
                  <b style={{ color: "var(--color-text-primary)" }}>{si.intent}</b>{si.section ? <span style={{ color: "var(--color-accent-blue)" }}> → {si.section}</span> : null}{si.word_count ? <span style={{ color: "var(--color-text-tertiary)" }}> · {si.word_count}</span> : null}
                  {si.coverage && <div style={{ marginTop: "2px" }}>{si.coverage}</div>}
                </div>
              ))}
          </div>
        </Block>
      )}

      {outline.entities?.length > 0 && (
        <Block title={t("seoEntityTable")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}>
            {outline.entities.map((e: any, i: number) => (
              <div key={i} style={{ padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: "7px", fontSize: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                  {e.weight != null && <WeightDot weight={e.weight} />}
                  <b style={{ color: "var(--color-text-primary)" }}>{e.name}</b>
                  {e.type && <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border)", padding: "1px 6px", borderRadius: "10px" }}>{e.type}</span>}
                </div>
                {e.attributes && Object.keys(e.attributes).length > 0 && (
                  <div style={{ marginTop: "4px", color: "var(--color-text-secondary)" }}>
                    {Object.entries(e.attributes).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                  </div>
                )}
                {e.relationship_triplets?.length > 0 && (
                  <div style={{ marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" }}>
                    {e.relationship_triplets.map((tr: any, j: number) => <span key={j} style={{ color: "var(--color-text-tertiary)", fontFamily: "monospace", fontSize: "11px" }}>{typeof tr === "string" ? tr : `${tr.subject} → ${tr.predicate} → ${tr.object}`}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Block>
      )}

      {outline.entity_analysis && <EntityAnalysis ea={outline.entity_analysis} t={t} />}
    </div>
  );
}

function attrs(o: any): string {
  if (!o || typeof o !== "object") return "";
  return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(" · ");
}

function EntityAnalysis({ ea, t }: { ea: any; t: any }) {
  const cs = ea.content_strategy;
  const csLists: [string, any][] = cs && typeof cs === "object" ? [
    [t("seoStructAdvantages"), cs.structure_advantages],
    [t("seoEntityAdvantages"), cs.entity_advantages],
    [t("seoStructSuperiority"), cs.structure_superiority],
    [t("seoAuthoritySignals"), cs.authority_signals],
  ] : [];
  const pe = ea.primary_entity;
  const kw = ea.keyword_strategy;
  const kwGroups: [string, any][] = kw ? [[t("seoKwPrimary"), kw.primary], [t("seoKwLsi"), kw.lsi], [t("seoKwLongtail"), kw.long_tail]] : [];
  const lab: React.CSSProperties = { color: "var(--color-text-primary)" };
  return (
    <Block title={t("seoEntityAnalysis")}>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6, width: "100%", display: "flex", flexDirection: "column", gap: "12px" }}>
        {/* Content strategy */}
        {typeof cs === "string" && <div><b style={lab}>{t("seoContentStrategy")}:</b> {cs}</div>}
        {csLists.some(([, v]) => v?.length) && (
          <div>
            <b style={lab}>{t("seoContentStrategy")}</b>
            {csLists.filter(([, v]) => v?.length).map(([label, v], i) => (
              <div key={i} style={{ marginTop: "6px" }}>
                <span style={{ fontWeight: 600, color: "var(--color-text-secondary)" }}>{label}:</span>
                <ul style={{ margin: "2px 0 0", paddingLeft: "16px" }}>{v.map((x: string, j: number) => <li key={j}>{x}</li>)}</ul>
              </div>
            ))}
          </div>
        )}
        {Array.isArray(ea.authority_signals) && ea.authority_signals.length > 0 && <div><b style={lab}>{t("seoAuthoritySignals")}:</b> {ea.authority_signals.join(", ")}</div>}

        {/* Primary entity */}
        {pe?.name && (
          <div style={{ padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "8px" }}>
            <b style={lab}>{t("seoPrimaryEntity")}: {pe.name}</b>
            {attrs(pe.attributes) && <div style={{ marginTop: "3px" }}>{attrs(pe.attributes)}</div>}
            {pe.relationship_triplets?.length > 0 && <div style={{ marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" }}>{pe.relationship_triplets.map((tr: any, j: number) => <span key={j} style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--color-text-tertiary)" }}>{typeof tr === "string" ? tr : `${tr.subject} → ${tr.predicate} → ${tr.object}`}</span>)}</div>}
            {pe.authority_validation && <div style={{ marginTop: "4px" }}><span style={{ fontWeight: 600 }}>{t("seoAuthorityValidation")}:</span> {pe.authority_validation}</div>}
          </div>
        )}

        {/* Supporting entities */}
        {ea.supporting_entities?.length > 0 && (
          <div>
            <b style={lab}>{t("seoSupportingEntities")}</b>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" }}>
              {ea.supporting_entities.map((se: any, i: number) => (
                <div key={i} style={{ padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: "7px" }}>
                  <b style={lab}>{se.name}</b>
                  {attrs(se.attributes) && <div style={{ marginTop: "2px" }}>{attrs(se.attributes)}</div>}
                  {se.relationship_to_primary && <div style={{ marginTop: "2px", fontFamily: "monospace", fontSize: "11px", color: "var(--color-text-tertiary)" }}>{se.relationship_to_primary}</div>}
                  {se.content_integration && <div style={{ marginTop: "2px" }}><span style={{ fontWeight: 600 }}>{t("seoContentIntegration")}:</span> {se.content_integration}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Keyword strategy */}
        {kwGroups.some(([, v]) => v?.length) && (
          <div>
            <b style={lab}>{t("seoKeywordStrategy")}</b>
            {kwGroups.filter(([, v]) => v?.length).map(([label, v], i) => (
              <div key={i} style={{ marginTop: "6px" }}>
                <span style={{ fontWeight: 600, color: "var(--color-text-secondary)" }}>{label}:</span>
                <ul style={{ margin: "2px 0 0", paddingLeft: "16px" }}>
                  {v.map((x: any, j: number) => <li key={j}>{typeof x === "string" ? x : <><b style={lab}>{x.keyword}</b>{x.usage ? ` — ${x.usage}` : ""}</>}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* EAV-driven visual elements */}
        {ea.visual_elements?.length > 0 && (
          <div>
            <b style={lab}>{t("seoEavVisuals")}</b>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" }}>
              {ea.visual_elements.map((v: any, i: number) => (
                <div key={i} style={{ padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: "7px" }}>
                  <b style={lab}>{v.name}</b>
                  {v.purpose && <div style={{ marginTop: "2px" }}><span style={{ fontWeight: 600 }}>{t("seoVisualPurpose")}:</span> {v.purpose}</div>}
                  {v.eav_data && <div><span style={{ fontWeight: 600 }}>{t("seoEavData")}:</span> {v.eav_data}</div>}
                  {v.prompt && <div style={{ marginTop: "2px", fontStyle: "italic" }}><span style={{ fontWeight: 600, fontStyle: "normal" }}>{t("seoVisualPrompt")}:</span> “{v.prompt}”</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Block>
  );
}

// ─── Combined view used by the generator page ────────────────────────────────────
export function OutlineView({ outline, onGenText, genTextLoading }: { outline: any; onGenText?: () => void; genTextLoading?: boolean }) {
  const { t } = useLanguage();
  const meta = outline.meta || {};
  function download() {
    const blob = new Blob([JSON.stringify(outline, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `outline-${(meta.keyword || "seo").replace(/\s+/g, "-")}.json`; a.click();
  }
  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
        <div>
          <h3 style={{ fontSize: "16px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
            <FileText size={18} color="var(--color-accent-purple)" /> {t("seoArticleStructure")}
          </h3>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "4px 0 0", display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {meta.target_word_count ? <span>{t("seoTargetPrefix")} ~{meta.target_word_count} {t("seoWords")}</span> : null}
            {meta.dominant_intent ? <span>{t("seoDominantIntent")}: <b style={{ color: "var(--color-accent-green)" }}>{meta.dominant_intent}</b></span> : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={download} style={btnGhost}><Download size={14} /> JSON</button>
          {onGenText && <button onClick={onGenText} disabled={genTextLoading} style={btnPurple}>{genTextLoading ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} {t("seoGenText")}</button>}
        </div>
      </div>
      <OutlineStructure outline={outline} />
      <OutlineEntities outline={outline} />
    </div>
  );
}

// ─── SERP intent/page-type analysis (deterministic, Landing-flow "Анализ выдачи") ──
export function SerpIntentPanel({ analysis }: { analysis: { dominantIntent: string; pageType: string; share: number; total: number; note: string } | null | undefined }) {
  const { t } = useLanguage();
  if (!analysis) return null;
  return (
    <div className="panel">
      <div className="tool-section-label">{t("seoSerpAnalysisTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginTop: "6px" }}>
        <span>{t("seoDominantIntent")}: <b style={{ color: "var(--color-accent-green)" }}>{analysis.dominantIntent}</b></span>
        <span style={{ color: "var(--color-border)" }}>·</span>
        <span>{t("seoPageType")}: <span className="pill">{analysis.pageType}</span></span>
      </div>
      <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "8px", fontFamily: "monospace" }}>{analysis.note}</div>
    </div>
  );
}

// ─── Landing wireframe (block skeleton) ──────────────────────────────────────────
const BLOCK_COLOR: Record<string, string> = {
  HERO_FORM: "#bf5af2", USP_BAR: "#2997ff", ITEM_CARD_LIST: "#ff9f0a", HOW_IT_WORKS: "#34c759",
  COMPARISON_TABLE: "#ff9f0a", PRICING_TABLE: "#ff9f0a", FEATURE_LIST: "#2997ff", GALLERY: "#bf5af2",
  REVIEWS: "#34c759", TRUST_BADGES: "#34c759", MAP: "#2997ff", FAQ: "#8e8e93", TEXT_BLOCK: "#8e8e93", CTA_BANNER: "#ff453a",
};

// Visual landing wireframe: renders each block as a design-free page mockup — placeholder
// bars, hatched image areas, CTA button stubs and requirement cards (orange, checkable) —
// so the ТЗ reads like a page, not like a JSON list.
const bar = (w: string, dark = false, h = 10): React.CSSProperties => ({
  width: w, height: h, borderRadius: h / 2,
  background: dark ? "var(--color-text-tertiary)" : "var(--color-border)",
  opacity: dark ? 0.9 : 0.9,
});
function ReqCard({ text }: { text: string }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: "8px", background: "var(--color-bg)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "7px" }}>
      <div style={{ fontSize: "10.5px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-accent-orange)", lineHeight: 1.5 }}>{text}</div>
      <div style={bar("72%")} />
      <div style={bar("46%")} />
    </div>
  );
}
export function WireframeView({ wireframe, keyword }: { wireframe: any; keyword?: string }) {
  const { t } = useLanguage();
  const blocks = Array.isArray(wireframe?.blocks) ? wireframe.blocks : [];
  if (!blocks.length) return null;
  function downloadMd() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([wireframeToMarkdown(wireframe, keyword)], { type: "text/markdown" }));
    a.download = `wireframe-${(keyword || "landing").replace(/\s+/g, "-").slice(0, 40)}.md`;
    a.click();
  }
  const BUTTON_BLOCKS = new Set(["HERO_FORM", "CTA_BANNER"]);
  const IMAGE_BLOCKS = new Set(["USP_BAR", "GALLERY", "MAP"]);
  const hatch: React.CSSProperties = {
    height: "110px", borderRadius: "8px", border: "1px solid var(--color-border)",
    background: "repeating-linear-gradient(45deg, var(--color-bg), var(--color-bg) 8px, var(--color-border) 8px, var(--color-border) 9px)",
    opacity: 0.7,
  };
  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px" }}>
        <div>
          <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 4px", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
            <LayoutTemplate size={18} color="var(--color-accent-purple)" /> {t("seoWireframeTitle")}
          </h3>
          <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", margin: "0 0 12px" }}>{t("seoWireframeSub")}</p>
        </div>
        <button onClick={downloadMd} style={{ ...btnGhost, flexShrink: 0 }}><Download size={14} /> MD</button>
      </div>

      {/* The page: one bordered canvas, blocks separated by dashed cut lines */}
      <div style={{ border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden", background: "var(--color-card)" }}>
        {blocks.map((b: any, i: number) => {
          const reqs: string[] = Array.isArray(b.requirements) ? b.requirements : [];
          return (
            <div key={i} style={{ padding: "18px 22px 22px", borderTop: i ? "1px dashed var(--color-border)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", color: "var(--color-text-tertiary)", textTransform: "uppercase" }}>{b.type}</span>
                {b.source_section && <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)", opacity: 0.7 }}>← {b.source_section}</span>}
              </div>
              {b.heading && <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "12px", lineHeight: 1.3 }}>{b.heading}</div>}

              {/* content placeholder bars */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={bar("55%", true, 14)} />
                <div style={bar("82%")} />
                <div style={bar("64%")} />
              </div>

              {/* CTA button stub */}
              {BUTTON_BLOCKS.has(b.type) && (
                <div style={{ marginTop: "14px", width: "120px", height: "34px", borderRadius: "8px", background: "var(--color-accent-orange)", opacity: 0.85 }} />
              )}

              {/* image / media area */}
              {IMAGE_BLOCKS.has(b.type) && <div style={{ ...hatch, marginTop: "14px" }} />}

              {/* requirements as checkable cards */}
              {reqs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "14px" }}>
                  {reqs.map((r: string, j: number) => <ReqCard key={j} text={r} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Landing top-page skeletons: how the ranking pages are actually built ─────────
// Each card redraws a scraped competitor's real structure — heading tree in document order
// plus price-table/FAQ markers — so you can eyeball the block order that ranks before looking
// at the generated wireframe below it.
const HEAD_CHIP: Record<string, React.CSSProperties> = {
  H1: { background: "var(--color-bg)", color: "var(--color-text-secondary)" },
  H2: { background: "rgba(41,151,255,0.12)", color: "var(--color-accent-blue)" },
  H3: { background: "rgba(52,199,89,0.14)", color: "var(--color-accent-green)" },
};
export function CompetitorSkeletons({ competitors }: { competitors: any[] }) {
  const { t } = useLanguage();
  const list = (Array.isArray(competitors) ? competitors : []).filter((c: any) => Array.isArray(c.headings) && c.headings.length);
  if (!list.length) return null;
  return (
    <div className="panel">
      <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 4px", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
        <Globe size={18} color="var(--color-accent-blue)" /> {t("seoLpCompetitorsTitle")}
      </h3>
      <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", margin: "0 0 12px" }}>{t("seoLpCompetitorsSub")}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "10px" }}>
        {list.map((c: any, i: number) => (
          <div key={i} style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "12px 14px", background: "var(--color-bg)", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", flexShrink: 0 }}>#{c.position || i + 1}</span>
              <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-accent-blue)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.domain || c.url}
              </a>
              {!!c.word_count && <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)", flexShrink: 0 }}>{c.word_count} {t("seoWordsShort")}</span>}
              {c.has_price_table && <span style={{ ...badge, background: "rgba(255,159,10,0.14)", color: "var(--color-accent-orange)" }}>{t("seoCompPriceTable")}</span>}
              {c.has_faq && <span style={{ ...badge, background: "var(--color-card)", color: "var(--color-text-secondary)" }}>FAQ</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", maxHeight: "300px", overflowY: "auto", borderTop: "1px solid var(--color-border)", paddingTop: "8px" }}>
              {(c.headings as string[]).map((h: string, j: number) => {
                const m = h.match(/^(H[1-6])\s*:\s*(.*)$/);
                const level = m ? m[1] : "H2";
                const text = (m ? m[2] : h).trim();
                if (!text) return null;
                return (
                  <div key={j} style={{ display: "flex", gap: "6px", alignItems: "flex-start", paddingLeft: (Number(level[1]) - 1) * 10 }}>
                    <span style={{ fontSize: "8.5px", fontWeight: 700, padding: "2px 4px", borderRadius: "4px", flexShrink: 0, marginTop: "1px", ...(HEAD_CHIP[level] || HEAD_CHIP.H3) }}>{level}</span>
                    <span style={{ fontSize: "11px", color: level === "H1" ? "var(--color-text-primary)" : "var(--color-text-secondary)", lineHeight: 1.4, fontWeight: level === "H1" ? 700 : 400 }}>{text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
const badge: React.CSSProperties = { fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: "20px", flexShrink: 0, letterSpacing: "0.03em" };

// ─── Gap report (content analysis) ───────────────────────────────────────────────
export function GapReport({ report }: { report: any }) {
  const { t } = useLanguage();
  return (
    <div className="panel">
      <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 6px", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
        <BarChart3 size={18} color="var(--color-accent-purple)" /> {t("seoGapReport")}
      </h3>
      {report.summary && <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: "16px" }}>{report.summary}</p>}

      {report.prioritized_actions?.length > 0 && (
        <Section title={t("seoPriorityActions")}>
          <ol style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.8 }}>
            {report.prioritized_actions.map((a: string, i: number) => <li key={i}>{a.replace(/^\d+\.\s*/, "")}</li>)}
          </ol>
        </Section>
      )}
      {report.ai_visibility && (
        <Section title={t("seoAiVisibility")}>
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
            {report.ai_visibility.cited_source_types_in_serp?.length > 0 && <div><b style={{ color: "var(--color-text-primary)" }}>{t("seoWhoAiCites")}</b> {report.ai_visibility.cited_source_types_in_serp.join(", ")}</div>}
            {report.ai_visibility.brand_external_presence && <div><b style={{ color: "var(--color-text-primary)" }}>{t("seoBrandPresence")}</b> {report.ai_visibility.brand_external_presence}</div>}
            {report.ai_visibility.main_gap && <div style={{ marginTop: "4px" }}>🎯 <b style={{ color: "var(--color-text-primary)" }}>{t("seoMainGap")}</b> {report.ai_visibility.main_gap} {report.ai_visibility.priority && <Pri p={report.ai_visibility.priority} />}</div>}
          </div>
        </Section>
      )}
      {report.content_gaps?.length > 0 && <Section title={t("seoContentGaps")}>{report.content_gaps.map((g: any, i: number) => <Row key={i} pri={g.priority}><b>{g.type}:</b> {g.item}</Row>)}</Section>}
      {report.extractable_fact_gaps?.length > 0 && (
        <Section title={t("seoFactGaps")}>
          {report.extractable_fact_gaps.map((g: any, i: number) => (
            <Row key={i} pri={g.priority}><b>{g.fact}</b> — {t("seoCompetitorHas")} {g.competitor_has || "—"}; {t("seoYouHave")} {g.target_has || "—"}. {g.fix && <span style={{ color: "var(--color-accent-green)" }}>→ {g.fix}</span>}</Row>
          ))}
        </Section>
      )}
      {report.front_loading?.issue && <Section title={t("seoFrontLoading")}><Row pri={report.front_loading.priority}>{report.front_loading.issue}</Row></Section>}
      {report.quality_issues?.length > 0 && <Section title={t("seoQuality")}>{report.quality_issues.map((q: any, i: number) => <Row key={i} pri={q.priority}>{q.issue}</Row>)}</Section>}
    </div>
  );
}

// ─── shared bits ──────────────────────────────────────────────────────────────
function Triplet({ c }: { c: any }) {
  return (
    <span style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--color-text-tertiary)" }}>
      {c.subject} <span style={{ color: "var(--color-accent-blue)" }}>→ {c.predicate} →</span> {c.object}
      {c.strength != null && <span style={{ color: W_COLOR(c.strength) }}> [{c.strength}]</span>}
    </span>
  );
}
function WeightPill({ name, weight }: { name: string; weight?: number }) {
  return (
    <span style={{ fontSize: "11px", padding: "3px 9px", borderRadius: "20px", background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", display: "inline-flex", alignItems: "center", gap: "5px" }}>
      {name}{weight != null && <b style={{ color: W_COLOR(weight) }}>{weight}</b>}
    </span>
  );
}
function WeightDot({ weight }: { weight: number }) {
  return <span style={{ fontSize: "10px", fontWeight: 700, color: "#fff", background: W_COLOR(weight), borderRadius: "50%", width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{weight}</span>;
}
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "16px" }}>
      <div className="tool-section-label">{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>{children}</div>
    </div>
  );
}
function Pill({ text }: { text: string }) { return <span className="pill">{text}</span>; }
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid var(--color-border)" }}>
      <div className="tool-section-label" style={{ marginBottom: "10px" }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ pri, children }: { pri?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "9px", padding: "8px 0", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
      {pri && <span style={{ marginTop: "2px" }}><Pri p={pri} /></span>}
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
function Pri({ p }: { p: string }) { return <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px", color: PRI[p] || "#888", background: `${PRI[p] || "#888"}1a`, textTransform: "uppercase" }}>{p}</span>; }
