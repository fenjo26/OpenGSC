"use client";

// «Export all backlinks» — the button for POST /api/backlinks/sync.
//
// It exports from the provider selected in Settings → SEO Metrics (issue #26 follow-up): Ahrefs,
// DataForSEO or Keys.so, named on the button and in the quote. It used to be hard-wired to
// Ahrefs, so a user who had switched to DataForSEO was quoted an Ahrefs export ($3.33) for a
// profile DataForSEO would export for a few cents. Semrush and Majestic have no per-link export
// here; with either selected the button stays on Ahrefs and says so.
//
// That route fills SiteBacklink, the per-link inventory (anchors, donor DR, snippets) the Toxicity
// module classifies. Nothing in the UI called it, so a site with an Ahrefs key and no CSV had an
// empty toxicity report with no way to fill it. This is that way.
//
// The route is a two-step contract and this component keeps to it: a POST without `confirm`
// answers with the price and spends only the one stats call that priced it; the export starts
// only when the same request comes back with `confirm: true` after the user has seen the figure.
// The run is fire-and-forget on the server, so progress is read from GET /api/backlinks/sync, and
// a run that was already going when the page opened is picked up rather than started twice.

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { formatUsd, getMetricsCreds, getMetricsProvider } from "@/lib/seo/metricsClient";
import {
  AHREFS_UNIT_FLOOR, DATAFORSEO_REQUEST_UNITS, DATAFORSEO_ROW_UNITS, formatProviderUnits, gatewayStatusFromError,
} from "@/lib/seo/metricsPricing";

interface Estimate { rows: number; pages: number; units: number; usd: number; paginationMode?: string | null }

/** The providers /api/backlinks/sync can export from. */
type ExportProvider = "ahrefs" | "dataforseo" | "keysso";
const EXPORT_LABEL: Record<ExportProvider, string> = { ahrefs: "Ahrefs", dataforseo: "DataForSEO", keysso: "Keys.so" };

/** The selected metrics provider, or Ahrefs when the selected one has no per-link export. */
function exportProvider(): ExportProvider {
  const p = getMetricsProvider();
  return p === "dataforseo" || p === "keysso" ? p : "ahrefs";
}
interface Run {
  id: string; status: string; rowsSeen?: number; pagesPulled?: number; unitsSpent?: number;
  complete?: boolean; error?: string | null;
}
type Phase = "idle" | "quoting" | "confirm" | "starting" | "running";

const POLL_MS = 3000;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));

export default function BacklinkSyncButton({
  siteDbId, onFinished, compact,
}: {
  siteDbId: string;
  /** Called once a run has ended, after toxicity was recalculated — the parent reloads its data. */
  onFinished?: () => void;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const [phase, setPhase] = useState<Phase>("idle");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Read after mount (localStorage), so the server HTML and the first client pass agree.
  const [provider, setProvider] = useState<ExportProvider>("ahrefs");
  useEffect(() => {
    const id = setTimeout(() => setProvider(exportProvider()), 0);
    return () => clearTimeout(id);
  }, []);
  const label = EXPORT_LABEL[provider];

  /** A spend in the provider's own currency: dollars for DataForSEO, credits/units otherwise. */
  const costText = useCallback((p: ExportProvider, units: number, usd?: number) =>
    p === "dataforseo" ? `≈ ${formatProviderUnits(units, "dataforseo")}`
      : `${units.toLocaleString()} ${p === "keysso" ? t("blsrcKsCredits") : t("metricsUnits")}${usd != null ? ` · ≈ ${formatUsd(usd)}` : ""}`,
  [t]);
  /** What the pricing read itself cost — the figure the quote note names. */
  const priceReadCost = (p: ExportProvider) =>
    p === "dataforseo" ? formatProviderUnits(DATAFORSEO_REQUEST_UNITS + DATAFORSEO_ROW_UNITS, "dataforseo")
      : p === "keysso" ? `1 ${t("blsrcKsCredits")}`
      : `${AHREFS_UNIT_FLOOR} ${t("metricsUnits")}`;
  const onFinishedRef = useRef(onFinished);
  useEffect(() => { onFinishedRef.current = onFinished; }, [onFinished]);

  const stopPolling = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const errorText = useCallback((status: number, code: unknown): string => {
    const c = String(code ?? "");
    if (c === "no_key") return fill(t("blsyncErrNoKey"), { provider: label });
    // Provider refusals carry their own diagnosis — said in that provider's words.
    const gw = gatewayStatusFromError(c);
    if (/^dataforseo /.test(c) && gw != null) {
      if (gw === 401) return t("metricsDfsBadKey");
      if (gw === 402) return t("blsrcDfsNoFunds");
      if (gw === 403) return t("blsrcDfsNoAccess");
    }
    if (/^keysso /.test(c) && gw === 402) return t("blsrcKsOutOfCredits");
    if (/^keysso /.test(c) && gw === 401) return t("metricsKeyssoBadKey");
    if (c === "cap_exceeded") return t("blsyncErrCap");
    if (c === "provider_unsupported") return t("blsyncErrSemrush");
    if (c === "already_running") return t("blsyncAlreadyRunning");
    return c ? `${t("blsyncFailed")}: ${c.slice(0, 200)}` : `${t("blsyncFailed")} (${status})`;
  }, [t, label]);

  const post = useCallback(async (confirm: boolean) => {
    // Resolved at click time too: Settings may have changed in another tab since mount.
    const p = exportProvider();
    setProvider(p);
    const c = getMetricsCreds(p);
    const res = await fetch("/api/backlinks/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteId: siteDbId, confirm, provider: p,
        // Browser-held key first, like every /api/metrics call; empty falls back to the server mirror.
        apiKey: c.apiKey || undefined, baseUrl: c.baseUrl || undefined, cap: c.cap || undefined,
      }),
    });
    const d = await res.json().catch(() => ({}));
    return { res, d };
  }, [siteDbId]);

  const finish = useCallback(async (r: Run) => {
    stopPolling();
    setPhase("idle");
    setRun(null);
    if (r.status !== "completed") {
      setMessage({ kind: "err", text: `${t("blsyncFailed")}${r.error ? `: ${r.error}` : ""}` });
    } else {
      // Toxicity is local math over the rows that just arrived — free, so it runs now instead of
      // leaving the operator with a full inventory and a report that still says zero donors.
      try {
        await fetch("/api/backlinks/toxicity/run", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: siteDbId }),
        });
      } catch { /* the hourly scheduler recalculates anyway */ }
      const p = exportProvider();
      const spent = p === "dataforseo"
        ? fill(t("blsyncSpent"), { cost: formatProviderUnits(r.unitsSpent ?? 0, "dataforseo") })
        : `${(r.unitsSpent ?? 0).toLocaleString()} ${t("blsyncUnits")}`;
      const counts = `${EXPORT_LABEL[p]} · ${(r.rowsSeen ?? 0).toLocaleString()} ${t("blsyncRows")} · ${r.pagesPulled ?? 0} ${t("blsyncPages")} · ${spent}`;
      setMessage(r.complete === false
        ? { kind: "warn", text: `${t("blsyncPartial")} ${t("blsyncPartialHint")} ${counts}` }
        : { kind: "ok", text: `${t("blsyncDone")} · ${counts}` });
    }
    onFinishedRef.current?.();
  }, [siteDbId, stopPolling, t]);

  const poll = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/backlinks/sync?siteId=${encodeURIComponent(siteDbId)}`, { cache: "no-store" });
      const d = await res.json().catch(() => ({}));
      const r: Run | undefined = (d.runs as Run[] | undefined)?.find(x => x.id === runId);
      if (!r) return; // not visible yet; the next tick will see it
      if (r.status === "running") { setRun(r); return; }
      await finish(r);
    } catch { /* a dropped poll is not a failed run — the server keeps going */ }
  }, [siteDbId, finish]);

  const startPolling = useCallback((runId: string) => {
    stopPolling();
    setPhase("running");
    timer.current = setInterval(() => { void poll(runId); }, POLL_MS);
    void poll(runId);
  }, [poll, stopPolling]);

  // Pick up a run that is already going (page reload, second tab). Deferred one tick: the repo's
  // lint rule rejects a fetch-then-setState helper called straight from an effect body. Keyed on
  // the site alone — `startPolling` changes identity with the language, and re-asking the server
  // on every render would be a request storm.
  const startPollingRef = useRef(startPolling);
  useEffect(() => { startPollingRef.current = startPolling; }, [startPolling]);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/backlinks/sync?siteId=${encodeURIComponent(siteDbId)}`, { cache: "no-store" });
        const d = await res.json().catch(() => ({}));
        const live = (d.runs as Run[] | undefined)?.find(x => x.status === "running");
        if (live && !cancelled) { setRun(live); startPollingRef.current(live.id); }
      } catch { /* nothing to resume */ }
    }, 0);
    return () => { cancelled = true; clearTimeout(id); };
  }, [siteDbId]);

  const quote = async () => {
    if (phase !== "idle") return;
    setMessage(null);
    setPhase("quoting");
    try {
      const { res, d } = await post(false);
      if (res.ok && d.confirmRequired && d.estimate) {
        setEstimate(d.estimate as Estimate);
        setPhase("confirm");
      } else {
        setMessage({ kind: "err", text: errorText(res.status, d.error) });
        setPhase("idle");
      }
    } catch {
      setMessage({ kind: "err", text: t("blsyncFailed") });
      setPhase("idle");
    }
  };

  const start = async () => {
    if (phase !== "confirm") return;
    setPhase("starting");
    try {
      const { res, d } = await post(true);
      if (res.ok && d.id) { setEstimate(null); startPolling(String(d.id)); return; }
      // A run that is already live is not an error to the user: attach to it.
      if (res.status === 409 && d.id) {
        setEstimate(null);
        setMessage({ kind: "warn", text: t("blsyncAlreadyRunning") });
        startPolling(String(d.id));
        return;
      }
      setEstimate(null);
      setMessage({ kind: "err", text: errorText(res.status, d.error) });
      setPhase("idle");
    } catch {
      setEstimate(null);
      setMessage({ kind: "err", text: t("blsyncFailed") });
      setPhase("idle");
    }
  };

  const cancel = () => { if (phase === "confirm") { setPhase("idle"); setEstimate(null); } };

  const busy = phase === "quoting" || phase === "starting" || phase === "running";
  const palette = {
    ok: "#4ADE80", warn: "var(--color-warning, #f59e0b)", err: "#F87171",
  } as const;

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: "6px", alignItems: "flex-start", maxWidth: "100%" }}>
      <button
        onClick={() => { void quote(); }}
        disabled={busy}
        title={fill(t("blsyncHint"), { provider: label })}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          padding: compact ? "5px 12px" : "7px 13px", borderRadius: compact ? "6px" : "8px",
          border: compact ? "1px solid rgba(59,130,246,0.35)" : "none",
          background: compact ? "transparent" : "#6366F1", color: compact ? "#60a5fa" : "#fff",
          fontSize: compact ? "11px" : "12px", fontWeight: 600,
          cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
        {phase === "quoting" ? t("blsyncChecking")
          : phase === "running" || phase === "starting"
            ? `${t("blsyncRunning")}${run?.rowsSeen ? ` ${run.rowsSeen.toLocaleString()} ${t("blsyncRows")}` : ""}`
            : `${t("blsyncStart")} · ${label}`}
      </button>

      {message && (
        <div style={{ fontSize: "11px", lineHeight: 1.5, color: palette[message.kind], maxWidth: "460px" }}>{message.text}</div>
      )}

      {phase === "confirm" && estimate && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={cancel}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "20px", width: "90%", maxWidth: "460px", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", position: "relative", display: "flex", flexDirection: "column", gap: "12px" }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={cancel} aria-label={t("blsyncCancel")}
              style={{ position: "absolute", top: "14px", right: "14px", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}>
              <X size={18} />
            </button>
            <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("blsyncTitle")}</h3>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>
              {fill(t("blsyncEstimate"), {
                provider: label,
                rows: estimate.rows.toLocaleString(),
                cost: costText(provider, estimate.units, estimate.usd),
              })}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
              {fill(t("blsyncQuoteNote"), { cost: priceReadCost(provider) })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button onClick={cancel}
                style={{ padding: "7px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                {t("blsyncCancel")}
              </button>
              <button onClick={() => { void start(); }}
                style={{ padding: "7px 14px", borderRadius: "8px", border: "none", background: "#6366F1", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                {t("blsyncConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
