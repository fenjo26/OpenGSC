"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileCode2, Globe2,
  Link2, Loader2, Radar, RefreshCw, Satellite,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
// Pure day math, explicitly client-safe (see the file header): the sitemap age the panel
// shows must be the same UTC-midnight count the server records, not a local-calendar
// re-derivation — that drift is exactly why this helper exists.
import { utcMidnightDaysBetween } from "@/lib/drops/activation";

// ─── Wire types (mirrors activationStore.ts; dates arrive as ISO strings) ─────────

type AssetSummary = {
  id: string; domain: string; stage: string; candidateId: string | null;
  urlsTotal: number; urlsWayback: number; urlsGsc: number;
  donors: number; placementsActive: number;
  sitemapBuiltAt: string | null; sitemapUrl: string | null;
  indexnowPushedAt: string | null; indexnowCount: number; indexnowLastStatus: string | null;
  gscSiteUrl: string | null; gscSitemapSubmittedAt: string | null;
  lastGoogleHitAt: string | null; googleHits7d: number;
  createdAt: string;
  // Not in the store's declared summary, but listAssets spreads the whole row, so the
  // route serializes it — prefilling the sitemap-path input wants it.
  gscSitemapPath?: string | null;
};

type AssetDetail = {
  asset: {
    id: string; domain: string; stage: string; indexnowKey: string | null;
    gscSiteUrl: string | null; gscSitemapPath: string | null; gscSitemapSubmittedAt: string | null;
    sitemapUrl: string | null; sitemapBuiltAt: string | null;
    indexnowPushedAt: string | null; indexnowCount: number; indexnowLastStatus: string | null;
    lastGoogleHitAt: string | null; googleHits7d: number;
    note: string | null; createdAt: string;
  };
  urls: { url: string; source: string; inGsc: boolean; lastSeenAt: string | null }[];
  donors: { url: string }[];
  placements: { doorway: string; donorUrl: string; placedAt: string; active: boolean }[];
};

type Bundle = {
  sitemapXml: string; robotsTxt: string; keyFile: string;
  nginxSnippet: string; sitemapUrl: string;
};

/**
 * An error the way the activation routes actually speak it: a stable code, sometimes a
 * human hint (GSC 403, IndexNow 422), sometimes a rejected-URL list (donor_not_allowed).
 * All three render inline and verbatim — an honest code beats a smoothed-over sentence.
 */
type ErrBody = { status: number; error?: string; hint?: string; rejected?: string[] };

// ─── Fetch helpers (same never-throw-for-4xx contract as the rest of the app) ──────

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

async function sendJson(
  url: string, method: string, payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

function errFrom(status: number, body: Record<string, unknown>): ErrBody {
  return {
    status,
    error: typeof body.error === "string" ? body.error : `HTTP ${status}`,
    hint: typeof body.hint === "string" ? body.hint : undefined,
    rejected: Array.isArray(body.rejected) ? body.rejected.filter((u): u is string => typeof u === "string") : undefined,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────────

/** "Sep 15, 2026" — the repo's date style (serpmon/shared fmtDate, kept local so the
 *  drops surface does not import another feature's component module). */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Whole days since `iso`, counted between UTC midnights — never a local calendar. */
function utcDaysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return utcMidnightDaysBetween(new Date(iso), new Date());
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ─── Shared styles (the drops page's vocabulary, minus its page-local consts) ──────

const primaryBtn: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, padding: "7px 14px", borderRadius: 9,
  border: "none", background: "var(--color-accent-blue)", color: "#fff",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};

const ghostBtn = (disabled: boolean): CSSProperties => ({
  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "transparent",
  color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
  fontSize: 12, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
});

const inputStyle: CSSProperties = { fontSize: 12 };

const preBlock: CSSProperties = {
  margin: 0, padding: 0, maxHeight: 190, overflow: "auto", fontSize: 11.5,
  fontFamily: "ui-monospace, monospace", color: "var(--color-text-secondary)",
  whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.55,
};

/** Stages in pipeline order, colour-matched to the catalogue's funnel chips. */
const STAGES: { value: string; key: string; color: string }[] = [
  { value: "new", key: "drops_activation_stage_new", color: "var(--color-text-secondary)" },
  { value: "harvesting", key: "drops_activation_stage_harvesting", color: "var(--color-accent-blue)" },
  { value: "ready", key: "drops_activation_stage_ready", color: "var(--color-accent-green, #34c759)" },
  { value: "live", key: "drops_activation_stage_live", color: "var(--color-accent-purple)" },
  { value: "paused", key: "drops_activation_stage_paused", color: "var(--color-accent-orange, #ff9f0a)" },
];

/** Harvest source buttons — literal keys so `t()` stays typed. */
const HARVEST_KEYS = {
  wayback: "drops_activation_harvest_wayback",
  gsc: "drops_activation_harvest_gsc",
  all: "drops_activation_harvest_all",
} as const;

// ─── Panel ────────────────────────────────────────────────────────────────────────

/**
 * The «Активация» tab of /drops: everything that happens to a domain AFTER it is bought.
 * The panel owns only its own reads (GET /api/drops/activation) — every action is a call
 * to the [domain]/* routes built by the sibling tasks, and every response is rendered
 * honestly: codes and hints verbatim, rejected donor lists in full.
 */
export default function ActivationPanel() {
  const { t } = useLanguage();
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    let out: { status: number; body: Record<string, unknown> };
    try {
      out = await getJson("/api/drops/activation");
    } catch {
      setLoading(false);
      setLoadErr(t("drops_activation_load_failed").replace("{err}", "network"));
      return;
    }
    setLoading(false);
    if (out.status === 503 && out.body.error === "schema_missing") {
      setNotMigrated(true);
      setAssets([]);
      return;
    }
    if (out.status === 401) {
      setLoadErr(t("drops_activation_load_failed").replace("{err}", "unauthorized"));
      return;
    }
    if (out.status !== 200 || !Array.isArray(out.body.assets)) {
      setLoadErr(t("drops_activation_load_failed").replace("{err}", String(out.body.error ?? out.status)));
      return;
    }
    setNotMigrated(false);
    setAssets(out.body.assets as AssetSummary[]);
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    {notMigrated && <div className="panel" style={{ color: "var(--color-accent-orange, #ff9f0a)", fontSize: 13 }}>
      <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{t("drops_activation_not_migrated")}
    </div>}

    {loadErr && <div className="panel" style={{ color: "#ff6b62", fontSize: 12.5 }}>
      <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{loadErr}
    </div>}

    {loading && <div className="panel" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--color-text-secondary)" }}>
      <Loader2 size={14} className="spin" />{t("drops_activation_loading")}
    </div>}

    {!loading && assets !== null && assets.length === 0 && <div className="panel" style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--color-text-secondary)" }}>
      <div>{t("drops_activation_empty_pipeline")}</div>
      <div style={{ marginTop: 6, color: "var(--color-accent-orange, #ff9f0a)" }}>{t("drops_activation_empty_nginx")}</div>
    </div>}

    {!loading && assets !== null && assets.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {assets.map(a => <AssetCard key={a.id} a={a} refresh={() => void load()} />)}
    </div>}

    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <button onClick={() => void load()} disabled={loading} style={ghostBtn(loading)}>
        {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        {t("drops_activation_refresh")}
      </button>
    </div>
  </div>;
}

// ─── One asset card ───────────────────────────────────────────────────────────────

function AssetCard({ a, refresh }: { a: AssetSummary; refresh: () => void }) {
  const { t } = useLanguage();
  const tr = (k: string) => t(k as never) as string;

  // One busy action at a time per card; the id names the button that spins.
  const [busy, setBusy] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<ErrBody | null>(null);

  const clearOutcome = () => { setOk(null); setErr(null); };
  const begin = (id: string) => { clearOutcome(); setBusy(id); };
  const finishOk = (msg: string) => { setBusy(null); setOk(msg); refresh(); };
  const finishErr = (status: number, body: Record<string, unknown>) => {
    setBusy(null);
    setErr(errFrom(status, body));
  };

  // Harvest: source buttons + the siteUrl the GSC source needs (prefilled once submitted).
  const [harvestSite, setHarvestSite] = useState(a.gscSiteUrl ?? "");
  const harvest = async (source: "wayback" | "gsc" | "all") => {
    begin(`harvest:${source}`);
    const payload: Record<string, unknown> = { source };
    const site = harvestSite.trim();
    if (site && (source === "gsc" || source === "all")) payload.gscSiteUrl = site;
    const { status, body } = await sendJson(`/api/drops/activation/${encodeURIComponent(a.domain)}/harvest`, "POST", payload);
    if (status === 200) finishOk(t("drops_activation_harvest_done"));
    else finishErr(status, body);
  };

  // ── Bundle (expandable, fetched on open) ──
  const [bundleOpen, setBundleOpen] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [bundleErr, setBundleErr] = useState<ErrBody | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const toggleBundle = async () => {
    const next = !bundleOpen;
    setBundleOpen(next);
    if (!next || bundle || bundleErr) return;
    setBusy("bundle");
    const { status, body } = await getJson(`/api/drops/activation/${encodeURIComponent(a.domain)}/bundle`);
    setBusy(null);
    if (status === 200) setBundle(body as unknown as Bundle);
    else setBundleErr(errFrom(status, body));
  };
  const copy = async (id: string, text: string) => {
    if (await copyText(text)) {
      setCopied(id);
      setTimeout(() => setCopied(c => (c === id ? null : c)), 1500);
    }
  };

  // ── GSC submit ──
  const [gscSite, setGscSite] = useState(a.gscSiteUrl ?? "");
  const [gscPath, setGscPath] = useState(a.gscSitemapPath ?? "/sitemap.xml");
  const submitGsc = async () => {
    begin("gsc");
    const payload: Record<string, unknown> = { siteUrl: gscSite.trim() };
    const p = gscPath.trim();
    if (p) payload.sitemapPath = p;
    const { status, body } = await sendJson(`/api/drops/activation/${encodeURIComponent(a.domain)}/gsc-submit`, "POST", payload);
    if (status === 200) finishOk(t("drops_activation_gsc_done"));
    else finishErr(status, body);
  };

  // ── IndexNow ──
  const [inowRes, setInowRes] = useState<{ pushed: number; chunks: number; status: string; keyLocation?: string; hint?: string } | null>(null);
  const pushIndexnow = async () => {
    begin("indexnow");
    const { status, body } = await sendJson(`/api/drops/activation/${encodeURIComponent(a.domain)}/indexnow`, "POST", {});
    if (status === 200) {
      setInowRes({
        pushed: Number(body.pushed ?? 0), chunks: Number(body.chunks ?? 0),
        status: String(body.status ?? "ok"),
        keyLocation: typeof body.keyLocation === "string" ? body.keyLocation : undefined,
        hint: typeof body.hint === "string" ? body.hint : undefined,
      });
      finishOk(t("drops_activation_indexnow_res")
        .replace("{n}", String(body.pushed ?? 0))
        .replace("{chunks}", String(body.chunks ?? 0))
        .replace("{status}", String(body.status ?? "ok")));
    } else {
      finishErr(status, body);
    }
  };

  // ── Donors (textarea, PUT then Run) ──
  const [donorsOpen, setDonorsOpen] = useState(false);
  const [donorText, setDonorText] = useState<string | null>(null); // null = not yet prefilled
  const [donorsErr, setDonorsErr] = useState<ErrBody | null>(null);
  const [donorsOk, setDonorsOk] = useState<string | null>(null);
  const toggleDonors = async () => {
    const next = !donorsOpen;
    setDonorsOpen(next);
    setDonorsErr(null);
    if (!next || donorText !== null) return;
    setBusy("donors:load");
    const { status, body } = await getJson(`/api/drops/activation?domain=${encodeURIComponent(a.domain)}`);
    setBusy(null);
    if (status === 200) {
      const detail = body as unknown as AssetDetail;
      setDonorText(detail.donors.map(d => d.url).join("\n"));
    } else {
      setDonorText("");
      setDonorsErr(errFrom(status, body));
    }
  };
  const saveDonors = async () => {
    begin("donors:save");
    setDonorsErr(null);
    setDonorsOk(null);
    const urls = (donorText ?? "").split("\n").map(s => s.trim()).filter(Boolean);
    const { status, body } = await sendJson(`/api/drops/activation/${encodeURIComponent(a.domain)}/donors`, "PUT", { urls });
    if (status === 200) {
      setDonorsOk(t("drops_activation_donors_saved")
        .replace("{added}", String(body.added ?? 0))
        .replace("{removed}", String(body.removed ?? 0))
        .replace("{total}", String(body.total ?? urls.length)));
      setBusy(null);
      refresh();
    } else {
      setDonorsErr(errFrom(status, body));
      finishErr(status, body);
    }
  };
  const runDonors = async () => {
    begin("donors:run");
    setDonorsErr(null);
    const { status, body } = await sendJson(`/api/drops/activation/${encodeURIComponent(a.domain)}/run-donors`, "POST", {});
    if (status === 200) {
      const doorways = Array.isArray(body.doorways) ? body.doorways as { domain: string; googleHits: number }[] : [];
      const names = doorways.slice(0, 5).map(d => `${d.domain} (${d.googleHits.toLocaleString()})`).join(" · ");
      finishOk(t("drops_activation_run_res")
        .replace("{doorways}", String(doorways.length))
        .replace("{urls}", String(body.urlsEnqueued ?? 0))
        .replace("{placements}", String(body.placements ?? 0))
        + (names ? ` — ${names}` : ""));
    } else {
      finishErr(status, body);
    }
  };

  // ── Details (expandable: urls / donors / placements from getAsset) ──
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailErr, setDetailErr] = useState<ErrBody | null>(null);
  const toggleDetail = async () => {
    const next = !detailOpen;
    setDetailOpen(next);
    if (!next || detail || detailErr) return;
    setBusy("detail");
    const { status, body } = await getJson(`/api/drops/activation?domain=${encodeURIComponent(a.domain)}`);
    setBusy(null);
    if (status === 200) setDetail(body as unknown as AssetDetail);
    else setDetailErr(errFrom(status, body));
  };

  const stage = STAGES.find(s => s.value === a.stage) ?? STAGES[0];
  const sitemapDays = utcDaysAgo(a.sitemapBuiltAt);
  const hasGoogleHits = a.googleHits7d > 0 || a.lastGoogleHitAt != null;

  return <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

    {/* Header: domain, stage, age */}
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <b style={{ fontSize: 15, color: "var(--color-text-primary)" }}>{a.domain}</b>
      <span title={a.stage} style={{
        fontSize: 11, fontWeight: 700, color: stage.color,
        border: `1px solid ${stage.color}`, borderRadius: 999, padding: "2px 9px",
      }}>{tr(stage.key)}</span>
      <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }} title={fmtDateTime(a.createdAt)}>
        {t("drops_activation_created").replace("{date}", fmtDate(a.createdAt))}
      </span>
    </div>

    {/* Facts. Dates carry their absolute value in the tooltip; ages are UTC-midnight math. */}
    <div style={{ display: "flex", gap: "6px 16px", flexWrap: "wrap", fontSize: 12.5, color: "var(--color-text-secondary)" }}>
      {a.urlsTotal > 0
        ? <span>{t("drops_activation_urls_line")
          .replace("{n}", a.urlsTotal.toLocaleString())
          .replace("{wb}", a.urlsWayback.toLocaleString())
          .replace("{gsc}", a.urlsGsc.toLocaleString())}</span>
        : <span style={{ color: "var(--color-text-tertiary)" }}>{t("drops_activation_urls_none")}</span>}
      {sitemapDays != null
        ? <span title={fmtDateTime(a.sitemapBuiltAt)}>
          {sitemapDays <= 0
            ? t("drops_activation_sitemap_today")
            : t("drops_activation_sitemap_days").replace("{n}", String(sitemapDays))}
        </span>
        : <span style={{ color: "var(--color-text-tertiary)" }}>{t("drops_activation_sitemap_never")}</span>}
      {a.indexnowCount > 0
        ? <span title={fmtDateTime(a.indexnowPushedAt)}>{t("drops_activation_indexnow_line")
          .replace("{n}", a.indexnowCount.toLocaleString())
          .replace("{status}", a.indexnowLastStatus ?? "—")}</span>
        : <span style={{ color: "var(--color-text-tertiary)" }}>{t("drops_activation_indexnow_never")}</span>}
      {a.gscSitemapSubmittedAt
        ? <span title={fmtDateTime(a.gscSitemapSubmittedAt)}>{t("drops_activation_gsc_submitted")
          .replace("{date}", fmtDate(a.gscSitemapSubmittedAt))}</span>
        : <span style={{ color: "var(--color-text-tertiary)" }}>{t("drops_activation_gsc_never")}</span>}
      <span>{t("drops_activation_donors_line")
        .replace("{n}", String(a.donors))
        .replace("{m}", String(a.placementsActive))}</span>
      {hasGoogleHits && <span title={fmtDateTime(a.lastGoogleHitAt)}>{t("drops_activation_google_hits_line")
        .replace("{n}", a.googleHits7d.toLocaleString())
        .replace("{date}", a.lastGoogleHitAt ? fmtDate(a.lastGoogleHitAt) : t("drops_activation_never"))}</span>}
    </div>

    {/* Harvest */}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
        <Radar size={13} />{t("drops_activation_harvest_label")}
      </span>
      <input className="tool-input" style={{ ...inputStyle, width: 210 }} value={harvestSite}
        onChange={e => setHarvestSite(e.target.value)}
        placeholder={t("drops_activation_harvest_site_ph")} />
      {(["wayback", "gsc", "all"] as const).map(src => (
        <button key={src} onClick={() => void harvest(src)} disabled={busy !== null} style={ghostBtn(busy !== null)}>
          {busy === `harvest:${src}` && <Loader2 size={12} className="spin" />}
          {t(HARVEST_KEYS[src])}
        </button>
      ))}
    </div>

    {/* Deploy + GSC + IndexNow */}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button onClick={() => void toggleBundle()} disabled={busy !== null} style={ghostBtn(busy !== null)}>
        {busy === "bundle" ? <Loader2 size={12} className="spin" /> : bundleOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <FileCode2 size={12} />{t("drops_activation_bundle")}
      </button>
      <input className="tool-input" style={{ ...inputStyle, width: 210 }} value={gscSite}
        onChange={e => setGscSite(e.target.value)}
        placeholder={t("drops_activation_gsc_site_ph")} />
      <input className="tool-input" style={{ ...inputStyle, width: 130 }} value={gscPath}
        onChange={e => setGscPath(e.target.value)}
        placeholder={t("drops_activation_gsc_path_ph")} />
      <button onClick={() => void submitGsc()} disabled={busy !== null || !gscSite.trim()} style={ghostBtn(busy !== null || !gscSite.trim())}>
        {busy === "gsc" && <Loader2 size={12} className="spin" />}
        <Globe2 size={12} />{t("drops_activation_gsc_submit")}
      </button>
      <button onClick={() => void pushIndexnow()} disabled={busy !== null} style={ghostBtn(busy !== null)}>
        {busy === "indexnow" && <Loader2 size={12} className="spin" />}
        <Satellite size={12} />{t("drops_activation_indexnow_push")}
      </button>
      <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t("drops_activation_indexnow_note")}</span>
    </div>

    {/* Bundle section */}
    {bundleOpen && <div style={{
      display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 9,
      border: "1px solid var(--color-border)", background: "var(--color-card)",
    }}>
      <div style={{ fontSize: 12, color: "var(--color-accent-orange, #ff9f0a)" }}>{t("drops_activation_bundle_hint")}</div>
      {bundleErr && <ErrLine err={bundleErr} label={t("drops_activation_err")} rejectedLabel={t("drops_activation_donors_rejected")} />}
      {bundle && ([
        { id: "sitemap", title: t("drops_activation_bundle_sitemap"), body: bundle.sitemapXml },
        { id: "robots", title: t("drops_activation_bundle_robots"), body: bundle.robotsTxt },
        { id: "key", title: t("drops_activation_bundle_keyfile").replace("{key}", bundle.keyFile), body: bundle.keyFile },
        { id: "nginx", title: t("drops_activation_bundle_nginx"), body: bundle.nginxSnippet },
      ] as const).map(f => <div key={f.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 12, color: "var(--color-text-primary)" }}>{f.title}</b>
          <button onClick={() => void copy(f.id, f.body)} style={ghostBtn(false)}>
            {copied === f.id ? <Check size={12} /> : <Copy size={12} />}
            {copied === f.id ? t("drops_activation_copied") : t("drops_activation_copy")}
          </button>
        </div>
        <pre style={preBlock}>{f.body}</pre>
      </div>)}
    </div>}

    {/* Donors */}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button onClick={() => void toggleDonors()} disabled={busy !== null} style={ghostBtn(busy !== null)}>
        {busy === "donors:load" ? <Loader2 size={12} className="spin" /> : donorsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Link2 size={12} />{t("drops_activation_donors")}
      </button>
      <button onClick={() => void toggleDetail()} disabled={busy !== null} style={ghostBtn(busy !== null)}>
        {busy === "detail" ? <Loader2 size={12} className="spin" /> : detailOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t("drops_activation_details")}
      </button>
    </div>

    {donorsOpen && <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 9,
      border: "1px solid var(--color-border)", background: "var(--color-card)",
    }}>
      <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{t("drops_activation_donors_hint")}</div>
      <textarea className="tool-input" rows={5} value={donorText ?? ""} onChange={e => setDonorText(e.target.value)}
        placeholder={t("drops_activation_donors_ph")}
        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void saveDonors()} disabled={busy !== null || donorText === null} style={primaryBtn}>
          {busy === "donors:save" && <Loader2 size={13} className="spin" />}{t("drops_activation_donors_save")}
        </button>
        <button onClick={() => void runDonors()} disabled={busy !== null} style={ghostBtn(busy !== null)}>
          {busy === "donors:run" && <Loader2 size={12} className="spin" />}{t("drops_activation_donors_run")}
        </button>
        {donorsOk && <span style={{ fontSize: 12, color: "var(--color-accent-green, #34c759)" }}>{donorsOk}</span>}
      </div>
      {donorsErr && <ErrLine err={donorsErr} label={t("drops_activation_err")} rejectedLabel={t("drops_activation_donors_rejected")} />}
    </div>}

    {/* Details section */}
    {detailOpen && <div style={{
      display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 9,
      border: "1px solid var(--color-border)", background: "var(--color-card)",
      fontSize: 12, color: "var(--color-text-secondary)",
    }}>
      {detailErr && <ErrLine err={detailErr} label={t("drops_activation_err")} rejectedLabel={t("drops_activation_donors_rejected")} />}
      {detail && <>
        <DetailList title={t("drops_activation_details_urls").replace("{n}", String(detail.urls.length))}>
          {detail.urls.slice(0, 100).map(u => <li key={u.url} style={{ wordBreak: "break-all" }}>
            {u.url} <span style={{ color: "var(--color-text-tertiary)" }}>({u.source}{u.inGsc ? " · GSC" : ""})</span>
          </li>)}
          {detail.urls.length > 100 && <li style={{ color: "var(--color-text-tertiary)" }}>
            {t("drops_activation_details_more").replace("{n}", String(detail.urls.length - 100))}
          </li>}
        </DetailList>
        <DetailList title={t("drops_activation_details_donors").replace("{n}", String(detail.donors.length))}>
          {detail.donors.map(d => <li key={d.url} style={{ wordBreak: "break-all" }}>{d.url}</li>)}
        </DetailList>
        <DetailList title={t("drops_activation_details_placements").replace("{n}", String(detail.placements.length))}>
          {detail.placements.map(p => <li key={`${p.doorway}|${p.donorUrl}`} style={{ wordBreak: "break-all" }}>
            {p.doorway} → {p.donorUrl}{" "}
            <span style={{ color: p.active ? "var(--color-accent-green, #34c759)" : "var(--color-text-tertiary)" }}>
              ({p.active ? t("drops_activation_placement_active") : t("drops_activation_placement_inactive")}
              {" · "}{fmtDate(p.placedAt)})
            </span>
          </li>)}
        </DetailList>
      </>}
    </div>}

    {/* Outcome of the last action: one green line or the honest error body. */}
    {inowRes?.keyLocation && <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", wordBreak: "break-all" }}>
      {t("drops_activation_indexnow_keyloc").replace("{url}", inowRes.keyLocation)}
    </div>}
    {inowRes?.hint && <div style={{ fontSize: 12, color: "var(--color-accent-orange, #ff9f0a)" }}>{inowRes.hint}</div>}
    {ok && <div style={{ fontSize: 12.5, color: "var(--color-accent-green, #34c759)" }}>{ok}</div>}
    {err && <ErrLine err={err} label={t("drops_activation_err")} rejectedLabel={t("drops_activation_donors_rejected")} />}
  </div>;
}

/** A labelled list inside the details section; empty lists render their zero count only. */
function DetailList({ title, children }: { title: string; children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <b style={{ fontSize: 12, color: "var(--color-text-primary)" }}>{title}</b>
    <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2, lineHeight: 1.6 }}>
      {children}
    </ul>
  </div>;
}

/**
 * The honest error: stable code verbatim, the route's hint when it sent one (GSC 403,
 * IndexNow 422), and the full rejected list for donor_not_allowed — never a summary that
 * hides which URL was the problem. Both labels arrive localized from the caller (a leaf
 * component has no hook of its own).
 */
function ErrLine({ err, label, rejectedLabel }: { err: ErrBody; label: string; rejectedLabel: string }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5 }}>
    <span style={{ color: "#ff6b62" }}>
      <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
      {label.replace("{err}", `${err.error} (HTTP ${err.status})`)}
    </span>
    {err.hint && <span style={{ color: "var(--color-accent-orange, #ff9f0a)" }}>{err.hint}</span>}
    {err.rejected && err.rejected.length > 0 && <span style={{ color: "var(--color-accent-orange, #ff9f0a)" }}>
      {rejectedLabel} {err.rejected.join(", ")}
    </span>}
  </div>;
}
