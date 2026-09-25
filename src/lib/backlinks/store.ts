// Prisma orchestration for the backlink-toxicity feature (N2): the run that classifies every
// donor of a site, the niche (Site.backlinkNiche), the disavow file contents, and the recovery
// table. Pure math lives in ./toxicity, ./disavow and ./recovery; this file only reads rows,
// calls those, writes verdicts back and fires the toxic_new alert.
//
// Conventions inherited from the rest of the metrics layer:
//  - swallowed errors behind backlinksNotMigrated: an instance that pulled the code but has not
//    run `prisma db push` gets `{ notMigrated: true }`, never a 500;
//  - `disavow` is NEVER written by anything here except setDisavow, which is only reachable
//    from the PATCH route (the operator's explicit decision — brief §3).

import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L } from "@/lib/notifyI18n";
import { getAlertSettings } from "@/lib/alertScheduler";
import { fetchDonorPage } from "@/lib/seo/placementRunner";
import {
  classifyDonor,
  overOptimization,
  parseNiche,
  serializeNiche,
  suggestNicheFromText,
  TOX_LEVEL_ORDER,
  type DonorLink,
  type ToxLevel,
} from "./toxicity";
import { buildDisavowFile, disavowFileName, type DisavowDonor, type DisavowLink, type DisavowMode } from "./disavow";
import { rankRecovery, type RecoveryInput, type RecoveryRow } from "./recovery";

// Unlike placementRunner's `as any` casts (written when the client lagged the schema), this
// module runs on the wave-nov foundation, whose generated client already knows every table and
// column used here — so access stays typed and eslint stays quiet.
const db = prisma;

/** Deep check: fetch at most this many donor homepages per run (brief §1: "до 50 доменов за раз"). */
export const DEEP_CHECK_MAX = 50;
/** Donor rows returned to the UI/MCP overview, worst first. */
export const OVERVIEW_DONOR_CAP = 500;
/** Recovery rows returned, best-value first. */
export const RECOVERY_ROW_CAP = 500;
/** Donors re-classified per DB transaction slice (batch ≤ 400 params rule). */
const WRITE_SLICE = 100;
/** How far back a loss/downgrade event still counts for the recovery table. */
const RECOVERY_EVENT_WINDOW_DAYS = 180;

export function backlinksNotMigrated(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    value?.code === "P2022" ||
    /SiteBacklink|backlinkNiche|SiteAuditPage|DailyMetric.*(does not exist|no such table|no such column)/i.test(String(value?.message ?? ""))
  );
}

/** The site's own host — classification context (alien scripts) and the disavow file header. */
export function siteHostOf(url: string): string {
  return (url ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/^sc-domain:/, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
}

/**
 * Site resolution shared by the read routes: the owner's own id, or a valid share token for
 * exactly this site (the /api/backlinks/sync convention). Guests get reads only; every write
 * route resolves the site by userId alone.
 */
export async function siteForRead(
  userId: string | null,
  siteId: string,
  shareToken: string,
): Promise<{ id: string } | null> {
  if (userId) {
    return db.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  }
  if (!shareToken) return null;
  return db.site.findFirst({
    where: { id: siteId, shareToken, shareEnabled: true },
    select: { id: true },
  });
}

// ─── niche ─────────────────────────────────────────────────────────────────────

export async function readNiche(siteId: string): Promise<string[]> {
  try {
    const site = await db.site.findUnique({ where: { id: siteId }, select: { backlinkNiche: true } });
    return parseNiche(site?.backlinkNiche ?? null);
  } catch {
    return [];
  }
}

export async function writeNiche(siteId: string, niche: readonly string[]): Promise<void> {
  await db.site.update({ where: { id: siteId }, data: { backlinkNiche: serializeNiche(niche) } });
}

/**
 * Suggest a niche from the site itself: the home page's title + meta description as captured by
 * the last completed audit (depth 0 is the crawl root). A suggestion only — the operator sees
 * the chips and saves; nothing here writes Site.backlinkNiche.
 */
export async function suggestNicheFromSite(siteId: string): Promise<string[]> {
  try {
    const audit = await db.siteAudit.findFirst({
      where: { siteId, status: "completed" },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (!audit) return [];
    const pages = await db.siteAuditPage.findMany({
      where: { auditId: audit.id, depth: 0 },
      select: { title: true, metaDescription: true },
      take: 1,
      orderBy: { depth: "asc" },
    });
    const page = pages?.[0];
    if (!page) return [];
    return suggestNicheFromText(`${page.title ?? ""} ${page.metaDescription ?? ""}`);
  } catch {
    return [];
  }
}

// ─── the classification run ────────────────────────────────────────────────────

const CLASSIFY_SELECT = {
  domainFrom: true,
  apiAnchor: true,
  checkAnchor: true,
  pageTitle: true,
  apiSnippet: true,
  apiDr: true,
  apiContent: true,
  toxLevel: true,
  toxCheckedAt: true,
} as const;

export interface ToxRunSummary {
  donors: number;
  rows: number;
  /** donor counts per level after the run */
  levels: Record<ToxLevel, number>;
  /** true when no row of the site had ever been classified before this run */
  firstRun: boolean;
  deepChecked: number;
  deepFailed: number;
  /** donors that became toxic with this run (empty on the first run) */
  newToxic: string[];
  notified: boolean;
}

/** Extract a text sample from HTML for the deep check — tags stripped, entities collapsed. */
export function extractTextSample(html: string, maxChars = 1500): string {
  return (html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

/**
 * Recalculate a site's whole profile. Local by default (no network); with `deepLimit` > 0 the
 * run additionally fetches the homepages of up to DEEP_CHECK_MAX *suspicious* donors and
 * re-classifies them with the fetched title/text — the brief's "глубокая проверка".
 *
 * `notify` (scheduler: true, manual route: false) sends the single toxic_new alert for donors
 * that were not toxic before this run. The first run for a site never notifies — otherwise the
 * entire historical profile would arrive as one message.
 */
export async function recalcSiteToxicity(
  siteId: string,
  opts: { deepLimit?: number; notify?: boolean } = {},
): Promise<ToxRunSummary> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { url: true, backlinkNiche: true, userId: true },
  });
  if (!site) throw new Error("site_not_found");
  const siteDomain = siteHostOf(site.url);
  const ownNiche = parseNiche(site.backlinkNiche);

  const rows = await db.siteBacklink.findMany({
    where: { siteId },
    select: CLASSIFY_SELECT,
  });

  // Group by donor; rows without a domain stay untouched (they cannot be donor-classified).
  const byDonor = new Map<string, DonorLink[]>();
  for (const r of rows) {
    const domain = String(r.domainFrom ?? "").toLowerCase();
    if (!domain) continue;
    const list = byDonor.get(domain) ?? [];
    list.push({
      apiAnchor: String(r.apiAnchor ?? ""),
      checkAnchor: String(r.checkAnchor ?? ""),
      pageTitle: String(r.pageTitle ?? ""),
      apiSnippet: String(r.apiSnippet ?? ""),
      apiDr: r.apiDr == null ? null : Number(r.apiDr),
      apiContent: !!r.apiContent,
    });
    byDonor.set(domain, list);
  }

  // Previous state, for the "new toxic" diff and the first-run test.
  let everChecked = false;
  const prevLevel = new Map<string, string>();
  for (const r of rows) {
    if (r.toxCheckedAt) everChecked = true;
    const domain = String(r.domainFrom ?? "").toLowerCase();
    if (!domain) continue;
    const level = String(r.toxLevel ?? "unknown");
    const rank = TOX_LEVEL_ORDER[level as ToxLevel] ?? 0;
    if (rank >= (TOX_LEVEL_ORDER[(prevLevel.get(domain) ?? "unknown") as ToxLevel] ?? 0)) {
      prevLevel.set(domain, level);
    }
  }

  const verdicts = [...byDonor.entries()].map(([domain, links]) =>
    classifyDonor({ domainFrom: domain, links, ownNiche, siteDomain }),
  );

  // Deep check: suspicious donors only, worst score first, capped.
  const deepLimit = Math.max(0, Math.min(DEEP_CHECK_MAX, Math.floor(opts.deepLimit ?? 0)));
  let deepChecked = 0;
  let deepFailed = 0;
  if (deepLimit > 0) {
    const suspicious = verdicts
      .filter((v) => v.level === "suspicious")
      .sort((a, b) => b.score - a.score)
      .slice(0, deepLimit);
    for (const v of suspicious) {
      const url = `https://${v.domainFrom}/`;
      try {
        const res = await fetchDonorPage(url);
        if (res.kind !== "ok" || !res.body) {
          deepFailed++;
          continue;
        }
        const deep = classifyDonor({
          domainFrom: v.domainFrom,
          links: byDonor.get(v.domainFrom) ?? [],
          ownNiche,
          siteDomain,
          deepTitle: extractTitle(res.body),
          deepText: extractTextSample(res.body),
        });
        // Deep evidence only ever *adds* signals to the local verdict (same donor, same rows);
        // a fetched page that says nothing must not clear a local suspicion.
        v.level = deep.level;
        v.score = Math.max(v.score, deep.score);
        v.signals = [...new Set([...v.signals, ...deep.signals])];
        deepChecked++;
      } catch {
        deepFailed++;
      }
    }
  }

  // Persist: one verdict covers every row of the donor.
  const now = new Date();
  const writes = verdicts.map((v) => ({
    where: { siteId, domainFrom: v.domainFrom },
    data: {
      toxLevel: v.level,
      toxScore: Math.round(v.score),
      toxSignals: JSON.stringify(v.signals),
      toxCheckedAt: now,
    },
  }));
  for (let i = 0; i < writes.length; i += WRITE_SLICE) {
    const slice = writes.slice(i, i + WRITE_SLICE);
    await db.$transaction(slice.map((w) => db.siteBacklink.updateMany(w)));
  }

  const levels: Record<ToxLevel, number> = { clean: 0, suspicious: 0, toxic: 0, unknown: 0 };
  for (const v of verdicts) levels[v.level]++;

  const firstRun = !everChecked;
  const newToxic = firstRun
    ? []
    : verdicts
        .filter((v) => v.level === "toxic" && prevLevel.get(v.domainFrom) !== "toxic")
        .map((v) => v.domainFrom);

  let notified = false;
  if (opts.notify !== false && newToxic.length > 0) {
    notified = await alertNewToxic({ userId: site.userId, siteId, siteDomain, newToxic });
  }

  return {
    donors: verdicts.length,
    rows: rows.length,
    levels,
    firstRun,
    deepChecked,
    deepFailed,
    newToxic,
    notified,
  };
}

/** One alert per site per UTC day, deduped by AlertEvent's unique dedupeKey (brief §2). */
async function alertNewToxic(args: { userId: string; siteId: string; siteDomain: string; newToxic: string[] }): Promise<boolean> {
  const { userId, siteId, siteDomain, newToxic } = args;
  const day = new Date().toISOString().slice(0, 10);
  const dedupeKey = `toxic:${siteId}:${day}`;
  let title = "";
  let message = "";
  try {
    const settings = await getAlertSettings(userId);
    const L = NOTIFY_L[settings.lang];
    const lines = newToxic.slice(0, 10).map((d) => `• ${d}`).join("\n");
    title = L.toxicNewTitle(siteDomain);
    message = L.toxicNewMsg(siteDomain, newToxic.length, lines);
  } catch {
    return false; // settings unreadable — no alert rather than an unlabelled one
  }
  try {
    await db.alertEvent.create({
      data: { userId, type: "toxic_new", siteId, title, message, dedupeKey },
    });
  } catch {
    return false; // duplicate — this day's alert already went out
  }
  const ok = await notifyUser(userId, `${title}\n\n${message}`, { event: "alert" });
  if (ok) {
    try {
      await db.alertEvent.updateMany({ where: { userId, dedupeKey }, data: { sent: true } });
    } catch { /* best effort */ }
  }
  return ok;
}

// ─── overview (GET toxicity) ───────────────────────────────────────────────────

export interface DonorOverviewRow {
  domainFrom: string;
  links: number;
  level: ToxLevel;
  score: number;
  signals: string[];
  dr: number | null;
  disavowMarked: number;
}

export interface ToxicityOverview {
  niche: string[];
  suggested: string[];
  levels: Record<ToxLevel, number>;
  donors: number;
  overOpt: { checked: number; exact: number; pct: number; over: boolean };
  donorRows: DonorOverviewRow[];
  lastRun: string | null;
  notMigrated?: true;
}

function parseSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function readToxicityOverview(siteId: string): Promise<ToxicityOverview> {
  const [niche, suggested] = await Promise.all([readNiche(siteId), suggestNicheFromSite(siteId)]);
  let siteUrl = "";
  try {
    const site = await db.site.findUnique({ where: { id: siteId }, select: { url: true } });
    siteUrl = site?.url ?? "";
  } catch { /* niche read already handled */ }

  const rows = await db.siteBacklink.findMany({
    where: { siteId },
    select: {
      domainFrom: true, apiAnchor: true, toxLevel: true, toxScore: true, toxSignals: true,
      toxCheckedAt: true, apiDr: true, disavow: true,
    },
  });

  const levels: Record<ToxLevel, number> = { clean: 0, suspicious: 0, toxic: 0, unknown: 0 };
  interface Acc {
    domain: string; links: number; level: ToxLevel; score: number; signals: Set<string>;
    dr: number | null; disavowMarked: number; checkedAt: Date | null;
  }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const domain = String(r.domainFrom ?? "").toLowerCase();
    if (!domain) continue;
    const level = (["clean", "suspicious", "toxic", "unknown"].includes(String(r.toxLevel))
      ? String(r.toxLevel) : "unknown") as ToxLevel;
    const entry = acc.get(domain) ?? {
      domain, links: 0, level: "unknown", score: 0, signals: new Set<string>(), dr: null,
      disavowMarked: 0, checkedAt: null,
    };
    entry.links++;
    if (r.disavow) entry.disavowMarked++;
    if (r.apiDr != null) entry.dr = Math.max(entry.dr ?? 0, Number(r.apiDr));
    if ((TOX_LEVEL_ORDER[level] ?? 0) >= (TOX_LEVEL_ORDER[entry.level] ?? 0)) entry.level = level;
    entry.score = Math.max(entry.score, Number(r.toxScore ?? 0));
    for (const s of parseSignals(r.toxSignals)) entry.signals.add(s);
    if (r.toxCheckedAt && (!entry.checkedAt || new Date(r.toxCheckedAt) > entry.checkedAt)) {
      entry.checkedAt = new Date(r.toxCheckedAt);
    }
    acc.set(domain, entry);
  }
  for (const e of acc.values()) levels[e.level]++;

  const overOpt = overOptimization(
    rows.map((r) => String(r.apiAnchor ?? "")),
    siteHostOf(siteUrl),
  );

  const donorRows: DonorOverviewRow[] = [...acc.values()]
    .sort((a, b) =>
      (TOX_LEVEL_ORDER[b.level] ?? 0) - (TOX_LEVEL_ORDER[a.level] ?? 0) ||
      b.score - a.score ||
      b.links - a.links)
    .slice(0, OVERVIEW_DONOR_CAP)
    .map((e) => ({
      domainFrom: e.domain,
      links: e.links,
      level: e.level,
      score: e.score,
      signals: [...e.signals],
      dr: e.dr,
      disavowMarked: e.disavowMarked,
    }));

  const lastRun = rows.reduce<Date | null>((latest, r) => {
    if (!r.toxCheckedAt) return latest;
    const at = new Date(r.toxCheckedAt);
    return !latest || at > latest ? at : latest;
  }, null);

  return {
    niche,
    suggested,
    levels,
    donors: acc.size,
    overOpt,
    donorRows,
    lastRun: lastRun ? lastRun.toISOString() : null,
  };
}

// ─── disavow ───────────────────────────────────────────────────────────────────

export interface DisavowFileResult {
  fileName: string;
  text: string;
  donors: number;
  links: number;
}

/** The marked rows of a site rendered into Google's disavow format. */
export async function buildDisavowForSite(siteId: string, mode: DisavowMode): Promise<DisavowFileResult> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { url: true } });
  const host = siteHostOf(site?.url ?? "") || "site";

  const marked = await db.siteBacklink.findMany({
    where: { siteId, disavow: true },
    select: { urlFrom: true, domainFrom: true, disavowNote: true, toxLevel: true, toxSignals: true },
  });
  const domains = [...new Set(marked.map((r) => String(r.domainFrom ?? "").toLowerCase()).filter(Boolean))];
  const totals = domains.length
    ? await db.siteBacklink.groupBy({
        by: ["domainFrom"],
        where: { siteId, domainFrom: { in: domains } },
        _count: { _all: true },
      })
    : [];
  const totalByDonor = new Map<string, number>(
    totals.map((t) => [String(t.domainFrom ?? "").toLowerCase(), Number(t._count._all)]),
  );

  const byDonor = new Map<string, DisavowLink[]>();
  for (const r of marked) {
    const domain = String(r.domainFrom ?? "").toLowerCase();
    if (!domain) continue;
    const list = byDonor.get(domain) ?? [];
    list.push({
      id: "",
      urlFrom: String(r.urlFrom ?? ""),
      domainFrom: domain,
      disavow: true,
      disavowNote: String(r.disavowNote ?? ""),
      toxLevel: String(r.toxLevel ?? "unknown"),
      toxSignals: parseSignals(r.toxSignals),
    });
    byDonor.set(domain, list);
  }

  const donors: DisavowDonor[] = [...byDonor.entries()].map(([domain, links]) => ({
    domain,
    marked: links,
    total: totalByDonor.get(domain) ?? links.length,
  }));

  return {
    fileName: disavowFileName(host),
    text: buildDisavowFile(host, donors, { mode }),
    donors: donors.length,
    links: marked.length,
  };
}

export interface DisavowPatch {
  ids?: string[];
  domains?: string[];
  allToxic?: boolean;
  disavow: boolean;
  note?: string;
}

/**
 * The operator's mark — the ONLY writer of the `disavow` flag in the codebase. Selection by row
 * ids (contract shape), by donor domains (the UI marks whole donors) or "all currently toxic"
 * for the bulk button.
 */
export async function setDisavow(siteId: string, patch: DisavowPatch): Promise<number> {
  const where: Record<string, unknown> = { siteId };
  if (patch.allToxic) {
    where.toxLevel = "toxic";
  } else if (patch.domains?.length) {
    where.domainFrom = { in: patch.domains.map((d) => String(d).toLowerCase()) };
  } else if (patch.ids?.length) {
    where.id = { in: patch.ids };
  } else {
    throw new Error("ids_or_domains_required");
  }
  const data: Record<string, unknown> = { disavow: patch.disavow === true };
  if (typeof patch.note === "string") data.disavowNote = patch.note.slice(0, 500);
  const res = await db.siteBacklink.updateMany({ where, data });
  return Number(res?.count ?? 0);
}

// ─── recovery ──────────────────────────────────────────────────────────────────

/** Clicks per URL over the last 28 days (searchType "web", per-page rows; rollups have url=""
 *  and are excluded by the url filter). Keyed by the stored URL and by its path, because
 *  SiteBacklink.urlTo and GSC's page URL are two spellings of the same page. */
async function clicksByUrlLast28d(siteId: string, urls: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const clean = [...new Set(urls.map((u) => String(u ?? "").trim()).filter(Boolean))];
  if (!clean.length) return out;
  try {
    const since = new Date(Date.now() - 28 * 86_400_000);
    const grouped = await db.dailyMetric.groupBy({
      by: ["url"],
      where: { siteId, url: { in: clean }, date: { gte: since }, searchType: "web" },
      _sum: { clicks: true },
    });
    for (const g of grouped) {
      const clicks = Number(g._sum?.clicks ?? 0);
      out.set(g.url, clicks);
      try {
        const path = new URL(g.url).pathname;
        if (path && path !== "/") out.set(path, Math.max(out.get(path) ?? 0, clicks));
      } catch { /* not a URL — exact key only */ }
    }
  } catch {
    // not migrated / no metrics — every target is worth its base value, not zero
  }
  return out;
}

export async function readRecovery(siteId: string): Promise<RecoveryRow[]> {
  const since = new Date(Date.now() - RECOVERY_EVENT_WINDOW_DAYS * 86_400_000);
  // Events first: a row lost ONLY by a rel_downgrade event (apiLost false, check found,
  // target fine) is invisible to the row-level OR below — the event is its only witness.
  const events = await db.siteBacklinkEvent
    .findMany({
      where: { siteId, kind: { in: ["lost", "rel_downgraded"] }, createdAt: { gte: since } },
      select: { backlinkId: true, kind: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 20000,
    })
    .catch(() => [] as { backlinkId: string; kind: string; createdAt: Date }[]);
  const downgradedIds = [...new Set(events.filter((e) => e.kind === "rel_downgraded").map((e) => e.backlinkId))];

  const rows = await db.siteBacklink.findMany({
    where: {
      siteId,
      OR: [
        { apiLost: true },
        { checkStatus: "missing" },
        { checkTargetOk: false },
        ...(downgradedIds.length ? [{ id: { in: downgradedIds } }] : []),
      ],
    },
    select: {
      id: true, urlFrom: true, domainFrom: true, urlTo: true, apiAnchor: true, apiDr: true,
      apiContent: true, apiDofollow: true, apiNofollow: true, apiSponsored: true,
      apiHttpCode: true, apiLost: true, checkStatus: true, checkNofollow: true,
      checkSponsored: true, checkTargetOk: true, pageStatus: true, favorite: true, checkedAt: true,
    },
    take: 5000,
  });
  if (!rows?.length) return [];

  // Latest loss date and the rel-downgrade flag, per row.
  const lostAt = new Map<string, string>();
  const downgraded = new Set<string>();
  for (const e of events) {
    const iso = new Date(e.createdAt).toISOString();
    lostAt.set(e.backlinkId, iso); // asc order → last write wins = latest
    if (e.kind === "rel_downgraded") downgraded.add(e.backlinkId);
  }

  const clicks = await clicksByUrlLast28d(
    siteId,
    rows.map((r) => String(r.urlTo ?? "")),
  );
  const clicksOf = (urlTo: string): number => {
    if (clicks.has(urlTo)) return clicks.get(urlTo)!;
    try {
      return clicks.get(new URL(urlTo).pathname) ?? 0;
    } catch {
      return 0;
    }
  };

  const inputs: RecoveryInput[] = rows.map((r) => ({
    id: r.id,
    urlFrom: String(r.urlFrom ?? ""),
    domainFrom: String(r.domainFrom ?? ""),
    urlTo: String(r.urlTo ?? ""),
    apiAnchor: String(r.apiAnchor ?? ""),
    apiDr: r.apiDr == null ? null : Number(r.apiDr),
    apiContent: !!r.apiContent,
    apiDofollow: !!r.apiDofollow,
    apiNofollow: !!r.apiNofollow,
    apiSponsored: !!r.apiSponsored,
    apiHttpCode: r.apiHttpCode == null ? null : Number(r.apiHttpCode),
    apiLost: !!r.apiLost,
    checkStatus: String(r.checkStatus ?? "unchecked"),
    checkNofollow: !!r.checkNofollow,
    checkSponsored: !!r.checkSponsored,
    checkTargetOk: r.checkTargetOk == null ? null : !!r.checkTargetOk,
    pageStatus: String(r.pageStatus ?? "unknown"),
    favorite: !!r.favorite,
    lostAt: lostAt.get(r.id) ?? (r.checkedAt ? new Date(r.checkedAt).toISOString() : null),
    relDowngraded: downgraded.has(r.id),
    targetClicks28: clicksOf(String(r.urlTo ?? "")),
  }));

  return rankRecovery(inputs).slice(0, RECOVERY_ROW_CAP);
}

// ─── scheduler support ─────────────────────────────────────────────────────────

/**
 * Sites whose toxicity is stale: rows with toxCheckedAt null (never classified — a CSV import
 * counts), or checked before the site's last finished sync (new donors arrived with it).
 * Returns up to `limit` per tick, so one pass can never monopolize the hour.
 */
export async function staleToxSites(limit = 5): Promise<{ id: string; userId: string }[]> {
  const groups = await db.siteBacklink
    .groupBy({ by: ["siteId"], _count: { _all: true } })
    .catch(() => [] as { siteId: string }[]);
  const candidates = groups.map((g) => g.siteId).slice(0, Math.max(1, limit) * 4);
  if (!candidates.length) return [];
  const sites = await db.site
    .findMany({ where: { id: { in: candidates } }, select: { id: true, userId: true } })
    .catch(() => [] as { id: string; userId: string }[]);
  const out: { id: string; userId: string }[] = [];
  for (const site of sites.slice(0, Math.max(1, limit) * 4)) {
    if (out.length >= limit) break;
    if (await isSiteToxStale(site.id)) out.push(site);
  }
  return out;
}

/** The recalc condition of brief §2: rows never checked, or checked before the last sync. */
export async function isSiteToxStale(siteId: string): Promise<boolean> {
  const never = await db.siteBacklink.findFirst({
    where: { siteId, toxCheckedAt: null },
    select: { id: true },
  }).catch(() => null);
  if (never) return true;
  const lastSync = await db.siteBacklinkSync.findFirst({
    where: { siteId, status: "completed" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  }).catch(() => null);
  if (!lastSync?.finishedAt) return false;
  const staleRow = await db.siteBacklink.findFirst({
    where: { siteId, toxCheckedAt: { lt: new Date(lastSync.finishedAt) } },
    select: { id: true },
  }).catch(() => null);
  return !!staleRow;
}
