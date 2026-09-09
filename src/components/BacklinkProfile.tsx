"use client";

// Backlink profile: what the provider sees pointing at this site, as opposed to the manual
// list below it, which is what you built yourself. They answer different questions — "did my
// link land and is it still alive" versus "what does my link graph look like" — so this sits
// alongside that list rather than replacing it.
//
// Same contract as everything else in the metrics layer: the stored profile renders for free,
// including one filled entirely by CSV import, and only the refresh button spends anything.
//
// The provider tabs answer "load from where" right here rather than sending you to Settings:
// **All** is the main table — unique domains across every provider, each metric in its own
// column — while the Ahrefs and Majestic tabs show that provider's strict view (its own live/
// lost verdicts, its own history) and refresh from its own key, whatever the active provider
// in Settings is.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Loader2, RefreshCw, TrendingDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  getMetricsCreds, getMetricsMode, estimateCostUsd, formatUsd, type MetricsMode,
} from "@/lib/seo/metricsClient";
import { isGuestView, shareTokenFromPath } from "@/lib/shareParam";
// The pure half of the metrics module — see its header. A client component importing
// `@/lib/seo/metrics` drags the Prisma client into the browser bundle.
import {
  estimateProfileUnits, estimateMajesticProfileUnits, DEFAULT_BASE_URL, gatewayStatusFromError,
  type MetricsProvider, type SubscriptionInfo,
} from "@/lib/seo/metricsPricing";
import { METRICS_GATEWAY_URL } from "@/components/SeoToolsSettings";

/** `{host}` / `{n}` placeholders in locale strings — `t()` returns them verbatim by design. */
const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** Client-side pages of the domain table. The rows are all in memory already; this only keeps
 *  the DOM at a sane size instead of deciding how many domains the user may look at. */
const TABLE_ROWS_PER_PAGE = 100;

type View = "all" | "ahrefs" | "majestic";
/** The two providers this component can read or refresh; Semrush has no backlink API here. */
type BlProvider = "ahrefs" | "majestic";

/** One rendered row, normalized across the three views. */
interface Row {
  refDomain: string;
  /** Ahrefs Domain Rating — populated in the ahrefs and all views. */
  dr: number | null;
  /** Majestic Trust Flow — populated in the majestic and all views. */
  tf: number | null;
  cf: number | null;
  links: number | null;
  dofollow: boolean;
  firstSeen: string;
  topic: string;
  ip: string;
  providers: string[];
  lost: boolean;
  lostAt: string;
  source: "api" | "csv";
}

interface Snapshot { date: string; refDomains: number | null; backlinks: number | null; dofollowPct: number | null }

function drColor(dr: number) {
  if (dr >= 70) return "var(--color-success)";
  if (dr >= 50) return "var(--color-accent-green)";
  if (dr >= 30) return "var(--color-warning)";
  return "var(--color-text-secondary)";
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

const PROVIDER_NAME: Record<MetricsProvider, string> = {
  ahrefs: "Ahrefs", semrush: "Semrush", majestic: "Majestic",
};

/** Everything the source placard needs about where one provider's paid calls go. */
interface SourceCfg {
  provider: MetricsProvider;
  mode: MetricsMode;
  host: string;
  cap: number;
  hasKey: boolean;
}

export default function BacklinkProfile({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  // A client opening a share link sees the profile and cannot refresh it. The server enforces
  // that too — this only keeps a button on screen that would always fail.
  const guest = isGuestView();

  const [view, setView] = useState<View>("all");
  const [rows, setRows] = useState<Row[]>([]);
  const [history, setHistory] = useState<{ ahrefs: Snapshot[]; majestic: Snapshot[] }>({ ahrefs: [], majestic: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<React.ReactNode>("");
  const [showLost, setShowLost] = useState(false);
  const [tablePage, setTablePage] = useState(1);

  // Resolved in an effect, not during render: mode and host live in localStorage, and reading
  // them during the first pass would make the server HTML disagree with the client's.
  const [srcs, setSrcs] = useState<{ ahrefs: SourceCfg | null; majestic: SourceCfg | null }>({ ahrefs: null, majestic: null });
  const [usage, setUsage] = useState<{ ahrefs: number | null; majestic: number | null }>({ ahrefs: null, majestic: null });
  // The provider's own balance — free, cached 10 minutes server-side. Only Ahrefs' gateway
  // exposes one; Majestic's reported figure would be the pooled upstream wallet, so its
  // placard segment deliberately shows our own counter instead.
  const [balance, setBalance] = useState<{ info: SubscriptionInfo | null; gatewayStatus: number | null } | null>(null);

  useEffect(() => {
    if (guest) return;
    const build = (p: MetricsProvider): SourceCfg => {
      const creds = getMetricsCreds(p);
      return {
        provider: p,
        // Same resolution the settings screen uses — a second way of deriving the mode here
        // would be able to disagree with it, and "mode" is exactly what a 401 message names.
        mode: getMetricsMode(p),
        host: creds.baseUrl || DEFAULT_BASE_URL[p],
        cap: creds.cap,
        hasKey: creds.apiKey.length > 4,
      };
    };
    setSrcs({ ahrefs: build("ahrefs"), majestic: build("majestic") });
  }, [guest]);

  const loadBalance = useCallback(async () => {
    const creds = getMetricsCreds("ahrefs");
    if (guest || creds.apiKey.length <= 4) return;
    try {
      const res = await fetch("/api/metrics/subscription", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ahrefs", apiKey: creds.apiKey, baseUrl: creds.baseUrl }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.usage && typeof d.usage.units === "number") {
        setUsage(u => ({ ...u, ahrefs: Number(d.usage.units) }));
      }
      setBalance({
        info: d.info ?? null,
        gatewayStatus: typeof d.gatewayStatus === "number" ? d.gatewayStatus : null,
      });
    } catch { setBalance({ info: null, gatewayStatus: null }); }
  }, [guest]);

  useEffect(() => { loadBalance().catch(() => {}); }, [loadBalance]);

  // Gateway refusals carry different diagnoses: 401 names the wrong key/host pair, 402 an
  // empty wallet, 403 a product the key does not include. Flattening them into one "failed"
  // is what made this screen undiagnosable, so each gets its own sentence.
  const gatewayNotice = useCallback((raw: string, host: string): React.ReactNode => {
    const gw = gatewayStatusFromError(raw);
    return gw === 401 ? fill(t("blsrcErr401"), { host })
      : gw === 402 ? (<>
          {fill(t("blsrcErr402"), { host })}{" "}
          <a href={METRICS_GATEWAY_URL} target="_blank" rel="noreferrer noopener nofollow"
            style={{ color: "var(--color-accent-blue)" }}>{t("blsrcTopUp")}</a>
        </>)
      : gw === 403 ? t("blsrcErr403")
      : gw === 429 ? t("blsrcErr429")
      : gw != null && gw >= 500 ? t("blsrcErr502")
      : null;
  }, [t]);

  const call = useCallback(async (doFetch: boolean) => {
    const credsA = getMetricsCreds("ahrefs");
    const credsM = getMetricsCreds("majestic");
    const body: Record<string, unknown> = { siteId: siteDbId, view, fetch: doFetch };
    const token = shareTokenFromPath();
    if (token) body.shareToken = token;
    if (doFetch) {
      // Both providers travel every time; the route pulls only what the view needs and only
      // what has a key. Per-provider caps ride along — the two units are not comparable.
      body.creds = {
        ahrefs: { apiKey: credsA.apiKey, baseUrl: credsA.baseUrl, cap: credsA.cap },
        majestic: { apiKey: credsM.apiKey, baseUrl: credsM.baseUrl, cap: credsM.cap },
      };
    }

    const res = await fetch("/api/metrics/backlinks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (Array.isArray(d.refDomains)) {
      setRows((d.refDomains as any[]).map(r => ({
        refDomain: String(r.refDomain ?? ""),
        dr: r.dr ?? null,
        tf: r.tf ?? null,
        cf: r.cf ?? null,
        links: r.links ?? r.linksToTarget ?? null,
        dofollow: r.dofollow !== false,
        firstSeen: r.firstSeen ?? "",
        topic: r.topic ?? "",
        ip: r.ip ?? "",
        providers: Array.isArray(r.providers) ? r.providers : r.provider ? [r.provider] : [],
        lost: !!r.lost,
        lostAt: r.lostAt ?? "",
        source: r.source === "csv" ? "csv" : "api",
      })));
    }
    if (d.history && typeof d.history === "object") {
      setHistory({ ahrefs: d.history.ahrefs ?? [], majestic: d.history.majestic ?? [] });
    }
    if (d.usage && typeof d.usage === "object") {
      setUsage({
        ahrefs: d.usage.ahrefs?.units ?? null,
        majestic: d.usage.majestic?.units ?? null,
      });
    }
    if (!res.ok && doFetch) {
      // Per-provider failures first: a merged refresh can fail on one side and succeed on the
      // other, and that difference is the whole diagnosis.
      const errs = d.errors && typeof d.errors === "object" ? Object.entries(d.errors as Record<string, string>) : [];
      const lines = errs.length
        ? errs.map(([p, e]) => `${PROVIDER_NAME[p as MetricsProvider] ?? p}: ${
            e === "cap_exceeded" ? t("kwCapExceeded")
            : e === "provider_unsupported" ? t("blpAhrefsOnly")
            : e === "no_key" ? t("blsrcNoKey")
            : gatewayNotice(e, (getMetricsCreds(p as MetricsProvider).baseUrl || DEFAULT_BASE_URL[p as MetricsProvider])) ?? e}`)
        : [d.error === "cap_exceeded" ? t("kwCapExceeded")
           : d.error === "no_key" ? t("blsrcNoKey")
           : d.error === "provider_unsupported" ? t("blpAhrefsOnly")
           : t("blpFailed")];
      setNotice(<>{lines.map((l, i) => <div key={i}>{l}</div>)}</>);
    } else if (doFetch) {
      // A partial pull cannot prove a link is gone, so it does not mark anything lost. Saying
      // so is the difference between "no losses" and "we did not look" — and when it stopped
      // for a gateway reason, that reason rides along instead of hiding behind "partial".
      const partialProviders = d.errors && typeof d.errors === "object"
        ? Object.entries(d.errors as Record<string, string>) : [];
      const reason = partialProviders.length
        ? partialProviders.map(([p, e]) =>
            `${PROVIDER_NAME[p as MetricsProvider] ?? p}: ${
              gatewayNotice(e, (getMetricsCreds(p as MetricsProvider).baseUrl || DEFAULT_BASE_URL[p as MetricsProvider])) ?? e}`)
        : null;
      setNotice(d.complete === false
        ? <>{t("blpPartial")}{reason ? <> · {reason}</> : null}</>
        : "");
      loadBalance().catch(() => {});
    }
  }, [siteDbId, view, t, loadBalance, gatewayNotice]);

  // Free read of what is stored — never reaches a provider. Re-reads when the tab changes:
  // each view is a different slice of the same stored table.
  useEffect(() => { setTablePage(1); call(false).catch(() => {}); }, [call]);

  async function refresh() {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await call(true); } catch { setNotice(t("blpFailed")); }
    setBusy(false);
  }

  const live = useMemo(() => rows.filter(r => !r.lost), [rows]);
  const lost = useMemo(() => rows.filter(r => r.lost), [rows]);

  // Which providers this view reads and refreshes from.
  const viewProviders: BlProvider[] = view === "all" ? ["ahrefs", "majestic"] : [view];
  const refreshable: BlProvider[] = viewProviders.filter(p => srcs[p]?.hasKey);
  const anyKey = refreshable.length > 0;

  const histFor = (p: BlProvider) => history[p === "majestic" ? "majestic" : "ahrefs"] ?? [];
  const latest = histFor(view === "majestic" ? "majestic" : "ahrefs").slice(-1)[0];
  const previous = histFor(view === "majestic" ? "majestic" : "ahrefs")[0];

  // Priced from each provider's last pull's real domain count — the same figure the server
  // reserves when it refreshes. Before the first pull there is no count to price from, and
  // that provider's part of the chip hides rather than guessing. Units stay per provider:
  // Ahrefs units and Majestic units are different currencies that only their prices translate.
  const estimate = useMemo(() => {
    const parts: { p: BlProvider; units: number }[] = [];
    let usd = 0;
    for (const p of refreshable) {
      const rd = histFor(p).slice(-1)[0]?.refDomains ?? null;
      if (rd == null) continue;
      const units = p === "majestic" ? estimateMajesticProfileUnits(rd) : estimateProfileUnits(rd);
      parts.push({ p, units });
      usd += estimateCostUsd(units, p);
    }
    return parts.length ? { parts, usd } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, refreshable.length, history]);

  const chip = (label: string, value: string, hint?: string) => (
    <div key={label} title={hint} style={{ padding: "10px 14px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)", minWidth: "104px" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)" }}>{value}</div>
    </div>
  );

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = { ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" };
  const thC = { ...th, textAlign: "center" as const };
  const numCell = (v: number | null, color?: string) => (
    <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: v != null ? (color ?? "var(--color-text-primary)") : "var(--color-text-secondary)" }}>
      {v != null ? Math.round(v) : "—"}
    </td>
  );

  const visible = showLost ? lost : live;
  const tablePages = Math.max(1, Math.ceil(visible.length / TABLE_ROWS_PER_PAGE));
  const pageNo = Math.min(tablePage, tablePages);
  const pageRows = visible.slice((pageNo - 1) * TABLE_ROWS_PER_PAGE, pageNo * TABLE_ROWS_PER_PAGE);

  // ── Source placard values, per provider ──
  const info = balance?.info ?? null;
  const balLimit = info?.unitsLimitApiKey ?? info?.unitsLimitWorkspace ?? null;
  const balUsed = info?.unitsUsageApiKey ?? info?.unitsUsageWorkspace ?? null;
  const remaining = balLimit != null && balUsed != null ? Math.max(0, balLimit - balUsed) : null;
  const updated = info
    ? new Date(info.fetchedAt).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  const expDate = info?.apiKeyExpirationDate ?? "";
  const expSoon = !!expDate && new Date(expDate).getTime() - Date.now() < 7 * 86_400_000;
  const modeLabel = (m: MetricsMode) => m === "official" ? t("blsrcHostOfficial")
    : m === "reseller" ? t("blsrcHostReseller") : t("blsrcHostCustom");

  /** One provider's segment of the source placard. */
  const placard = (p: BlProvider, withBalance: boolean) => {
    const src = srcs[p];
    if (!src) return null;
    const unitsLeft = src.cap > 0 ? Math.max(0, src.cap - (usage[p] ?? 0)) : usage[p];
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        <span>{withBalance ? `${PROVIDER_NAME[p]}: ` : ""}<strong style={{ color: "var(--color-text-primary)" }}>
          {p === "ahrefs" ? "Ahrefs API v3" : "Majestic API"}
        </strong></span>
        <code style={{ fontFamily: "monospace", fontSize: "11px" }}>{src.host.replace(/^https?:\/\//, "")}</code>
        <span className="metric-chip" style={{ fontWeight: 500 }}>{modeLabel(src.mode)}</span>
        {src.hasKey ? (
          p === "ahrefs" && remaining != null && balLimit != null
            ? <span>{t("blsrcRemaining")} <strong style={{ color: "var(--color-text-primary)" }}>{remaining.toLocaleString()}</strong> {t("blsrcOf")} {balLimit.toLocaleString()}</span>
            : <span>
                {t("blsrcBalanceUnknown")}
                {unitsLeft != null && <> · {fill(t("blsrcUnitsLeft"), { n: unitsLeft.toLocaleString() })}</>}
              </span>
        ) : (
          <span style={{ color: "var(--color-text-tertiary)" }}>{t("blsrcNoKey")}</span>
        )}
        {p === "ahrefs" && info && updated && <span>{t("blsrcUpdated")} {updated}</span>}
        {p === "ahrefs" && info?.usageResetDate && <span>{t("blsrcResetAt")} {info.usageResetDate}</span>}
        {p === "ahrefs" && expDate && <span style={expSoon ? { color: "var(--color-warning)" } : undefined}>
          {t("blsrcKeyExpires")} {expDate}
        </span>}
        {p === "ahrefs" && expSoon && <span style={{ color: "var(--color-warning)" }}>{t("blsrcKeyExpiringSoon")}</span>}
      </span>
    );
  };

  // Column plan per view. TF/CF are Majestic's metrics and only light up on its rows; IP and
  // topic are what a PBN check actually sorts by, so they earn their width on this screen.
  const showDr = view !== "majestic";
  const showTf = view !== "ahrefs";
  const showExtras = view !== "ahrefs";

  return (
    <div className="panel" style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
        <Link2 size={17} color="var(--color-accent-blue)" />
        <h3 className="title-sm" style={{ margin: 0 }}>{t("blpTitle")}</h3>

        {!guest && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {estimate != null && (
            <span className="metric-cost">
              {estimate.parts.map(({ p, units }) => `${PROVIDER_NAME[p]} ${units.toLocaleString()}`).join(" + ")}
              {" "}· ≈ {formatUsd(estimate.usd)}
            </span>
          )}
          <button className="metric-action" onClick={refresh} disabled={busy || !anyKey}
            title={!anyKey ? t("blpNoKey") : undefined}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {busy ? t("blpLoading") : view === "all" && refreshable.length > 1 ? t("blpRefreshBoth") : t("blpRefresh")}
          </button>
        </div>}
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("blpSub")}</p>

      {/* Provider tabs — "load from where" lives here, not only in Settings. All is the merged
          main table; the provider tabs show that source's own view and refresh its own key. */}
      {!guest && (
        <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
          {(["all", "ahrefs", "majestic"] as const).map(v => (
            <button key={v} className={view === v ? "pill active" : "pill"}
              onClick={() => setView(v)} style={{ cursor: "pointer" }}>
              {v === "all" ? t("blpTabAll") : PROVIDER_NAME[v]}
              {v !== "all" && srcs[v] && !srcs[v]!.hasKey && (
                <span style={{ opacity: 0.55, marginLeft: "4px" }}>·</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Source placard — always visible for the owner: whose keys, which hosts, what is left. */}
      {!guest && srcs.ahrefs && (
        <div style={{ display: "flex", alignItems: "center", gap: "4px 14px", flexWrap: "wrap", marginBottom: "14px", padding: "8px 12px", fontSize: "12px", color: "var(--color-text-secondary)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
          {viewProviders.map(p => placard(p, viewProviders.length > 1))}
          <a href="/settings?tab=metrics" style={{ marginLeft: "auto", color: "var(--color-accent-blue)", textDecoration: "none", whiteSpace: "nowrap" }}>{t("blsrcConfigure")}</a>
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: "12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{notice}</div>
      )}

      {rows.length === 0 ? (
        <div style={{ padding: "28px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {t("blpEmpty")}
        </div>
      ) : (
        <>
          <div className="privacy-blur-all" style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
            {view === "all" ? (
              <>
                {chip(t("blpUnique"), String(live.length))}
                {histFor("ahrefs").slice(-1)[0]?.refDomains != null &&
                  chip("Ahrefs · RD", fmt(histFor("ahrefs").slice(-1)[0]!.refDomains))}
                {histFor("majestic").slice(-1)[0]?.refDomains != null &&
                  chip("Majestic · RD", fmt(histFor("majestic").slice(-1)[0]!.refDomains))}
                {lost.length > 0 && chip(t("blpLost"), String(lost.length))}
              </>
            ) : (
              <>
                {chip(t("blpRefDomains"), fmt(latest?.refDomains ?? live.length))}
                {chip(t("blpBacklinks"), fmt(latest?.backlinks))}
                {chip(t("blpDofollow"), latest?.dofollowPct != null ? `${latest.dofollowPct}%` : "—", t("blpDofollowHint"))}
                {/* Only meaningful once two pulls exist; before that the honest answer is nothing. */}
                {previous?.refDomains != null && latest?.refDomains != null &&
                  chip(t("blpChange"), `${latest.refDomains - previous.refDomains >= 0 ? "+" : ""}${latest.refDomains - previous.refDomains}`, t("blpChangeHint"))}
                {lost.length > 0 && chip(t("blpLost"), String(lost.length))}
              </>
            )}
          </div>

          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            {([[false, `${t("blpLive")} (${live.length})`], [true, `${t("blpLost")} (${lost.length})`]] as const).map(([v, label]) => (
              <button key={String(v)} className={showLost === v ? "pill active" : "pill"}
                onClick={() => setShowLost(v)} style={{ cursor: "pointer", border: "1px solid transparent" }}>{label}</button>
            ))}
          </div>

          <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
            <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                  <th style={th}>{t("blpDomain")}</th>
                  {showDr && <th style={thC}>DR</th>}
                  {showTf && <th style={thC}>TF</th>}
                  {showExtras && <th style={thC}>CF</th>}
                  <th style={thC}>{t("blpLinks")}</th>
                  {showExtras && <th style={th}>{t("blpTopic")}</th>}
                  {showExtras && <th style={th}>IP</th>}
                  <th style={th}>{showLost ? t("blpLostAt") : t("blpFirstSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(r => (
                  <tr key={r.refDomain} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={cell}>
                      <a href={`https://${r.refDomain}`} target="_blank" rel="noreferrer noopener nofollow"
                        style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>{r.refDomain}</a>
                      {/* Provenance: which index has seen this donor. Only the merged view can
                          show two. */}
                      {view === "all" && (
                        <span className="metric-chip" style={{ marginLeft: "6px", fontWeight: 500 }} title={r.providers.join(", ")}>
                          {r.providers.map(p => p === "ahrefs" ? "A" : "M").join("+")}
                        </span>
                      )}
                      {r.dofollow === false && (
                        <span className="metric-chip" style={{ marginLeft: "6px", fontWeight: 500 }}>nofollow</span>
                      )}
                    </td>
                    {showDr && numCell(r.dr, r.dr != null ? drColor(r.dr) : undefined)}
                    {showTf && numCell(r.tf, r.tf != null ? drColor(r.tf) : undefined)}
                    {showExtras && numCell(r.cf)}
                    <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{r.links ?? "—"}</td>
                    {showExtras && <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "12px", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.topic}>
                      {r.topic || "—"}
                    </td>}
                    {showExtras && <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "12px", fontFamily: "monospace" }}>
                      {r.ip || "—"}
                    </td>}
                    <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "12px" }}>
                      {showLost ? (r.lostAt || "—") : (r.firstSeen ? r.firstSeen.slice(0, 10) : "—")}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={9} style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)", padding: "24px" }}>
                    {showLost ? <><TrendingDown size={14} style={{ verticalAlign: "-2px", marginRight: "6px" }} />{t("blpNoLost")}</> : t("blpEmpty")}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {tablePages > 1 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", paddingTop: "10px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              <button className="pill" disabled={pageNo <= 1} onClick={() => setTablePage(pageNo - 1)}
                style={{ cursor: pageNo <= 1 ? "default" : "pointer", opacity: pageNo <= 1 ? 0.5 : 1 }}>‹</button>
              <span>{t("bluiPage")} {pageNo} {t("bluiOf")} {tablePages}</span>
              <button className="pill" disabled={pageNo >= tablePages} onClick={() => setTablePage(pageNo + 1)}
                style={{ cursor: pageNo >= tablePages ? "default" : "pointer", opacity: pageNo >= tablePages ? 0.5 : 1 }}>›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
