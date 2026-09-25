// Brand mentions — the only module of the feature that owns queries (T6). Routes, the
// scheduler and the MCP tool all read and write through here, so the invariants live once:
//
//   - every function that takes a userId first verifies the site (or row's site) belongs to
//     that user — a foreign id is indistinguishable from a missing one;
//   - `on: false` and a null mentionSettings both mean "off": runMentions returns zeros, the
//     feed keeps whatever history is already stored;
//   - hits pass the matchesTerm/isExcluded gate BEFORE saving — unparsed noise never reaches
//     the table, so the feed needs no bulk-cleanup path;
//   - inserts read existing (source, urlKey) keys first and split into insert/skip —
//     createMany({ skipDuplicates }) does not exist on SQLite (README §5);
//   - statement parameter lists stay ≤ 400 (chunks of 20 rows × ~14 fields);
//   - a missing BrandMention table surfaces as { notMigrated: true }, never a 500.
//
// Google News redirect links are stored AS-IS. Expanding them costs a request to Google per
// mention per day and reads like bot traffic; the real article URL is resolved only by
// checkMentionLink, on the user's click.

import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import { getAlertSettings } from "@/lib/alertScheduler";
import { defaultLanguageFor } from "@/lib/seo/regions";
import { safeFetch } from "@/lib/security/safeFetch";
import { deriveTerms, isExcluded, matchesTerm, normalizeMentionUrl } from "./parse";
import { fetchNews, fetchWikipedia, fetchWikidata } from "./sources";
import {
  DEFAULT_MENTION_SOURCES,
  type MentionHit,
  type MentionLinkStatus,
  type MentionQuery,
  type MentionRow,
  type MentionSettings,
  type MentionSource,
  type MentionTerm,
} from "./types";

const SOURCE_SET = new Set<string>(DEFAULT_MENTION_SOURCES);
const NOTIFY_MAX_LINES = 8;
const INSERT_CHUNK = 20; // rows per createMany — ~14 params each, well under SQLite's 999

/** P2021 or the SQLite "no such table" text — the pulled-but-not-pushed window (README §5). */
export function mentionsSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /BrandMention.*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseSettings(raw: string | null): Partial<MentionSettings> | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === "object" ? (s as Partial<MentionSettings>) : null;
  } catch {
    return null;
  }
}

async function ownedSite(
  userId: string,
  siteDbId: string,
): Promise<{ id: string; url: string; market: string | null; brandedKeywords: string | null; mentionSettings: string | null }> {
  const site = await prisma.site.findFirst({
    where: { id: siteDbId, userId },
    select: { id: true, url: true, market: true, brandedKeywords: true, mentionSettings: true },
  });
  if (!site) throw new Error("site_not_found");
  return site;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getMentionSettings(userId: string, siteDbId: string): Promise<MentionSettings> {
  const site = await ownedSite(userId, siteDbId);
  const stored = parseSettings(site.mentionSettings);
  return {
    on: stored?.on ?? false,
    terms: Array.isArray(stored?.terms) ? stored.terms : [],
    exclude: Array.isArray(stored?.exclude) ? stored.exclude : [],
    sources: filterSources(stored?.sources),
    // Market, not a hardcoded "en": the market map already knows the language of the audience
    // that would be writing about this brand.
    lang: stored?.lang || defaultLanguageFor(site.market ?? ""),
    country: stored?.country || site.market || "us",
    notify: stored?.notify ?? true,
    lastRunAt: stored?.lastRunAt ?? null,
  };
}

function filterSources(raw: unknown): MentionSource[] {
  const list = Array.isArray(raw) ? raw : [];
  const kept = list.filter((s): s is MentionSource => typeof s === "string" && SOURCE_SET.has(s));
  return kept.length ? kept : [...DEFAULT_MENTION_SOURCES];
}

const cleanTermPhrase = (v: unknown): string => String(v ?? "").trim().slice(0, 120);

function cleanTerm(t: unknown): MentionTerm | null {
  if (!t || typeof t !== "object") return null;
  const term = cleanTermPhrase((t as MentionTerm).term);
  if (Array.from(term).length < 2) return null;
  const mustInclude = (Array.isArray((t as MentionTerm).mustInclude) ? (t as MentionTerm).mustInclude : [])
    .map(w => String(w).trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 10);
  return { term, mustInclude };
}

export async function saveMentionSettings(userId: string, siteDbId: string, s: MentionSettings): Promise<void> {
  const site = await ownedSite(userId, siteDbId);
  const prev = parseSettings(site.mentionSettings);
  const terms = (Array.isArray(s?.terms) ? s.terms : [])
    .map(cleanTerm)
    .filter((t): t is MentionTerm => !!t)
    .slice(0, 20);
  const exclude = (Array.isArray(s?.exclude) ? s.exclude : [])
    .map(w => String(w).trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 50);
  const next: MentionSettings = {
    on: !!s?.on,
    terms,
    exclude,
    sources: filterSources(s?.sources),
    lang: String(s?.lang || "en").toLowerCase().slice(0, 8),
    country: String(s?.country || "us").toLowerCase().slice(0, 2),
    notify: !!s?.notify,
    lastRunAt: prev?.lastRunAt ?? null, // a settings edit is not a run
  };
  await prisma.site.update({ where: { id: site.id }, data: { mentionSettings: JSON.stringify(next) } });
}

// ── Run ───────────────────────────────────────────────────────────────────────

/**
 * urlKey for a hit. Wikidata rows fold the entity revision into the key (…?rev=<lastrevid>),
 * because the entity page URL never changes — the rev is what makes an edit surface as a new
 * row while the previous row stays as history.
 */
function mentionUrlKey(h: MentionHit): string {
  if (h.source === "wikidata") {
    const rev = h.snippet.match(/^rev:(\d+)/)?.[1];
    if (rev) return normalizeMentionUrl(`${h.url}?rev=${rev}`);
  }
  return normalizeMentionUrl(h.url);
}

export async function runMentions(
  userId: string,
  siteDbId: string,
): Promise<{ found: number; inserted: number; errors: string[] }> {
  const site = await ownedSite(userId, siteDbId);
  const stored = parseSettings(site.mentionSettings);
  if (!stored?.on) return { found: 0, inserted: 0, errors: [] };

  const host = hostOf(site.url);
  const terms: MentionTerm[] = (
    Array.isArray(stored.terms) && stored.terms.length ? stored.terms : deriveTerms(site.brandedKeywords, host)
  ).slice(0, 20);
  const exclude = Array.isArray(stored.exclude) ? stored.exclude : [];
  const sources = filterSources(stored.sources);
  const lang = stored.lang || defaultLanguageFor(site.market ?? "");
  const country = stored.country || site.market || "us";
  const firstRun = !stored.lastRunAt;
  const errors: string[] = [];

  const hits: MentionHit[] = [];
  if (sources.includes("news")) {
    for (const t of terms) {
      try {
        hits.push(...await fetchNews(t, lang, country));
      } catch (e) {
        errors.push(`news "${t.term}": ${errText(e)}`); // one term's failure is not the run's
      }
    }
  }
  if (sources.includes("wikipedia") && host) {
    try {
      hits.push(...await fetchWikipedia(terms, host, lang));
    } catch (e) {
      errors.push(errText(e));
    }
  }
  if (sources.includes("wikidata") && host && terms.length) {
    try {
      hits.push(...await fetchWikidata(host, terms[0].term));
    } catch (e) {
      errors.push(`wikidata: ${errText(e)}`);
    }
  }

  // The noise gate. "mention" hits must match the term at a word boundary (with mustInclude
  // context when configured); "link" and "entity" hits are matched by the host itself at the
  // source — a Wikipedia page linking to the domain IS the match — so only exclude applies.
  const termsByPhrase = new Map(terms.map(t => [t.term, t]));
  const passing = hits.filter(h => {
    if (isExcluded(h, exclude)) return false;
    if (h.kind !== "mention") return true;
    const t = termsByPhrase.get(h.term);
    return t ? matchesTerm(`${h.title} ${h.snippet}`, t) : false;
  });

  const existingKeys = new Set(
    (await prisma.brandMention.findMany({
      where: { siteId: site.id },
      select: { source: true, urlKey: true },
    })).map(r => `${r.source}|${r.urlKey}`),
  );
  const runStartedAt = new Date();
  const seen = new Set(existingKeys);
  const fresh: {
    source: MentionSource; kind: string; term: string; url: string; urlKey: string;
    title: string; snippet: string; publisher: string; lang: string; publishedAt: Date | null;
  }[] = [];
  for (const h of passing) {
    const urlKey = mentionUrlKey(h);
    const key = `${h.source}|${urlKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      source: h.source,
      kind: h.kind,
      term: h.term.slice(0, 120),
      url: h.url.slice(0, 500),
      urlKey,
      title: h.title.slice(0, 300),
      snippet: h.snippet.slice(0, 300),
      publisher: h.publisher.slice(0, 200),
      lang: h.lang.slice(0, 8),
      publishedAt: h.publishedAt ? new Date(h.publishedAt) : null,
    });
  }
  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    await prisma.brandMention.createMany({
      data: fresh.slice(i, i + INSERT_CHUNK).map(r => ({ ...r, siteId: site.id })),
    });
  }

  await prisma.site.update({
    where: { id: site.id },
    data: { mentionSettings: JSON.stringify({ ...stored, lastRunAt: runStartedAt.toISOString() }) },
  });

  if (!firstRun && stored.notify !== false && fresh.length) {
    try {
      await notifyAboutRows(userId, host || site.url, site.id, runStartedAt, fresh);
    } catch (e) {
      console.warn(`[mentions] notify for site ${site.id} failed:`, e);
    }
  }

  return { found: passing.length, inserted: fresh.length, errors };
}

/** One message per site per run: title + up to 8 "Publisher — title" lines, then stamp notifiedAt. */
async function notifyAboutRows(
  userId: string,
  siteLabel: string,
  siteDbId: string,
  runStartedAt: Date,
  fresh: { publisher: string; title: string; source: MentionSource }[],
): Promise<void> {
  const alertSettings = await getAlertSettings(userId);
  const L = NOTIFY_L[normalizeLang(alertSettings.lang)];
  const lines = fresh
    .slice(0, NOTIFY_MAX_LINES)
    .map(r => `${r.publisher || r.source} — ${r.title}`)
    .join("\n");
  const text = L.mentionsNotifyMsg(siteLabel, fresh.length, lines);
  await notifyUser(userId, text, { event: "mention", title: L.mentionsNotifyTitle(siteLabel) });

  await prisma.brandMention.updateMany({
    where: { siteId: siteDbId, notifiedAt: null, firstSeenAt: { gte: runStartedAt } },
    data: { notifiedAt: new Date() },
  });
}

// ── Feed ──────────────────────────────────────────────────────────────────────

function toRow(r: {
  id: string; source: string; kind: string; term: string; url: string; title: string; snippet: string;
  publisher: string; lang: string; publishedAt: Date | null; firstSeenAt: Date;
  linkStatus: string; reviewed: boolean; dismissed: boolean;
}): MentionRow {
  return {
    id: r.id,
    source: r.source as MentionRow["source"],
    kind: r.kind as MentionRow["kind"],
    term: r.term,
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    publisher: r.publisher,
    lang: r.lang,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    firstSeenAt: r.firstSeenAt.toISOString(),
    linkStatus: r.linkStatus as MentionLinkStatus,
    reviewed: r.reviewed,
    dismissed: r.dismissed,
  };
}

export async function listMentions(
  userId: string,
  siteDbId: string,
  q: MentionQuery,
): Promise<{ total: number; rows: MentionRow[] } | { notMigrated: true }> {
  await ownedSite(userId, siteDbId); // ownership first: a foreign site must look like empty, not 403-with-data
  const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 50) || 50));
  const offset = Math.max(0, Math.floor(q.offset ?? 0) || 0);

  const where = {
    siteId: siteDbId,
    ...(q.source && q.source !== "all" ? { source: q.source } : {}),
    ...(q.linkStatus && q.linkStatus !== "all" ? { linkStatus: q.linkStatus } : {}),
    ...(q.state === "reviewed" ? { reviewed: true, dismissed: false }
      : q.state === "dismissed" ? { dismissed: true }
      : q.state === "new" ? { reviewed: false, dismissed: false }
      : {}),
    ...(q.q ? { OR: [{ title: { contains: q.q } }, { snippet: { contains: q.q } }, { publisher: { contains: q.q } }] } : {}),
  };

  try {
    const [total, rows] = await Promise.all([
      prisma.brandMention.count({ where }),
      prisma.brandMention.findMany({ where, orderBy: { firstSeenAt: "desc" }, take: limit, skip: offset }),
    ]);
    return { total, rows: rows.map(toRow) };
  } catch (e) {
    if (mentionsSchemaMissing(e)) return { notMigrated: true };
    throw e;
  }
}

export async function updateMention(
  userId: string,
  id: string,
  patch: { reviewed?: boolean; dismissed?: boolean },
): Promise<void> {
  const row = await prisma.brandMention.findFirst({ where: { id, site: { userId } }, select: { id: true } });
  if (!row) throw new Error("mention_not_found");
  await prisma.brandMention.update({
    where: { id },
    data: {
      ...(typeof patch.reviewed === "boolean" ? { reviewed: patch.reviewed } : {}),
      ...(typeof patch.dismissed === "boolean" ? { dismissed: patch.dismissed } : {}),
    },
  });
}

/** One owned row, shaped for the outreach route (which needs the site label and the row's evidence). */
export async function mentionForOutreach(
  userId: string,
  id: string,
): Promise<{
  source: MentionSource; url: string; title: string; publisher: string;
  publishedAt: string | null; firstSeenAt: string; linkStatus: MentionLinkStatus;
  siteHost: string;
} | null> {
  const row = await prisma.brandMention.findFirst({
    where: { id, site: { userId } },
    select: {
      source: true, url: true, title: true, publisher: true,
      publishedAt: true, firstSeenAt: true, linkStatus: true,
      site: { select: { url: true } },
    },
  });
  if (!row) return null;
  return {
    source: row.source as MentionSource,
    url: row.url,
    title: row.title,
    publisher: row.publisher,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    linkStatus: row.linkStatus as MentionLinkStatus,
    siteHost: hostOf(row.site.url),
  };
}

// ── Link check ────────────────────────────────────────────────────────────────

const GOOGLE_NEWS_HOST_RE = /(^|\.)news\.google\.com$/i;

/**
 * Resolve the article behind a mention and look for a link to the site's host (or a
 * subdomain). News rows first follow the Google redirect — a user action, so the extra
 * request is accounted for. The expanded URL replaces `url`; `urlKey` keeps the redirect
 * shape so dedupe history stays stable. Failures and timeouts are a status ("unreachable"),
 * not an error — the row keeps its previous linkStatus only on a hard error before any fetch.
 */
export async function checkMentionLink(userId: string, id: string): Promise<MentionLinkStatus> {
  const row = await prisma.brandMention.findFirst({
    where: { id, site: { userId } },
    select: { id: true, source: true, url: true, site: { select: { url: true } } },
  });
  if (!row) throw new Error("mention_not_found");
  const host = hostOf(row.site.url);
  if (!host) throw new Error("site_url_invalid");

  let articleUrl = row.url;
  if (row.source === "news" && GOOGLE_NEWS_HOST_RE.test(hostOfUrlLoose(articleUrl))) {
    articleUrl = (await expandGoogleNewsLink(articleUrl)) ?? articleUrl;
  }

  let html: string;
  try {
    const res = await safeFetch(articleUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenGSC; +https://seogets.net.ru)" },
      timeoutMs: 20_000,
      maxBytes: 3 * 1024 * 1024,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    html = await res.text();
  } catch {
    await prisma.brandMention.update({
      where: { id },
      data: { linkStatus: "unreachable", linkCheckedAt: new Date() },
    });
    return "unreachable";
  }

  const status: MentionLinkStatus = htmlLinksToHost(html, host) ? "linked" : "unlinked";
  await prisma.brandMention.update({
    where: { id },
    data: {
      linkStatus: status,
      linkCheckedAt: new Date(),
      // Keep the key stable: the dedupe key stays the Google redirect / original URL.
      ...(articleUrl !== row.url ? { url: articleUrl.slice(0, 500) } : {}),
    },
  });
  return status;
}

function hostOfUrlLoose(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Follow the news.google.com redirect with safeFetch(redirect: "follow"). When Google answers
 * with an HTML interstitial instead of an HTTP redirect (the c-wizard page), the target URL is
 * embedded in it as data-n-au="…" or the first non-Google <a href>.
 */
async function expandGoogleNewsLink(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenGSC; +https://seogets.net.ru)" },
      timeoutMs: 15_000,
      maxBytes: 1024 * 1024,
      redirect: "follow",
    });
    const final = hostOfUrlLoose(res.url);
    if (final && !GOOGLE_NEWS_HOST_RE.test(final)) return res.url;

    const body = await res.text();
    const attr = body.match(/data-n-au="([^"]+)"/)?.[1]
      ?? [...body.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)]
        .map(m => m[1])
        .find(h => !GOOGLE_NEWS_HOST_RE.test(hostOfUrlLoose(h.replace(/&amp;/g, "&"))));
    if (attr) {
      const decoded = attr.replace(/&amp;/g, "&");
      const h = hostOfUrlLoose(decoded);
      if (h && !GOOGLE_NEWS_HOST_RE.test(h)) return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

/** Any <a href> pointing at the host or a subdomain of it (absolute URLs; protocols http/https). */
export function htmlLinksToHost(html: string, host: string): boolean {
  const want = host.toLowerCase();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*"(https?:\/\/[^"\s]+)"/gi)) {
    const target = hostOfUrlLoose(m[1]);
    if (!target) continue;
    if (target === want || target === `www.${want}` || target.endsWith(`.${want}`)) return true;
  }
  return false;
}
