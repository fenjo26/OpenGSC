// Brand mentions — the three free sources (T6): Google News RSS, Wikipedia search +
// exturlusage, Wikidata entities. All HTTP goes through safeFetch (README §5): nothing here
// targets a user-supplied URL, but the rule is absolute, and safeFetch also gives the
// timeouts, size caps and redirect handling these parsers rely on.
//
// The response parsers are exported and pure so tests can run them over real fixtures in
// ./__fixtures__/ without any network.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeFetch } from "@/lib/security/safeFetch";
import { parseGoogleNewsRss, stripHtml } from "./parse";
import type { MentionHit, MentionTerm } from "./types";

const NEWS_PAUSE_MS = 2_000;           // between Google News terms — politeness floor, per brief
const FETCH_TIMEOUT_MS = 20_000;
const MAX_NEWS_HITS_PER_TERM = 100;    // the feed itself caps at ~100 items

let lastNewsFetchAt = 0;

/** Version for the Wikimedia User-Agent (their API etiquette asks for an identifiable client). */
function appVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version || "dev");
  } catch {
    return "dev";
  }
}

function wikimediaUa(contactHost: string): string {
  return `OpenGSC/${appVersion()} (+https://opengsc.org; root@${contactHost || "opengsc.org"})`;
}

async function getJson(url: string, ua: string): Promise<unknown> {
  const res = await safeFetch(url, {
    headers: { "User-Agent": ua, Accept: "application/json" },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: 2 * 1024 * 1024,
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

// ── Google News RSS ───────────────────────────────────────────────────────────

/**
 * One quoted term over the last 7 days. The 7-day window with a daily run loses nothing and
 * keeps the feed small; duplicates across runs are killed by urlKey in the store.
 *
 * The ≥2 s pause between terms is enforced here rather than in the caller so that no future
 * call site can accidentally hammer Google.
 */
export async function fetchNews(t: MentionTerm, lang: string, country: string): Promise<MentionHit[]> {
  const wait = lastNewsFetchAt + NEWS_PAUSE_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastNewsFetchAt = Date.now();

  const gl = (country || "us").toUpperCase();
  const q = `"${t.term}" when:7d`;
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
    `&hl=${encodeURIComponent(lang || "en")}&gl=${gl}&ceid=${gl}:${encodeURIComponent(lang || "en")}`;

  const res = await safeFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenGSC; +https://seogets.net.ru)" },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: 4 * 1024 * 1024,
    redirect: "follow",
  });
  // A failed term must not fail the run: the caller catches per-term and records it in errors.
  if (!res.ok) throw new Error(`google news http ${res.status}`);

  const hits = parseGoogleNewsRss(await res.text(), t.term, lang || "en");
  return hits.slice(0, MAX_NEWS_HITS_PER_TERM);
}

// ── Wikipedia ─────────────────────────────────────────────────────────────────

interface WikiSearchRow { title?: string; snippet?: string; timestamp?: string }
interface WikiExturlRow { title?: string; url?: string }

function wikiPageUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** list=search response → mention hits. `timestamp` is the article's last edit. */
export function parseWikiSearchResponse(data: unknown, lang: string, term: string): MentionHit[] {
  const rows = (data as { query?: { search?: WikiSearchRow[] } })?.query?.search ?? [];
  return rows
    .filter(r => r.title)
    .map(r => ({
      source: "wikipedia" as const,
      kind: "mention" as const,
      term,
      url: wikiPageUrl(lang, r.title ?? ""),
      title: r.title ?? "",
      snippet: stripHtml(r.snippet ?? "").slice(0, 300),
      publisher: "Wikipedia",
      lang,
      publishedAt: r.timestamp ?? null,
    }));
}

/** list=exturlusage response → "link" hits (Wikipedia pages linking out to the host). */
export function parseWikiExturlResponse(data: unknown, lang: string, host: string): MentionHit[] {
  const rows = (data as { query?: { exturlusage?: WikiExturlRow[] } })?.query?.exturlusage ?? [];
  return rows
    .filter(r => r.title)
    .map(r => ({
      source: "wikipedia" as const,
      kind: "link" as const, // Wikipedia links OUT to the site — the valuable find
      term: host,
      url: wikiPageUrl(lang, r.title ?? ""),
      title: r.title ?? "",
      snippet: (r.url ?? "").slice(0, 300), // the external link itself, as evidence
      publisher: "Wikipedia",
      lang,
      publishedAt: null,
    }));
}

async function wikiSearch(lang: string, term: string, ua: string): Promise<MentionHit[]> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    `&list=search&srsearch=${encodeURIComponent(`"${term}"`)}&srlimit=20&srprop=snippet%7Ctimestamp`;
  return parseWikiSearchResponse(await getJson(url, ua), lang, term);
}

async function wikiExturlusage(lang: string, host: string, ua: string): Promise<MentionHit[]> {
  const hits: MentionHit[] = [];
  for (const query of [host, `*.${host}`]) {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
      `&list=exturlusage&euquery=${encodeURIComponent(query)}&eunamespace=0&eulimit=50`;
    const data = await getJson(url, ua);
    hits.push(...parseWikiExturlResponse(data, lang, host));
  }
  return hits;
}

/**
 * Wikipedia mentions and inbound links. Searched in the site's language and in English —
 * the two Wikipedias where a brand is mentioned in practice — and deduped by page URL.
 *
 * Failures are per request, not fatal: a rate-limited language edition costs its own hits,
 * not the whole source. Only when every request failed does this throw, so runMentions can
 * record the source as errored rather than silently empty.
 */
export async function fetchWikipedia(terms: MentionTerm[], host: string, lang: string): Promise<MentionHit[]> {
  const ua = wikimediaUa(host);
  const langs = [...new Set([lang || "en", "en"])];
  const out: MentionHit[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  for (const l of langs) {
    for (const t of terms.slice(0, 10)) {
      try {
        for (const hit of await wikiSearch(l, t.term, ua)) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          out.push(hit);
        }
      } catch (e) {
        failures.push(`wikipedia ${l} "${t.term}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      for (const hit of await wikiExturlusage(l, host, ua)) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        out.push(hit);
      }
    } catch (e) {
      failures.push(`wikipedia ${l} exturlusage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!out.length && failures.length) throw new Error(failures[0]);
  return out;
}

// ── Wikidata ──────────────────────────────────────────────────────────────────

interface WbSearchRow { id?: string }

interface WbEntity {
  id?: string; lastrevid?: number;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, { mainsnak?: { snaktype?: string; datavalue?: { value?: unknown } } }[]>;
}

function hostOfUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * wbgetentities response → at most ONE entity hit: the first entity whose P856 (official
 * website) points at the site's host (www included, subdomains not — beta.openai.com is a
 * different product's page, not the company site). The entity's lastrevid rides in the
 * snippet as "rev:<id> · <description>"; the store folds that rev into the urlKey, so an edit
 * to the entity produces a different key and surfaces as a NEW row.
 */
export function parseWikidataEntities(data: unknown, host: string, name: string): MentionHit[] {
  const entities = (data as { entities?: Record<string, WbEntity> })?.entities ?? {};
  for (const entity of Object.values(entities)) {
    const p856 = entity?.claims?.P856 ?? [];
    const matches = p856.some(claim => {
      if (claim?.mainsnak?.snaktype !== "value") return false;
      const value = claim.mainsnak.datavalue?.value;
      if (typeof value !== "string") return false;
      const claimHost = hostOfUrl(value);
      return claimHost === host || claimHost === `www.${host}` || host === `www.${claimHost}`;
    });
    if (!matches || !entity.id) continue;

    const label = entity.labels?.en?.value ?? entity.id;
    const description = entity.descriptions?.en?.value ?? "";
    return [{
      source: "wikidata",
      kind: "entity",
      term: name,
      url: `https://www.wikidata.org/wiki/${entity.id}`,
      title: label,
      snippet: `rev:${entity.lastrevid ?? 0} · ${description}`.slice(0, 300),
      publisher: "Wikidata",
      lang: "en",
      publishedAt: null,
    }];
  }
  return [];
}

/**
 * The site's Wikidata entity by brand name: wbsearchentities for candidate ids, then
 * wbgetentities for claims/labels/descriptions (props include info because that is where
 * lastrevid lives).
 */
export async function fetchWikidata(host: string, name: string): Promise<MentionHit[]> {
  const ua = wikimediaUa(host);
  const searchUrl =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json` +
    `&search=${encodeURIComponent(name)}&language=en&limit=10`;
  const search = await getJson(searchUrl, ua) as { search?: WbSearchRow[] };
  const ids = (search?.search ?? []).map(r => r.id).filter((id): id is string => !!id).slice(0, 10);
  if (!ids.length) return [];

  const entitiesUrl =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json` +
    `&ids=${encodeURIComponent(ids.join("|"))}&props=claims%7Clabels%7Cdescriptions%7Cinfo&languages=en`;
  return parseWikidataEntities(await getJson(entitiesUrl, ua), host, name);
}
