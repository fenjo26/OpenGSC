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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Link2, Loader2, RefreshCw, TrendingDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  getMetricsCreds, getMetricsMode, getMetricsProvider, estimateCostUsd, formatUsd, type MetricsMode,
} from "@/lib/seo/metricsClient";
import { isGuestView, shareTokenFromPath } from "@/lib/shareParam";
// The pure half of the metrics module — see its header. A client component importing
// `@/lib/seo/metrics` drags the Prisma client into the browser bundle.
import {
  estimateProfileUnits, estimateMajesticProfileUnits, estimateSemrushProfileUnits, estimateKeyssoProfileUnits,
  estimateDataforseoProfileUnits, formatProviderUnits, metersInDollars,
  DATAFORSEO_HISTORY_UNITS, DATAFORSEO_NEWLOST_UNITS,
  DEFAULT_BASE_URL, gatewayStatusFromError,
  type MetricsProvider, type SubscriptionInfo,
} from "@/lib/seo/metricsPricing";
import { METRICS_GATEWAY_URL } from "@/components/SeoToolsSettings";
import ToxicityTab from "@/components/backlinks/ToxicityTab";
import DisavowTab from "@/components/backlinks/DisavowTab";
import RecoveryTab from "@/components/backlinks/RecoveryTab";

/** `{host}` / `{n}` placeholders in locale strings — `t()` returns them verbatim by design. */
const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** Client-side pages of the domain table. The rows are all in memory already; this only keeps
 *  the DOM at a sane size instead of deciding how many domains the user may look at. */
const TABLE_ROWS_PER_PAGE = 100;

type View = "all" | "ahrefs" | "majestic" | "semrush" | "keysso" | "dataforseo";
/** The providers this component can read or refresh — one tab each, plus the merged view. */
type BlProvider = MetricsProvider;
/** N2 sections inside the profile: the provider view plus toxicity/disavow/recovery.
 *  Site context only — a drops-catalogue domain has no SiteBacklink rows to classify. */
type Section = "profile" | "toxicity" | "disavow" | "recovery";

/** One rendered row, normalized across the three views. */
interface Row {
  refDomain: string;
  /** Ahrefs Domain Rating — populated in the ahrefs and all views. */
  dr: number | null;
  /** Majestic Trust Flow — populated in the majestic and all views. */
  tf: number | null;
  /** Semrush Authority Score — populated in the semrush and all views. */
  as: number | null;
  /** Keys.so DR — Yandex/Runet index, a different scale from Ahrefs DR; never merged into it. */
  ks: number | null;
  /** DataForSEO rank, 0–100 — its own index and scale; never merged into Ahrefs DR. */
  dfs: number | null;
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

/** DataForSEO's extras for the site, as /api/metrics/backlinks returns them (a free local read). */
interface DfsExtras {
  rank: number | null;
  spamScore: number | null;
  brokenBacklinks: number | null;
  refMainDomains: number | null;
  checkedAt: string | null;
  newLost: { points: Array<{ date: string; newBacklinks: number; lostBacklinks: number; newRefDomains: number; lostRefDomains: number }>; checkedAt: string } | null;
  historyPoints: number;
}

function drColor(dr: number) {
  if (dr >= 70) return "var(--color-success)";
  if (dr >= 50) return "var(--color-accent-green)";
  if (dr >= 30) return "var(--color-warning)";
  return "var(--color-text-secondary)";
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

const PROVIDER_NAME: Record<MetricsProvider, string> = {
  ahrefs: "Ahrefs", semrush: "Semrush", majestic: "Majestic", keysso: "Keys.so", dataforseo: "DataForSEO",
};

const NO_PROVIDER = { ahrefs: null, majestic: null, semrush: null, keysso: null, dataforseo: null };
const NO_HISTORY = { ahrefs: [], majestic: [], semrush: [], keysso: [], dataforseo: [] };

/** Everything the source placard needs about where one provider's paid calls go. */
interface SourceCfg {
  provider: MetricsProvider;
  mode: MetricsMode;
  host: string;
  cap: number;
  hasKey: boolean;
}

/**
 * `siteDbId` renders the dashboard flow: target = the signed-in user's site row.
 * `dropDomain` renders the /drops flow: target = a domain from the caller's own drops
 * catalogue (the route re-verifies ownership — the prop only names the request shape).
 */
export default function BacklinkProfile({ siteDbId, dropDomain }: { siteDbId?: string; dropDomain?: string }) {
  const { t } = useLanguage();
  // A client opening a share link sees the profile and cannot refresh it. The server enforces
  // that too — this only keeps a button on screen that would always fail.
  const guest = isGuestView();

  const [view, setView] = useState<View>("all");
  // N2 sections. "profile" keeps the exact behaviour this component always had; the other
  // three render their own tab component below and skip the provider view entirely.
  const [section, setSection] = useState<Section>("profile");
  const [rows, setRows] = useState<Row[]>([]);
  const [history, setHistory] = useState<Record<BlProvider, Snapshot[]>>(NO_HISTORY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<React.ReactNode>("");
  const [showLost, setShowLost] = useState(false);
  const [tablePage, setTablePage] = useState(1);

  // Resolved in an effect, not during render: mode and host live in localStorage, and reading
  // them during the first pass would make the server HTML disagree with the client's.
  const [srcs, setSrcs] = useState<Record<BlProvider, SourceCfg | null>>(NO_PROVIDER);
  const [usage, setUsage] = useState<Record<BlProvider, number | null>>(NO_PROVIDER);
  // The provider's own balance — free, cached 10 minutes server-side. Only Ahrefs' gateway
  // exposes one; Majestic's reported figure would be the pooled upstream wallet, so its
  // placard segment deliberately shows our own counter instead.
  const [balance, setBalance] = useState<{ info: SubscriptionInfo | null; gatewayStatus: number | null } | null>(null);
  // Keys.so's gateway reports a bare remaining figure (free `/limits/all`) — no limit/usage
  // pair — so it gets its own slot rather than being squeezed into the Ahrefs shape.
  const [ksBalance, setKsBalance] = useState<{ remaining: number | null; gatewayStatus: number | null } | null>(null);
  // DataForSEO's free user_data: the account balance in micro-dollar units, or the refusal code.
  const [dfsBalance, setDfsBalance] = useState<{ remaining: number | null; gatewayStatus: number | null } | null>(null);
  const [dfsExtras, setDfsExtras] = useState<DfsExtras | null>(null);
  const [dfsBusy, setDfsBusy] = useState<"" | "history" | "newlost">("");
  // The DataForSEO credential is shared with SERP and keyword demand, so holding it does NOT
  // mean "pull my backlinks from DataForSEO too". The merged view's refresh includes DataForSEO
  // only once the user chose it as the metrics provider or already has a DataForSEO profile —
  // otherwise "Refresh all" would start spending on an account that was bought for SERP checks.
  // Its own tab always refreshes from it: opening that tab is the choice. A ref, not state, so
  // `call` (whose identity drives the load effect) does not change when history arrives.
  const [dfsActive, setDfsActive] = useState(false);
  const dfsInAll = useRef(false);

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
    setSrcs({ ahrefs: build("ahrefs"), majestic: build("majestic"), semrush: build("semrush"), keysso: build("keysso"), dataforseo: build("dataforseo") });
    setDfsActive(getMetricsProvider() === "dataforseo");
  }, [guest]);

  const loadBalance = useCallback(async () => {
    if (guest) return;
    const ks = getMetricsCreds("keysso");
    if (ks.apiKey.length > 4) {
      fetch("/api/metrics/subscription", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "keysso", apiKey: ks.apiKey, baseUrl: ks.baseUrl }),
      })
        .then(r => r.json())
        .then(d => setKsBalance({
          remaining: typeof d.info?.unitsRemaining === "number" ? d.info.unitsRemaining : null,
          gatewayStatus: typeof d.gatewayStatus === "number" ? d.gatewayStatus : null,
        }))
        .catch(() => setKsBalance({ remaining: null, gatewayStatus: null }));
    }
    const dfs = getMetricsCreds("dataforseo");
    if (dfs.apiKey.length > 4) {
      fetch("/api/metrics/subscription", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "dataforseo", apiKey: dfs.apiKey }),
      })
        .then(r => r.json())
        .then(d => setDfsBalance({
          remaining: typeof d.info?.unitsRemaining === "number" ? d.info.unitsRemaining : null,
          gatewayStatus: typeof d.gatewayStatus === "number" ? d.gatewayStatus : null,
        }))
        .catch(() => setDfsBalance({ remaining: null, gatewayStatus: null }));
    }
    const creds = getMetricsCreds("ahrefs");
    if (creds.apiKey.length <= 4) return;
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
    // DataForSEO is its own account, not a GroupBuySEO wallet: its refusals get its own words
    // and its own top-up link (403 = the Backlinks API is not enabled on that account).
    if (/^dataforseo /.test(String(raw ?? ""))) {
      return gw === 401 ? t("metricsDfsBadKey")
        : gw === 402 ? (<>
            {t("blsrcDfsNoFunds")}{" "}
            <a href="https://app.dataforseo.com/" target="_blank" rel="noreferrer noopener nofollow"
              style={{ color: "var(--color-accent-blue)" }}>{t("blsrcTopUp")}</a>
          </>)
        : gw === 403 ? t("blsrcDfsNoAccess")
        : gw === 429 ? t("blsrcErr429")
        : gw != null && gw >= 500 ? t("blsrcErr502")
        : null;
    }
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
    const credsS = getMetricsCreds("semrush");
    const credsK = getMetricsCreds("keysso");
    const credsD = getMetricsCreds("dataforseo");
    const body: Record<string, unknown> = dropDomain ? { dropDomain } : { siteId: siteDbId, view, fetch: doFetch };
    if (dropDomain) { body.view = view; body.fetch = doFetch; }
    const token = shareTokenFromPath();
    if (token) body.shareToken = token;
    if (doFetch) {
      // Both providers travel every time; the route pulls only what the view needs and only
      // what has a key. Per-provider caps ride along — the two units are not comparable.
      body.creds = {
        ahrefs: { apiKey: credsA.apiKey, baseUrl: credsA.baseUrl, cap: credsA.cap },
        majestic: { apiKey: credsM.apiKey, baseUrl: credsM.baseUrl, cap: credsM.cap },
        semrush: { apiKey: credsS.apiKey, baseUrl: credsS.baseUrl, cap: credsS.cap },
        keysso: { apiKey: credsK.apiKey, baseUrl: credsK.baseUrl, cap: credsK.cap },
        ...(view === "dataforseo" || dfsInAll.current
          ? { dataforseo: { apiKey: credsD.apiKey, baseUrl: credsD.baseUrl, cap: credsD.cap } }
          : {}),
      };
    }

    const res = await fetch("/api/metrics/backlinks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (Array.isArray(d.refDomains)) {
      // The merged view answers with per-provider columns already split (dr/tf/as); a
      // single-provider view answers with that provider's number in the generic `dr` slot,
      // so the column it belongs to follows from the view.
      setRows((d.refDomains as any[]).map(r => {
        const merged = Array.isArray(r.providers);
        const prov: BlProvider = merged ? "ahrefs" : (r.provider ?? view);
        return {
          refDomain: String(r.refDomain ?? ""),
          dr: merged ? (r.dr ?? null) : view === "ahrefs" ? (r.dr ?? null) : null,
          tf: merged ? (r.tf ?? null) : view === "majestic" ? (r.dr ?? null) : null,
          as: merged ? (r.as ?? null) : view === "semrush" ? (r.dr ?? null) : null,
          ks: merged ? (r.ks ?? null) : view === "keysso" ? (r.dr ?? null) : null,
          dfs: merged ? (r.dfs ?? null) : view === "dataforseo" ? (r.dr ?? null) : null,
          cf: r.cf ?? null,
          links: r.links ?? r.linksToTarget ?? null,
          dofollow: r.dofollow !== false,
          firstSeen: r.firstSeen ?? "",
          topic: r.topic ?? "",
          ip: r.ip ?? "",
          providers: merged ? r.providers : [prov],
          lost: !!r.lost,
          lostAt: r.lostAt ?? "",
          source: r.source === "csv" ? "csv" : "api",
        };
      }));
    }
    if (d.history && typeof d.history === "object") {
      setHistory({ ahrefs: d.history.ahrefs ?? [], majestic: d.history.majestic ?? [], semrush: d.history.semrush ?? [], keysso: d.history.keysso ?? [], dataforseo: d.history.dataforseo ?? [] });
    }
    if (d.dataforseo && typeof d.dataforseo === "object") setDfsExtras(d.dataforseo as DfsExtras);
    if (d.usage && typeof d.usage === "object") {
      setUsage({
        ahrefs: d.usage.ahrefs?.units ?? null,
        majestic: d.usage.majestic?.units ?? null,
        semrush: d.usage.semrush?.units ?? null,
        keysso: d.usage.keysso?.units ?? null,
        dataforseo: d.usage.dataforseo?.units ?? null,
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
      // A pull that ended far short of the provider's own count is a sample, and "filtered
      // result" (the generic partial text) would be the wrong explanation for it.
      const sampled = d.perProvider && typeof d.perProvider === "object"
        ? (Object.values(d.perProvider as Record<string, { shortfall?: { pulled: number; total: number } }>)
            .find(v => v?.shortfall)?.shortfall ?? null)
        : null;
      setNotice(sampled
        ? <>{fill(t("blpShortfall"), { pulled: String(sampled.pulled), total: String(sampled.total) })}{reason ? <> · {reason}</> : null}</>
        : d.complete === false
          ? <>{t("blpPartial")}{reason ? <> · {reason}</> : null}</>
          : "");
      loadBalance().catch(() => {});
    }
  }, [dropDomain, siteDbId, view, t, loadBalance, gatewayNotice]);

  // Free read of what is stored — never reaches a provider. Re-reads when the tab changes:
  // each view is a different slice of the same stored table.
  useEffect(() => { setTablePage(1); call(false).catch(() => {}); }, [call]);

  // The two one-request DataForSEO extras: twelve months of history into the snapshot series,
  // and weekly new/lost. Explicit buttons with their price on them — never on page load.
  async function runDfsOp(op: "history" | "newlost") {
    if (!siteDbId || dfsBusy) return;
    setDfsBusy(op); setNotice("");
    try {
      const c = getMetricsCreds("dataforseo");
      const res = await fetch("/api/metrics/backlinks/dataforseo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, op, apiKey: c.apiKey, cap: c.cap }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.dataforseo) setDfsExtras(d.dataforseo as DfsExtras);
      if (d.usage && typeof d.usage.units === "number") setUsage(u => ({ ...u, dataforseo: Number(d.usage.units) }));
      if (!res.ok) {
        const e = String(d.error ?? "");
        setNotice(e === "cap_exceeded" ? t("kwCapExceeded")
          : e === "no_key" ? t("blsrcNoKey")
          : gatewayNotice(e, DEFAULT_BASE_URL.dataforseo) ?? (e || t("blpFailed")));
      } else if (op === "history") {
        setNotice(fill(t("blpDfsHistoryDone"), { n: String(d.result?.written ?? 0) }));
        await call(false);
      }
    } catch { setNotice(t("blpFailed")); }
    setDfsBusy("");
  }

  async function refresh() {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await call(true); } catch { setNotice(t("blpFailed")); }
    setBusy(false);
  }

  const live = useMemo(() => rows.filter(r => !r.lost), [rows]);
  useEffect(() => {
    dfsInAll.current = dfsActive || (history.dataforseo?.length ?? 0) > 0;
  }, [dfsActive, history]);
  const lost = useMemo(() => rows.filter(r => r.lost), [rows]);

  // Which providers this view reads and refreshes from.
  const dfsOptedIn = dfsActive || (history.dataforseo?.length ?? 0) > 0;
  const viewProviders: BlProvider[] = view === "all"
    ? (["ahrefs", "majestic", "semrush", "keysso", "dataforseo"] as BlProvider[]).filter(p => p !== "dataforseo" || dfsOptedIn)
    : [view];
  const refreshable: BlProvider[] = viewProviders.filter(p => srcs[p]?.hasKey);
  const anyKey = refreshable.length > 0;

  // Each provider's own snapshots. (Semrush used to read Ahrefs' history here — a provider tab
  // showing another index's totals is exactly the mix-up the per-provider tabs exist to avoid.)
  const histFor = (p: BlProvider) => history[p] ?? [];
  const latest = histFor(view === "all" ? "ahrefs" : view).slice(-1)[0];
  const previous = histFor(view === "all" ? "ahrefs" : view)[0];

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
      const units = p === "majestic" ? estimateMajesticProfileUnits(rd)
        : p === "semrush" ? estimateSemrushProfileUnits(rd)
        : p === "keysso" ? estimateKeyssoProfileUnits(rd)
        : p === "dataforseo" ? estimateDataforseoProfileUnits(rd)
        : estimateProfileUnits(rd);
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
    const used = usage[p] ?? 0;
    // With a monthly cap the honest figure is what remains of it. Without one there is no
    // "left" to speak of — the raw counter is what was SPENT, and labelling it "left" turned
    // 3 595 spent units into a phantom balance.
    const unitsLeft = src.cap > 0 ? Math.max(0, src.cap - used) : null;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        <span>{withBalance ? `${PROVIDER_NAME[p]}: ` : ""}<strong style={{ color: "var(--color-text-primary)" }}>
          {p === "ahrefs" ? "Ahrefs API v3" : p === "majestic" ? "Majestic API" : p === "keysso" ? "Keys.so API" : p === "dataforseo" ? "DataForSEO Backlinks API" : "Semrush API"}
        </strong></span>
        {p === "keysso" && <span className="metric-chip" style={{ fontWeight: 500 }} title={t("blpKsMarketHint")}>{t("blpKsMarket")}</span>}
        <code style={{ fontFamily: "monospace", fontSize: "11px" }}>{src.host.replace(/^https?:\/\//, "")}</code>
        <span className="metric-chip" style={{ fontWeight: 500 }}>{modeLabel(src.mode)}</span>
        {src.hasKey ? (
          p === "keysso" && ksBalance?.gatewayStatus === 402
            ? <span style={{ color: "var(--color-warning)" }}>{t("blsrcKsOutOfCredits")}{" "}
                <a href={METRICS_GATEWAY_URL} target="_blank" rel="noreferrer noopener nofollow" style={{ color: "var(--color-accent-blue)" }}>{t("blsrcTopUp")}</a></span>
          : p === "dataforseo" && dfsBalance?.gatewayStatus != null && [401, 402, 403].includes(dfsBalance.gatewayStatus)
            ? <span style={{ color: "var(--color-warning)" }}>
                {dfsBalance.gatewayStatus === 401 ? t("metricsDfsBadKey") : dfsBalance.gatewayStatus === 402 ? t("blsrcDfsNoFunds") : t("blsrcDfsNoAccess")}{" "}
                {dfsBalance.gatewayStatus !== 401 && <a href="https://app.dataforseo.com/" target="_blank" rel="noreferrer noopener nofollow" style={{ color: "var(--color-accent-blue)" }}>{t("blsrcTopUp")}</a>}
              </span>
          : p === "dataforseo" && dfsBalance?.remaining != null
            ? <span>{t("blsrcDfsBalance")} <strong style={{ color: "var(--color-text-primary)" }}>{formatProviderUnits(dfsBalance.remaining, "dataforseo")}</strong>
                {used > 0 && <> · {t("metricsUsage")}: <strong style={{ color: "var(--color-text-primary)" }}>{formatProviderUnits(used, "dataforseo")}</strong></>}
              </span>
          : p === "keysso" && ksBalance?.remaining != null
            ? <span>{t("blsrcRemaining")} <strong style={{ color: "var(--color-text-primary)" }}>{ksBalance.remaining.toLocaleString()}</strong> {t("blsrcKsCredits")}</span>
          : p === "ahrefs" && remaining != null && balLimit != null
            ? <span>{t("blsrcRemaining")} <strong style={{ color: "var(--color-text-primary)" }}>{remaining.toLocaleString()}</strong> {t("blsrcOf")} {balLimit.toLocaleString()}</span>
            : <span>
                {t("blsrcBalanceUnknown")}
                {unitsLeft != null
                  ? <> · {fill(t("blsrcUnitsLeft"), { n: formatProviderUnits(unitsLeft, p) })}</>
                  : used > 0 && <> · {t("metricsUsage")}: <strong style={{ color: "var(--color-text-primary)" }}>{formatProviderUnits(used, p)}</strong>{metersInDollars(p) ? "" : ` ${t("metricsUnits")}`}</>}
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

  // Column plan per view. Each provider's authority metric keeps its own column — DR, TF, AS —
  // because they are different scales wearing similar ranges; CF, topic and IP are the
  // Majestic/PBN extras (IP also fills on Semrush rows when the report carries it).
  const showDr = view === "ahrefs" || view === "all";
  const showTf = view === "majestic" || view === "all";
  const showAs = view === "semrush" || view === "all";
  // Keys.so's column only appears in the merged table once a Keys.so pull exists — most
  // profiles are Google-market and an always-empty Yandex column would be noise.
  const showKs = view === "keysso" || (view === "all" && rows.some(r => r.ks != null));
  // Same rule for DataForSEO's rank: its own column, shown once a DataForSEO pull exists.
  const showDfs = view === "dataforseo" || (view === "all" && rows.some(r => r.dfs != null));
  const showCf = view === "majestic";
  // Keys.so rows carry no topic and no per-donor IP (its `ips` is a count), so no empty columns.
  const showExtras = view !== "ahrefs" && view !== "keysso" && view !== "dataforseo";

  return (
    <div className="panel" style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
        <Link2 size={17} color="var(--color-accent-blue)" />
        <h3 className="title-sm" style={{ margin: 0 }}>{t("blpTitle")}</h3>

        {!guest && section === "profile" && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {estimate != null && (
            <span className="metric-cost">
              {estimate.parts.map(({ p, units }) => `${PROVIDER_NAME[p]} ${formatProviderUnits(units, p)}`).join(" + ")}
              {" "}· ≈ {formatUsd(estimate.usd)}
            </span>
          )}
          <button className="metric-action" onClick={refresh} disabled={busy || !anyKey}
            title={!anyKey ? t("blpNoKey") : undefined}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {busy ? t("blpLoading") : view === "all" && refreshable.length > 1 ? t("blpRefreshAll") : t("blpRefresh")}
          </button>
        </div>}
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("blpSub")}</p>

      {/* N2 section tabs — the site's own profile only. The share (guest) view keeps
          toxicity and recovery read-only and gets no disavow tab: that file is the
          operator's decision, not client-report material. */}
      {siteDbId && (
        <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
          {(["profile", "toxicity", "disavow", "recovery"] as const)
            .filter((s) => !guest || s !== "disavow")
            .map((s) => (
              <button key={s} className={section === s ? "pill active" : "pill"}
                onClick={() => setSection(s)} style={{ cursor: "pointer" }}>
                {s === "profile" ? t("blTabProfile" as never) : t(`blTab${s[0].toUpperCase()}${s.slice(1)}` as never)}
              </button>
            ))}
        </div>
      )}

      {siteDbId && section !== "profile" ? (
        section === "toxicity" ? (
          <ToxicityTab siteDbId={siteDbId} guest={guest} />
        ) : section === "recovery" ? (
          <RecoveryTab siteDbId={siteDbId} guest={guest} />
        ) : (
          <DisavowTab siteDbId={siteDbId} />
        )
      ) : (
        <>
      {/* Provider tabs — "load from where" lives here, not only in Settings. All is the merged
          main table; the provider tabs show that source's own view and refresh its own key. */}
      {!guest && (
        <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
          {(["all", "ahrefs", "majestic", "semrush", "keysso", "dataforseo"] as const).map(v => (
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

      {/* DataForSEO's own extras — rank, spam score, broken links — plus the two one-request
          reports. Only on its tab: they are DataForSEO's figures and say so by where they live. */}
      {!guest && view === "dataforseo" && (
        <div className="privacy-blur-all" style={{ marginBottom: "14px" }}>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" }}>
            {dfsExtras?.rank != null && chip(t("blpDfsRank"), String(Math.round(dfsExtras.rank)), t("blpDfsRankHint"))}
            {dfsExtras?.spamScore != null && chip(t("blpDfsSpam"), String(Math.round(dfsExtras.spamScore)), t("blpDfsSpamHint"))}
            {dfsExtras?.brokenBacklinks != null && chip(t("blpDfsBroken"), fmt(dfsExtras.brokenBacklinks))}
            {siteDbId && srcs.dataforseo?.hasKey && (
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
                <button className="metric-action" onClick={() => { void runDfsOp("history"); }} disabled={!!dfsBusy}
                  title={t("blpDfsHistoryHint")}>
                  {dfsBusy === "history" ? <Loader2 size={13} className="spin" /> : <History size={13} />}
                  {t("blpDfsHistory")} · ≈ {formatProviderUnits(DATAFORSEO_HISTORY_UNITS, "dataforseo")}
                </button>
                <button className="metric-action" onClick={() => { void runDfsOp("newlost"); }} disabled={!!dfsBusy}
                  title={t("blpDfsNewLostHint")}>
                  {dfsBusy === "newlost" ? <Loader2 size={13} className="spin" /> : <TrendingDown size={13} />}
                  {t("blpDfsNewLost")} · ≈ {formatProviderUnits(DATAFORSEO_NEWLOST_UNITS, "dataforseo")}
                </button>
              </span>
            )}
          </div>
          {dfsExtras?.newLost && dfsExtras.newLost.points.length > 0 && (
            <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                    <th style={th}>{t("blpDfsWeek")}</th>
                    <th style={thC}>{t("blpDfsNewLinks")}</th>
                    <th style={thC}>{t("blpDfsLostLinks")}</th>
                    <th style={thC}>{t("blpDfsNewDomains")}</th>
                    <th style={thC}>{t("blpDfsLostDomains")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...dfsExtras.newLost.points].reverse().map(pt => (
                    <tr key={pt.date} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td style={{ ...cell, fontSize: "12px", color: "var(--color-text-secondary)" }}>{pt.date}</td>
                      <td style={{ ...cell, textAlign: "center", color: pt.newBacklinks ? "var(--color-success)" : "var(--color-text-secondary)" }}>{pt.newBacklinks ? `+${pt.newBacklinks}` : "0"}</td>
                      <td style={{ ...cell, textAlign: "center", color: pt.lostBacklinks ? "var(--color-warning)" : "var(--color-text-secondary)" }}>{pt.lostBacklinks ? `−${pt.lostBacklinks}` : "0"}</td>
                      <td style={{ ...cell, textAlign: "center", color: pt.newRefDomains ? "var(--color-success)" : "var(--color-text-secondary)" }}>{pt.newRefDomains ? `+${pt.newRefDomains}` : "0"}</td>
                      <td style={{ ...cell, textAlign: "center", color: pt.lostRefDomains ? "var(--color-warning)" : "var(--color-text-secondary)" }}>{pt.lostRefDomains ? `−${pt.lostRefDomains}` : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: "6px 12px", fontSize: "11px", color: "var(--color-text-tertiary)" }}>
                {t("blpDfsNewLostHint")} · {new Date(dfsExtras.newLost.checkedAt).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          )}
        </div>
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
                {histFor("keysso").slice(-1)[0]?.refDomains != null &&
                  chip("Keys.so · RD", fmt(histFor("keysso").slice(-1)[0]!.refDomains), t("blpKsMarketHint"))}
                {histFor("dataforseo").slice(-1)[0]?.refDomains != null &&
                  chip("DataForSEO · RD", fmt(histFor("dataforseo").slice(-1)[0]!.refDomains))}
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
                  {showAs && <th style={thC}>AS</th>}
                  {showKs && <th style={thC} title={t("blpKsDrHint")}>DR·KS</th>}
                  {showDfs && <th style={thC} title={t("blpDfsRankHint")}>Rank·DFS</th>}
                  {showCf && <th style={thC}>CF</th>}
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
                          {r.providers.map(x => x === "ahrefs" ? "A" : x === "majestic" ? "M" : x === "keysso" ? "K" : x === "dataforseo" ? "D" : "S").join("+")}
                        </span>
                      )}
                      {r.dofollow === false && (
                        <span className="metric-chip" style={{ marginLeft: "6px", fontWeight: 500 }}>nofollow</span>
                      )}
                    </td>
                    {showDr && numCell(r.dr, r.dr != null ? drColor(r.dr) : undefined)}
                    {showTf && numCell(r.tf, r.tf != null ? drColor(r.tf) : undefined)}
                    {showAs && numCell(r.as, r.as != null ? drColor(r.as) : undefined)}
                    {showKs && numCell(r.ks, r.ks != null ? drColor(r.ks) : undefined)}
                    {showDfs && numCell(r.dfs, r.dfs != null ? drColor(r.dfs) : undefined)}
                    {showCf && numCell(r.cf)}
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
                  <tr><td colSpan={10} style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)", padding: "24px" }}>
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
        </>
      )}
    </div>
  );
}
