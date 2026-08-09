"use client";

// "What is about to run this, and where do I change it?" — the SEO Tools header answers both.
//
// The setting was never hidden: Settings → SEO Tools has a global provider/model and a per-task
// override. But a tool page said nothing about which level had won, so a user who had set a
// per-task model and saw different output could not tell whether the setting failed to save or
// was being overridden — the only way to find out was to re-derive a three-deep fallback chain
// by hand. And some pages ran a task nobody had told them about: Links runs on `analysis`, the
// GEO audit's second pass runs on `utility`.
//
// So the header resolves exactly what the request will resolve (lib/seo/keys.ts), for every task
// the current page runs (lib/seo/aiTasks.ts), and says where each value came from. Expanding it
// is the explanation; the button itself is the short answer.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal, ChevronDown, ArrowRight } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { AI_PROVIDER_NAMES, resolveTaskCreds, type CredOrigin, type ResolvedTaskCreds } from "@/lib/seo/keys";
import { tasksForPath, type AiTaskDef } from "@/lib/seo/aiTasks";

type Row = { task: AiTaskDef; creds: ResolvedTaskCreds };

// Which settings row the value came from, in the user's words. `provider` and `default` both
// mean "nothing chosen for SEO specifically", but they differ in whether a model id is being
// sent at all, and that distinction matters when debugging an unexpected answer.
const ORIGIN_KEY: Record<CredOrigin, string> = {
  task: "seoOriginTask",
  seo: "seoOriginSeo",
  global: "seoOriginGlobal",
  provider: "seoOriginProvider",
  default: "seoOriginDefault",
};

export default function AiModelBadge({ pathname }: { pathname: string }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // localStorage is unavailable during SSR, so this resolves after mount. Until then the badge
  // renders as the plain settings link it replaces rather than flashing a wrong model name.
  useEffect(() => {
    const tasks = tasksForPath(pathname);
    setRows(tasks.length ? tasks.map(task => ({ task, creds: resolveTaskCreds(task.id) })) : null);
    setOpen(false);
  }, [pathname]);

  const onDocClick = useCallback((e: MouseEvent) => {
    if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, onDocClick]);

  const goSettings = () => router.push("/settings?tab=seo-tools");

  // Pages with no AI task of their own (Citations, Googlebot, Demand, History…) keep the plain
  // settings link — inventing a model name for them would be worse than saying nothing.
  if (!rows) {
    return (
      <button onClick={goSettings} style={btnStyle(false)}>
        <SlidersHorizontal size={13} /> {t("seoTabSettings")}
      </button>
    );
  }

  const primary = rows[0];
  const missingKey = rows.some(r => !r.creds.apiKey);
  const summary = !primary.creds.apiKey
    ? t("seoModelBadgeNoKey")
    : `${providerName(primary.creds.provider)} · ${primary.creds.model || t("seoModelBadgeProviderDefault")}`;

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} title={t("seoModelBadgeHint")} style={btnStyle(missingKey)}>
        <SlidersHorizontal size={13} style={{ flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{summary}</span>
        {rows.length > 1 && (
          <span style={{ flexShrink: 0, opacity: 0.7, fontWeight: 700 }}>+{rows.length - 1}</span>
        )}
        <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 40, width: "340px",
          background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: "12px", boxSizing: "border-box",
        }}>
          <div style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>
            {t("seoModelBadgePanelTitle")}
          </div>

          {rows.map(({ task, creds }) => (
            <div key={task.id} style={{ padding: "8px 0", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ fontSize: "12.5px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t(task.labelKey as never)}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5, margin: "2px 0 5px" }}>
                {t(task.descKey as never)}
              </div>
              {creds.apiKey ? (
                <div style={{ display: "flex", alignItems: "baseline", gap: "6px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {providerName(creds.provider)}
                  </span>
                  <span style={{ fontSize: "12px", fontFamily: "monospace", color: "var(--color-accent-purple)" }}>
                    {creds.model || t("seoModelBadgeProviderDefault")}
                  </span>
                  <span style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)" }}>
                    {t(ORIGIN_KEY[creds.modelFrom] as never)}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#F59E0B" }}>{t("seoModelBadgeNoKey")}</div>
              )}
            </div>
          ))}

          <button onClick={goSettings} style={{
            marginTop: "10px", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
            padding: "8px", borderRadius: "8px", border: "1px solid var(--color-border)",
            background: "transparent", color: "var(--color-accent-blue)", fontSize: "12px", fontWeight: 600, cursor: "pointer",
          }}>
            {t("seoModelBadgeConfigure")} <ArrowRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function providerName(id: string): string {
  return AI_PROVIDER_NAMES[id] ?? id;
}

function btnStyle(warn: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
    border: `1px solid ${warn ? "rgba(245,158,11,0.4)" : "var(--color-border)"}`,
    background: warn ? "rgba(245,158,11,0.08)" : "var(--color-card)",
    color: warn ? "#F59E0B" : "var(--color-text-secondary)",
    fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
    maxWidth: "340px", overflow: "hidden",
  };
}
