"use client";

// The toolbar that owns every paid keyword fetch in the app.
//
// It is a single component on purpose: it is the only place where money is spent on keyword
// data, so the cost estimate, the KD toggle and the cap message can only be right or wrong in
// one place. A second copy would eventually disagree with the server's own pricing.
//
// Styling comes entirely from the shared primitives in globals.css (.tool-input, .tool-section-label,
// .metric-action, .metric-cost) — nothing here re-declares padding, radius or font size.

import { Download, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES } from "@/lib/seo/regions";
import { getMetricsCreds, priceKeywordLoad, formatUsd } from "@/lib/seo/metricsClient";
import type { UseKeywordWeights } from "@/lib/seo/useKeywordWeights";

export default function KeywordWeightsBar({
  w, country, setCountry, compact = false,
}: {
  w: UseKeywordWeights;
  /** Only for views where one market applies to the whole list; omit when rows carry their own. */
  country?: string;
  setCountry?: (v: string) => void;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const provider = getMetricsCreds().provider;
  const { units, usd } = priceKeywordLoad(w.missing, w.withKd, provider);
  const blocked = w.busy || !w.hasKey || w.missing === 0;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
      padding: compact ? "10px 0" : "12px 28px",
      ...(compact ? {} : { borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" }),
    }}>
      <span className="tool-section-label" style={{ marginBottom: 0 }}>{t("kwWeights")}</span>

      <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
        {w.covered}/{w.total} {t("kwCovered")}
      </span>

      {country != null && setCountry && (
        // Search volume is a per-market number. Leaving the market implicit is how a US figure
        // ends up displayed against a German keyword — confidently wrong rather than missing.
        <select className="tool-input inline" value={country} onChange={e => setCountry(e.target.value)}>
          {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}
        title={t("kwWithKdHint")}>
        <input type="checkbox" checked={w.withKd} onChange={e => w.setWithKd(e.target.checked)} />
        {t("kwWithKd")}
      </label>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        {/* Shown before the click, never after: the point is to make the decision, not to
            report the damage. */}
        {w.hasKey && w.missing > 0 && (
          <span className="metric-cost">
            {w.missing} {t("kwKeywords")} · {units.toLocaleString()} {t("metricsUnits")} · ≈ {formatUsd(usd)}
          </span>
        )}
        {w.notice && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{w.notice}</span>}
        {/* Shown when there is no key: the button is dead in that state, and pointing at the
            free import here is more useful than a disabled control with a tooltip. */}
        {!w.hasKey && (
          <a href="/settings?tab=metrics" style={{ fontSize: "11px", color: "var(--color-accent-blue)", textDecoration: "none", whiteSpace: "nowrap" }}>
            {t("importHintNearWeights")}
          </a>
        )}
        <button
          className="metric-action"
          onClick={() => w.load()}
          disabled={blocked}
          title={!w.hasKey ? t("kwNoKey") : w.missing === 0 ? t("kwFromCache") : undefined}
        >
          {w.busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
          {w.busy ? t("kwLoading") : w.covered > 0 ? t("kwRefresh") : t("kwLoad")}
        </button>
      </div>
    </div>
  );
}
