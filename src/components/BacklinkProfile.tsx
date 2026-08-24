"use client";

// Backlink profile: what the provider sees pointing at this site, as opposed to the manual
// list below it, which is what you built yourself. They answer different questions — "did my
// link land and is it still alive" versus "what does my link graph look like" — so this sits
// alongside that list rather than replacing it.
//
// Same contract as everything else in the metrics layer: the stored profile renders for free,
// including one filled entirely by CSV import, and only the refresh button spends anything.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Loader2, RefreshCw, TrendingDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  getMetricsCreds, getMetricsMode, estimateCostUsd, formatUsd, type MetricsMode,
} from "@/lib/seo/metricsClient";
import { isGuestView, shareTokenFromPath } from "@/lib/shareParam";
import {
  estimateProfileUnits, DEFAULT_BASE_URL, gatewayStatusFromError, type SubscriptionInfo,
} from "@/lib/seo/metrics";
import { METRICS_GATEWAY_URL } from "@/components/SeoToolsSettings";

/** `{host}` / `{n}` placeholders in locale strings — `t()` returns them verbatim by design. */
const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** Client-side pages of the domain table. The rows are all in memory already; this only keeps
 *  the DOM at a sane size instead of deciding how many domains the user may look at. */
const TABLE_ROWS_PER_PAGE = 100;

interface RefDomain {
  refDomain: string;
  dr: number | null;
  linksToTarget: number | null;
  dofollow: boolean;
  firstSeen: string;
  lost: boolean;
  lostAt: string;
  source: "api" | "csv";
  fetchedAt: string;
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

/** Everything the source placard needs about where paid calls go, resolved once after mount. */
interface SourceCfg {
  provider: "ahrefs" | "semrush";
  mode: MetricsMode;
  host: string;
  cap: number;
}

export default function BacklinkProfile({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  // A client opening a share link sees the profile and cannot refresh it. The server enforces
  // that too — this only keeps a button on screen that would always fail.
  const guest = isGuestView();

  const [rows, setRows] = useState<RefDomain[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<React.ReactNode>("");
  const [hasKey, setHasKey] = useState(false);
  const [showLost, setShowLost] = useState(false);
  const [tablePage, setTablePage] = useState(1);

  // Resolved in an effect, not during render: mode and host live in localStorage, and reading
  // them during the first pass would make the server HTML disagree with the client's.
  const [src, setSrc] = useState<SourceCfg | null>(null);
  const [balance, setBalance] = useState<{ info: SubscriptionInfo | null; gatewayStatus: number | null } | null>(null);
  const [localUsage, setLocalUsage] = useState<number | null>(null);

  useEffect(() => {
    if (guest) return;
    const creds = getMetricsCreds();
    setHasKey(creds.apiKey.length > 4);
    setSrc({
      provider: creds.provider,
      // Same resolution the settings screen uses — a second way of deriving the mode here
      // would be able to disagree with it, and "mode" is exactly what a 401 message names.
      mode: getMetricsMode(creds.provider),
      host: creds.baseUrl || DEFAULT_BASE_URL[creds.provider],
      cap: creds.cap,
    });
  }, [guest]);

  // The provider's own balance — free, cached 10 minutes server-side, so a render never opens
  // a gateway round-trip for it. Null `info` means "unavailable", and the placard then says so
  // and falls back to our own spend estimate rather than presenting it as the balance.
  const loadBalance = useCallback(async () => {
    const creds = getMetricsCreds();
    if (guest || creds.apiKey.length <= 4) return;
    try {
      const res = await fetch("/api/metrics/subscription", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: creds.provider, apiKey: creds.apiKey, baseUrl: creds.baseUrl }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.usage && typeof d.usage.units === "number") setLocalUsage(d.usage.units);
      setBalance({
        info: d.info ?? null,
        gatewayStatus: typeof d.gatewayStatus === "number" ? d.gatewayStatus : null,
      });
    } catch { setBalance({ info: null, gatewayStatus: null }); }
  }, [guest]);

  useEffect(() => { loadBalance().catch(() => {}); }, [loadBalance]);

  // Gateway refusals carry different diagnoses: 401 names the wrong key/host pair, 402 an
  // empty wallet, 403 a product the key does not include. Flattening them into one "failed"
  // is what made this screen undiagnosable, so each gets its own sentence. Shared by the
  // hard-failure notice and the "partial pull" notice for the same reason.
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
    const creds = getMetricsCreds();
    const body: Record<string, unknown> = { siteId: siteDbId, provider: creds.provider, fetch: doFetch };
    const token = shareTokenFromPath();
    if (token) body.shareToken = token;
    if (doFetch) Object.assign(body, { apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap });

    const res = await fetch("/api/metrics/backlinks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (Array.isArray(d.refDomains)) setRows(d.refDomains);
    if (Array.isArray(d.history)) setHistory(d.history);
    if (d.usage && typeof d.usage.units === "number") setLocalUsage(d.usage.units);
    if (!res.ok && doFetch) {
      const host = creds.baseUrl || DEFAULT_BASE_URL[creds.provider];
      setNotice(
        d.error === "cap_exceeded" ? t("kwCapExceeded")
        : d.error === "provider_unsupported" ? t("blpAhrefsOnly")
        : gatewayNotice(typeof d.error === "string" ? d.error : "", host) ?? t("blpFailed")
      );
    } else if (doFetch) {
      // A partial pull cannot prove a link is gone, so it does not mark anything lost. Saying
      // so is the difference between "no losses" and "we did not look" — and when it stopped
      // for a gateway reason, that reason rides along instead of hiding behind "partial".
      const reason = typeof d.partialError === "string" && d.partialError
        ? gatewayNotice(d.partialError, creds.baseUrl || DEFAULT_BASE_URL[creds.provider]) ?? d.partialError
        : null;
      setNotice(d.complete === false
        ? <>{t("blpPartial")}{reason ? <> · {reason}</> : null}</>
        : "");
      loadBalance().catch(() => {});
    }
  }, [siteDbId, t, loadBalance, gatewayNotice]);

  // Free read of what is stored — never reaches a provider.
  useEffect(() => { call(false).catch(() => {}); }, [call]);

  async function refresh() {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await call(true); } catch { setNotice(t("blpFailed")); }
    setBusy(false);
  }

  const live = useMemo(() => rows.filter(r => !r.lost), [rows]);
  const lost = useMemo(() => rows.filter(r => r.lost), [rows]);
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[0] : null;
  // Priced from the last pull's real domain count — the same figure the server reserves when it
  // refreshes. Before the first pull there is no count to price from, and the chip hides rather
  // than guessing: the discovery pull costs one floored stats call and nothing more.
  const estDomains = latest?.refDomains ?? null;
  const units = estDomains != null ? estimateProfileUnits(estDomains) : null;
  const usd = units != null ? estimateCostUsd(units, getMetricsCreds().provider) : null;

  const chip = (label: string, value: string, hint?: string) => (
    <div key={label} title={hint} style={{ padding: "10px 14px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)", minWidth: "104px" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)" }}>{value}</div>
    </div>
  );

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = { ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" };

  const visible = showLost ? lost : live;
  const tablePages = Math.max(1, Math.ceil(visible.length / TABLE_ROWS_PER_PAGE));
  const pageNo = Math.min(tablePage, tablePages);
  const pageRows = visible.slice((pageNo - 1) * TABLE_ROWS_PER_PAGE, pageNo * TABLE_ROWS_PER_PAGE);

  // ── Source placard values ──
  const info = balance?.info ?? null;
  // Reseller keys are per-key; workspace limits apply to official subscriptions. Prefer the
  // pair that is actually present rather than summing or guessing between them.
  const balLimit = info?.unitsLimitApiKey ?? info?.unitsLimitWorkspace ?? null;
  const balUsed = info?.unitsUsageApiKey ?? info?.unitsUsageWorkspace ?? null;
  const remaining = balLimit != null && balUsed != null ? Math.max(0, balLimit - balUsed) : null;
  const updated = info
    ? new Date(info.fetchedAt).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  const expDate = info?.apiKeyExpirationDate ?? "";
  const expSoon = !!expDate && new Date(expDate).getTime() - Date.now() < 7 * 86_400_000;
  const modeLabel = src?.mode === "official" ? t("blsrcHostOfficial")
    : src?.mode === "reseller" ? t("blsrcHostReseller") : t("blsrcHostCustom");

  return (
    <div className="panel" style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
        <Link2 size={17} color="var(--color-accent-blue)" />
        <h3 className="title-sm" style={{ margin: 0 }}>{t("blpTitle")}</h3>

        {!guest && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {hasKey && units != null && usd != null && (
            <span className="metric-cost">{units.toLocaleString()} {t("metricsUnits")} · ≈ {formatUsd(usd)}</span>
          )}
          <button className="metric-action" onClick={refresh} disabled={busy || !hasKey}
            title={!hasKey ? t("blpNoKey") : undefined}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {busy ? t("blpLoading") : t("blpRefresh")}
          </button>
        </div>}
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("blpSub")}</p>

      {/* Source placard — always visible for the owner: whose key, which host, what is left.
          A bare "5 000 units ≈ $0.13" cost chip answers none of the three questions a newcomer
          actually has, and renders the same whether the pull will work or is doomed to 401. */}
      {!guest && src && (
        <div style={{ display: "flex", alignItems: "center", gap: "4px 10px", flexWrap: "wrap", marginBottom: "14px", padding: "8px 12px", fontSize: "12px", color: "var(--color-text-secondary)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
          {hasKey ? (
            <>
              <span>{t("blsrcTitle")}: <strong style={{ color: "var(--color-text-primary)" }}>
                {src.provider === "ahrefs" ? "Ahrefs API v3" : "Semrush API"}
              </strong></span>
              <code style={{ fontFamily: "monospace", fontSize: "11px" }}>{src.host.replace(/^https?:\/\//, "")}</code>
              <span className="metric-chip" style={{ fontWeight: 500 }}>{modeLabel}</span>
              {info && updated && <span>{t("blsrcUpdated")} {updated}</span>}
              {remaining != null && balLimit != null ? (
                <span>{t("blsrcRemaining")} <strong style={{ color: "var(--color-text-primary)" }}>{remaining.toLocaleString()}</strong> {t("blsrcOf")} {balLimit.toLocaleString()}</span>
              ) : (
                <span>
                  {t("blsrcBalanceUnknown")}
                  {localUsage != null && <> · {fill(t("blsrcUnitsLeft"), { n: (src.cap > 0 ? Math.max(0, src.cap - localUsage) : localUsage).toLocaleString() })}</>}
                </span>
              )}
              {info?.usageResetDate && <span>{t("blsrcResetAt")} {info.usageResetDate}</span>}
              {expDate && <span style={expSoon ? { color: "var(--color-warning)" } : undefined}>
                {t("blsrcKeyExpires")} {expDate}
              </span>}
              {expSoon && <span style={{ color: "var(--color-warning)" }}>{t("blsrcKeyExpiringSoon")}</span>}
            </>
          ) : (
            <>
              <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{t("blsrcNoKey")}</span>
              <span>{t("blsrcNoKeyHint")}</span>
            </>
          )}
          <a href="/settings?tab=metrics" style={{ marginLeft: hasKey ? "auto" : undefined, color: "var(--color-accent-blue)", textDecoration: "none", whiteSpace: "nowrap" }}>{t("blsrcConfigure")}</a>
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: "12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{notice}</div>
      )}

      {rows.length === 0 && !latest ? (
        <div style={{ padding: "28px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {t("blpEmpty")}
        </div>
      ) : (
        <>
          <div className="privacy-blur-all" style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
            {chip(t("blpRefDomains"), fmt(latest?.refDomains ?? live.length))}
            {chip(t("blpBacklinks"), fmt(latest?.backlinks))}
            {chip(t("blpDofollow"), latest?.dofollowPct != null ? `${latest.dofollowPct}%` : "—", t("blpDofollowHint"))}
            {/* Only meaningful once two pulls exist; before that the honest answer is nothing. */}
            {previous?.refDomains != null && latest?.refDomains != null &&
              chip(t("blpChange"), `${latest.refDomains - previous.refDomains >= 0 ? "+" : ""}${latest.refDomains - previous.refDomains}`, t("blpChangeHint"))}
            {lost.length > 0 && chip(t("blpLost"), String(lost.length))}
          </div>

          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            {([[false, `${t("blpLive")} (${live.length})`], [true, `${t("blpLost")} (${lost.length})`]] as const).map(([v, label]) => (
              <button key={String(v)} className={showLost === v ? "pill active" : "pill"}
                onClick={() => setShowLost(v)} style={{ cursor: "pointer", border: "1px solid transparent" }}>{label}</button>
            ))}
          </div>

          <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                  <th style={th}>{t("blpDomain")}</th>
                  <th style={{ ...th, textAlign: "center", width: "70px" }}>DR</th>
                  <th style={{ ...th, textAlign: "center", width: "80px" }}>{t("blpLinks")}</th>
                  <th style={{ ...th, width: "110px" }}>{showLost ? t("blpLostAt") : t("blpFirstSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(r => (
                  <tr key={r.refDomain} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={cell}>
                      <a href={`https://${r.refDomain}`} target="_blank" rel="noreferrer noopener nofollow"
                        style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>{r.refDomain}</a>
                      {!r.dofollow && (
                        <span className="metric-chip" style={{ marginLeft: "6px", fontWeight: 500 }}>nofollow</span>
                      )}
                    </td>
                    <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: r.dr != null ? drColor(r.dr) : "var(--color-text-secondary)" }}>
                      {r.dr != null ? Math.round(r.dr) : "—"}
                    </td>
                    <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{r.linksToTarget ?? "—"}</td>
                    <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "12px" }}>
                      {showLost ? (r.lostAt || "—") : (r.firstSeen ? r.firstSeen.slice(0, 10) : "—")}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={4} style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)", padding: "24px" }}>
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
