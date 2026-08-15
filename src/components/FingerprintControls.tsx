"use client";

// Shared generation controls fed by the AI-fingerprint model: a temperature field and a toggle that
// injects the model's marker vocabulary as banned words.
//
// Extracted into one component so Outline, Text and any future generator expose the same two
// controls with the same defaults and the same safeguards. Both default to OFF/empty — this ships
// into a product with live users, and neither option should silently change the output of a run
// someone already relies on.
//
// Usage: read `payload()` at submit time and spread it into the job payload.

import { useEffect, useMemo, useState } from "react";
import { Fingerprint, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { suggestBannedCandidates } from "@/lib/seo/aidetect";
import { getActiveModel, getExcluded, setExcluded, effectiveBannedWords, type StoredModel } from "@/lib/seo/aidetectStore";

export interface FingerprintSettings {
  temperature?: number;
  bannedWords?: string[];
}

// Above this the output starts drifting toward incoherence; well above it, into nonsense. The field
// stays free-form — the useful value is model-specific and the bench is how you find it — but a
// number in the danger zone should never be entered without seeing a warning first.
export const TEMP_WARN = 1.2;
export const TEMP_DANGER = 1.5;

export function useFingerprintControls() {
  const [fp, setFp] = useState<StoredModel | null>(null);
  const [useBanned, setUseBanned] = useState(false);
  const [temp, setTemp] = useState("");
  const [excluded, setExcl] = useState<string[]>([]);

  useEffect(() => {
    const m = getActiveModel();
    setFp(m);
    if (m) setExcl(getExcluded(m.name));
  }, []);

  const toggleWord = (w: string) => {
    if (!fp) return;
    const next = excluded.includes(w) ? excluded.filter(x => x !== w) : [...excluded, w];
    setExcl(next);
    setExcluded(fp.name, next);
  };

  const payload = (): FingerprintSettings => ({
    temperature: temp.trim() === "" || isNaN(Number(temp)) ? undefined : Number(temp),
    bannedWords: useBanned && fp ? effectiveBannedWords(fp) : undefined,
  });

  return { fp, useBanned, setUseBanned, temp, setTemp, excluded, toggleWord, payload };
}

export function FingerprintControls(
  p: ReturnType<typeof useFingerprintControls> & {
    /** Set on the outline step, whose caller caps temperature at 0.8 — say so instead of letting
     *  the user type 1.4 and wonder why nothing changed. */
    clampedTo?: number;
  },
) {
  const { fp, useBanned, setUseBanned, temp, setTemp, excluded, toggleWord, clampedTo } = p;
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  const candidates = useMemo(() => (fp ? suggestBannedCandidates(fp.model, 60) : []), [fp]);
  const activeCount = candidates.filter(c => !excluded.includes(c.token)).length;

  const tempNum = Number(temp);
  const tempLevel = temp.trim() === "" || isNaN(tempNum) ? null
    : tempNum >= TEMP_DANGER ? "danger" : tempNum >= TEMP_WARN ? "warn" : null;

  const inputStyle: React.CSSProperties = {
    padding: "7px 10px", borderRadius: "8px",
    border: `1px solid ${tempLevel ? (tempLevel === "danger" ? "#ff375f" : "#ff9f0a") : "var(--color-border)"}`,
    background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px",
    outline: "none", boxSizing: "border-box", width: "92px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center" }}>
        <label
          title={fp ? t("rwBannedHint" as never) : t("hmNoModelHint" as never)}
          style={{
            display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px",
            cursor: fp ? "pointer" : "default", opacity: fp ? 1 : 0.5,
            color: useBanned && fp ? "#ff6482" : "var(--color-text-secondary)",
          }}
        >
          <input type="checkbox" disabled={!fp} checked={useBanned && !!fp}
            onChange={e => setUseBanned(e.target.checked)} style={{ accentColor: "#ff6482" }} />
          <Fingerprint size={14} /> {t("rwBanned" as never)}{fp ? ` · ${fp.name}` : ""}
        </label>

        {useBanned && fp && (
          <button type="button" onClick={() => setOpen(o => !o)}
            style={{ display: "inline-flex", alignItems: "center", gap: "5px", background: "none", border: "none", cursor: "pointer", color: "var(--color-accent-blue)", fontSize: "12px", fontWeight: 600, padding: 0 }}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {t("fpReview" as never)} ({activeCount})
          </button>
        )}

        <label title={t("rwTempHint" as never)} style={{ display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("rwTemp" as never)}
          <input value={temp} onChange={e => setTemp(e.target.value)} placeholder={t("rwTempAuto" as never)} style={inputStyle} />
        </label>
      </div>

      {/* Both hints below used to live only in a `title` attribute. A control that is greyed out
          with no visible reason reads as broken, and a free-form number field with no stated range
          reads as a mystery — neither is discoverable by hovering. */}
      {!fp && (
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
          {t("hmNoModelHint" as never)}{" "}
          <a href="/seo-tools/humanize" style={{ color: "var(--color-accent-blue)", fontWeight: 600, textDecoration: "none" }}>
            {t("fpOpenLab" as never)}
          </a>
        </div>
      )}

      <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
        {t("rwTempHint" as never)}
        {clampedTo ? ` ${t("fpTempClamped" as never).replace("{max}", String(clampedTo))}` : ""}
      </div>

      {tempLevel && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: tempLevel === "danger" ? "#ff375f" : "#ff9f0a" }}>
          <AlertTriangle size={13} />
          {t((tempLevel === "danger" ? "fpTempDanger" : "fpTempWarn") as never)}
        </div>
      )}

      {/* Review panel. This list goes verbatim into a generation prompt, so it is inspectable and
          editable before it can affect a single article — click a word to keep it allowed. */}
      {open && useBanned && fp && (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "12px 14px", background: "var(--color-bg)", display: "flex", flexDirection: "column", gap: "9px" }}>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("fpReviewHint" as never)}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {candidates.map(c => {
              const off = excluded.includes(c.token);
              return (
                <button key={c.token} type="button" onClick={() => toggleWord(c.token)}
                  title={`${t("fpWeight" as never)} ${c.weight.toFixed(2)} · ${t("fpInCompetitors" as never)} ${Math.round(c.humanDf * 100)}%`}
                  style={{
                    fontSize: "11px", fontWeight: 600, padding: "3px 9px", borderRadius: "20px", cursor: "pointer",
                    border: "none", textDecoration: off ? "line-through" : "none",
                    color: off ? "var(--color-text-tertiary)" : "#ff6482",
                    background: off ? "rgba(142,142,147,0.15)" : "rgba(255,100,130,0.14)",
                  }}>
                  {c.token}
                </button>
              );
            })}
            {!candidates.length && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("fpNoCandidates" as never)}</span>}
          </div>
          {!fp.model.humanDf && (
            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "11px", color: "#ff9f0a" }}>
              <AlertTriangle size={12} /> {t("fpRetrainForFilter" as never)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
