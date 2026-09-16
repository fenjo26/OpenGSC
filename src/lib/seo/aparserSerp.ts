// SERP Monitor — pure SE::Google mapping, no transport. Never parses `resultString`,
// only `results[0]` (`rawResults: 1`).
//
// Everything here is deterministic array/string work so it can be unit-tested against fixtures
// with no instance on the network. The transport (lib/seo/aparser.ts) owns credentials, timeouts
// and the "success: 1 that is really a failure" rule; the provider branch in `serp.ts` owns the
// call itself. The one thing that cannot be learned from the documentation is the internal id of
// each parser option — the docs name settings in prose ("Pages count", "Search from country")
// while `options` overrides address them by id — so the ids below carry their provenance in
// comments and stay marked until scripts/aparser-serp-probe.ts has run against a live preset.

import { parserResultProblem, type AparserOption } from "./aparser";
import type { SerpResultItem } from "./serp";

export const APARSER_SERP_PARSERS: Record<"google", string> = { google: "SE::Google" };

export interface AparserSerpOptionIds {
  pagecount: string;      // pages to fetch
  country?: string;       // search country (gl)
  language?: string;      // results / interface language (hl)
}

/**
 * Option ids for the overrides `aparserSerpOptions` sends — read off a live SE::Google
 * `default` preset with scripts/aparser-serp-probe.ts (A-Parser v1.2.3628, 2026-09-16), not
 * from the documentation. The docs' prose names ("Search from country", "Results language")
 * suggested `country`/`lang`; the build has neither, and an unknown override id makes the parser
 * report the whole query as failed (`success: 0` → aparser_parser_failed on every keyword).
 *
 *   pagecount  "Pages count" — preset default 5, we send ceil(depth / 10)
 *   gl         Google's own `gl` (search country). `cr` (country RESTRICT) is deliberately not
 *              used: it filters results to sites from that country, which is not what a local
 *              searcher sees.
 *   hl         interface language. `lr` (results language restrict) is likewise left alone.
 */
export const APARSER_SERP_OPTION_IDS: AparserSerpOptionIds = {
  pagecount: "pagecount",
  country: "gl",
  language: "hl",
};

/**
 * The overrides that pin a snapshot to one market: depth in pages, country, language.
 *
 * Google stopped honouring `num=100` (September 2025), so depth is bought in pages of ~10.
 * `linksperpage` stays whatever the preset holds (10 on a stock install) because its id is not
 * in the contract's option table — fetching MORE than the depth is harmless (the mapping
 * dedupes and cuts), fetching less would silently shorten every snapshot. Pages are rounded up
 * and capped at 10: that is a full top-100, and SE::Google itself allows 1–100.
 *
 * Everything that changes the answer is sent as an explicit `override`, never trusted to the
 * preset — the same rule the transport documents for `oneRequest` as a whole.
 */
export function aparserSerpOptions(o: { depth: number; gl: string; hl: string }, ids: AparserSerpOptionIds = APARSER_SERP_OPTION_IDS): AparserOption[] {
  const pages = Math.min(10, Math.max(1, Math.ceil((Number(o.depth) || 10) / 10)));
  const options: AparserOption[] = [];
  if (ids.pagecount) options.push({ type: "override", id: ids.pagecount, value: pages });
  const gl = String(o.gl ?? "").trim().toLowerCase();
  const hl = String(o.hl ?? "").trim().toLowerCase();
  if (ids.country && gl) options.push({ type: "override", id: ids.country, value: gl });
  if (ids.language && hl) options.push({ type: "override", id: ids.language, value: hl });
  return options;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Same rule as `domainOf` in serp.ts, kept local so this file stays transport-free. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Which of the normalised SerpResponse feature ids the row gives evidence for. Key spellings
 * beyond `related`/`ads` (both documented) are candidates the probe script's key dump confirms
 * or prunes; a key we do not recognise is never promoted to a feature — an unknown block stays
 * unknown instead of being filed under the closest known name.
 */
const FEATURE_KEYS: readonly { keys: readonly string[]; id: string }[] = [
  { keys: ["related"], id: "related" },
  { keys: ["paa", "peopleAlsoAsk", "questions"], id: "paa" },
  { keys: ["ads"], id: "ads" },
  { keys: ["videos", "video"], id: "video" },
  { keys: ["local", "localResults"], id: "local" },
  { keys: ["images"], id: "images" },
  { keys: ["news"], id: "news" },
];

function captchaShows(row: unknown): number {
  const info = row && typeof row === "object" ? (row as Record<string, unknown>).info : null;
  const stats = info && typeof info === "object" ? (info as Record<string, unknown>).stats : null;
  const n = stats && typeof stats === "object" ? Number((stats as Record<string, unknown>).reCaptchaShows) : 0;
  return Number.isFinite(n) ? n : 0;
}

function featuresOf(row: Record<string, unknown>): string[] {
  const features: string[] = [];
  for (const { keys, id } of FEATURE_KEYS) {
    for (const k of keys) {
      const v = row[k];
      if (Array.isArray(v) && v.length > 0) { features.push(id); break; }
    }
  }
  return features;
}

/**
 * One SE::Google structured row (`results[0]` of a `rawResults: 1` response) → our shape.
 *
 * `parserResultProblem` runs first with `["serp"]` as the content key, so a burnt proxy that
 * answers `success: 1` with an empty page arrives as the problem code it is — never as "the
 * SERP is empty". Only a `totalcount` of 0 the engine itself reported passes as a legitimate
 * empty result. Rows are deduped by exact URL (Google repeats a URL across pages) and
 * positions are renumbered 1..n AFTER the dedupe — a dropped duplicate or a javascript: row
 * must never leave a hole in the positions the diff engine compares.
 */
export function mapAparserSerp(row: unknown, want: number): {
  results: SerpResultItem[];   // position = 1-based order after dedupe by exact url, cut to `want`
  totalCount: string;          // "" when absent
  features: string[];
  problem: string | null;      // parserResultProblem(row, ["serp"])
} {
  let problem = parserResultProblem(row, ["serp"]);
  // A parser-level failure after captchas is a blocked proxy, not a broken request: SE::Google
  // reports it as `success: 0` with `info.stats.reCaptchaShows > 0` ("Ban proxy … All retries
  // exceed" in the log). Filing it under the proxy code sends the owner to the right fix.
  if (problem === "aparser_parser_failed" && captchaShows(row) > 0) problem = "aparser_blocked_or_empty";
  if (problem) return { results: [], totalCount: "", features: [], problem };

  const r = (row ?? {}) as Record<string, unknown>;
  const serp = Array.isArray(r.serp) ? r.serp : [];
  const limit = Number.isFinite(want) && want > 0 ? Math.floor(want) : 0;
  const seen = new Set<string>();
  const results: SerpResultItem[] = [];

  for (const raw of serp) {
    if (results.length >= limit) break;
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    // SE::Google names the fields `$link` / `$anchor` / `$snippet`; `url`/`title`/`description`
    // are tolerated because the probe script — not hope — is what confirms the names on the
    // build the user actually runs.
    const url = asString(item.link ?? item.url).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      position: results.length + 1,
      url,
      title: asString(item.anchor ?? item.title).trim(),
      snippet: asString(item.snippet ?? item.description).trim(),
      domain: domainOf(url),
    });
  }

  return {
    results,
    totalCount: /^none$/i.test(asString(r.totalcount).trim()) ? "" : asString(r.totalcount).trim(),
    features: featuresOf(r),
    problem: null,
  };
}

/**
 * What an unusable row actually contained, for the stored error detail.
 *
 * "Empty answer" has several causes that look identical from the outside: a captcha after all
 * retries, a proxy pool that refused every connection, a result field under a different name on
 * this A-Parser build, or a country/language override the parser ignored. The row's own keys and
 * the tail of A-Parser's log tell them apart, so they travel with the error instead of being
 * thrown away. Never includes page content — only shapes, counts and log lines, cut to `max`.
 */
export function describeAparserRow(row: unknown, logs: unknown, max = 280): string {
  const parts: string[] = [];
  if (!row || typeof row !== "object") {
    parts.push("results[0]: absent");
  } else {
    const r = row as Record<string, unknown>;
    const keys = Object.keys(r).slice(0, 20).map((k) => {
      const v = r[k];
      if (Array.isArray(v)) return `${k}[${v.length}]`;
      if (v && typeof v === "object") return `${k}{}`;
      if (k === "success" || k === "totalcount" || k === "pagecount") return `${k}=${asString(v).slice(0, 20)}`;
      return k;
    });
    parts.push(`keys: ${keys.join(", ") || "none"}`);
  }
  const lines = logLines(logs).slice(-4);
  if (lines.length) parts.push(`log: ${lines.join(" | ")}`);
  const text = parts.join(" · ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A-Parser log entries arrive as strings or as [level, message, …] tuples depending on build. */
function logLines(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  const out: string[] = [];
  for (const entry of logs) {
    const text = Array.isArray(entry)
      ? entry.filter((x) => typeof x === "string" || typeof x === "number").map(String).join(" ")
      : typeof entry === "string" ? entry
      : entry && typeof entry === "object" ? asString((entry as Record<string, unknown>).message ?? (entry as Record<string, unknown>).msg ?? JSON.stringify(entry))
      : "";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) out.push(clean.slice(0, 120));
  }
  return out;
}
