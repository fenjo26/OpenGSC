// Rank Tracker — pure SE::Google::Position mapping, no transport.
//
// Why a second A-Parser parser next to SE::Google: the tracker asks one question per keyword
// ("where is THIS site?"), and SE::Google::Position answers it with "Stop when found" — a site on
// position 4 costs one results page instead of the three-to-ten a full SERP scan fetches. The
// price is that the parser, not us, decides what counts as "the site", so this file owns the
// match plan that keeps that decision equal to `matchesSite` in lib/rank.ts.
//
// Same rules as aparserSerp.ts: never parse `resultString` (the preset's template renders it and
// owners edit templates), read `results[0]` from `rawResults: 1`, and treat an emptiness that
// has no evidence behind it as an error — a wrong "fell out of the top 100" is worse than a gap.
//
// Facts this relies on (A-Parser docs + the izzipizzy/aparser-mcp skill, 2026-09):
//   query      "<domain> <keyword>", domains may be comma-separated → `bulkcheck[]`
//   position   a number; 0 = pages parsed, domain absent; "none" = the request failed
//   link       the ranking page
//   matchtype  "domain" (default, exact host) | "tld" (registrable domain) | "url"
// scripts/aparser-position-probe.ts prints the live preset and raw rows for everything else.

import { apexOf } from "@/lib/drops/registries";
import type { AparserOption } from "./aparser";
import { captchaShows, describeAparserRow, logLines } from "./aparserSerp";

export const APARSER_POSITION_PARSER = "SE::Google::Position";

/** The deepest a Position check goes: 10 pages. "Stop when found" makes most checks shorter. */
export const APARSER_POSITION_MAX_DEPTH = 100;

export interface AparserPositionOptionIds {
  pagecount: string;
  country: string;
  language: string;
  matchType: string;
  redirectBrowserSingle: string;
}

/**
 * Option ids. `pagecount`/`gl`/`hl`/`redirectBrowserSingle` are SE::Google's (verified live on
 * 1.2.3628/1.2.3640, and Position inherits SE::Google's settings); `matchtype` comes from the
 * aparser-mcp skill. An override id the build does not have fails the whole query, so the caller
 * sends only ids present in the live preset (`filterOptionsByPreset`) whenever it can read it.
 */
export const APARSER_POSITION_OPTION_IDS: AparserPositionOptionIds = {
  pagecount: "pagecount",
  country: "gl",
  language: "hl",
  matchType: "matchtype",
  redirectBrowserSingle: "redirectBrowserSingle",
};

export type PositionMatchType = "tld" | "domain";

export interface PositionMatchPlan {
  /** Domains exactly as they go into the query, comma-joined by `aparserPositionQuery`. */
  domains: string[];
  matchType: PositionMatchType;
}

function cleanHost(host: string): string {
  return String(host ?? "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")
    .split("/")[0].replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * How to ask A-Parser so that its answer means what `matchesSite` means: the host itself or any
 * subdomain of it, `www.` ignored.
 *
 * - The tracked host IS a registrable name (`site.gr`): `tld` mode matches every host under that
 *   name — exactly `matchesSite`.
 * - It is a subdomain (`blog.site.gr`), or a name our suffix table does not know as registrable
 *   (`x.eu.com` resolves to the apex `eu.com`): `tld` would also count the parent site, so exact
 *   `domain` mode is used, asking for the host and its `www.` twin in one bulk query. Deeper
 *   subdomains of such a host are not matched — the one known difference, and a miss rather than
 *   a false hit.
 */
export function positionMatchPlan(siteHost: string): PositionMatchPlan {
  const host = cleanHost(siteHost);
  if (host && apexOf(host) === host) return { domains: [host], matchType: "tld" };
  return { domains: [host, `www.${host}`], matchType: "domain" };
}

/** "<domains> <keyword>" — the first token is the domain list, the rest is the keyword. */
export function aparserPositionQuery(plan: PositionMatchPlan, keyword: string): string {
  const kw = String(keyword ?? "").replace(/\s+/g, " ").trim();
  return `${plan.domains.join(",")} ${kw}`;
}

export function aparserPositionOptions(
  o: { depth: number; gl: string; hl: string; matchType: PositionMatchType },
  ids: AparserPositionOptionIds = APARSER_POSITION_OPTION_IDS,
): AparserOption[] {
  const pages = Math.min(10, Math.max(1, Math.ceil((Number(o.depth) || APARSER_POSITION_MAX_DEPTH) / 10)));
  const out: AparserOption[] = [{ type: "override", id: ids.pagecount, value: pages }];
  const gl = String(o.gl ?? "").trim().toLowerCase();
  const hl = String(o.hl ?? "").trim().toLowerCase();
  if (gl) out.push({ type: "override", id: ids.country, value: gl });
  if (hl) out.push({ type: "override", id: ids.language, value: hl });
  out.push({ type: "override", id: ids.matchType, value: o.matchType });
  // Same reason as aparserSerpOptions: a shared JS-check browser caused "redirect error: mismatch".
  out.push({ type: "override", id: ids.redirectBrowserSingle, value: 0 });
  return out;
}

/**
 * Keep only overrides the live preset knows. `presetKeys` null = preset unreadable → send all.
 * `pagecount` is never dropped: without it the preset default (1 page) would silently turn every
 * check into a top-10 check and every site below 10 into "not found".
 */
export function filterOptionsByPreset(
  options: AparserOption[], presetKeys: ReadonlySet<string> | null,
  mustKeep: readonly string[] = [APARSER_POSITION_OPTION_IDS.pagecount],
): { options: AparserOption[]; dropped: string[] } {
  if (!presetKeys || presetKeys.size === 0) return { options, dropped: [] };
  const kept: AparserOption[] = [];
  const dropped: string[] = [];
  for (const o of options) {
    if (presetKeys.has(o.id) || mustKeep.includes(o.id)) kept.push(o);
    else dropped.push(o.id);
  }
  return { options: kept, dropped };
}

export interface PositionMapped {
  /** null = not found within the parsed depth (only when `problem` is null). */
  position: number | null;
  url: string | null;
  /** Rank-check error code; the check must not be stored as a position when set. */
  problem: string | null;
  detail?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function hostMatches(resultHost: string, siteHost: string): boolean {
  const r = resultHost.replace(/^www\./, "");
  return r === siteHost || r.endsWith("." + siteHost);
}

/** A position cell: number ≥ 0, or null for "none"/garbage. */
function readPosition(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  const s = str(v).trim();
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}

interface Hit { position: number | null; link: string }

/** Every domain's answer: `bulkcheck[]` when present, else the row itself. */
function hitsOf(row: Record<string, unknown>): Hit[] {
  const bulk = row.bulkcheck;
  if (Array.isArray(bulk) && bulk.length && bulk.every((b) => b && typeof b === "object")) {
    return bulk.map((b) => {
      const o = b as Record<string, unknown>;
      return { position: readPosition(o.position), link: str(o.link ?? o.url).trim() };
    });
  }
  return [{ position: readPosition(row.position), link: str(row.link ?? row.url).trim() }];
}

function totalCountOf(row: Record<string, unknown>): number | null {
  const raw = str(row.totalcount ?? row.totalCount).replace(/[\s,. ]/g, "");
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * A "not found" is only as good as the pages behind it. A-Parser logs "No more pages" when
 * Google (or the build) stopped paginating; on 1.2.3640 that happened after page 1 of a query
 * with millions of results, with `totalcount` reported as "10". A zero from such a run means
 * "not in the top 10", not "not in the top 100". Trusted only when the engine's own total says
 * the query really has fewer results than we asked for.
 */
function stoppedEarly(row: Record<string, unknown>, logs: unknown, depth: number): boolean {
  if (!logLines(logs).some((l) => /no more pages/i.test(l))) return false;
  const total = totalCountOf(row);
  return !(total !== null && total > 10 && total < depth);
}

export function mapAparserPosition(
  row: unknown, logs: unknown, o: { siteHost: string; depth: number },
): PositionMapped {
  const fail = (problem: string, extra = ""): PositionMapped => ({
    position: null, url: null, problem,
    detail: `${problem}${extra ? ` (${extra})` : ""} · ${describeAparserRow(row, logs)}`,
  });
  if (!row || typeof row !== "object") return fail("aparser_no_result");
  const r = row as Record<string, unknown>;
  if (r.success !== undefined && Number(r.success) !== 1) {
    return fail(captchaShows(r) > 0 ? "aparser_blocked_or_empty" : "aparser_parser_failed");
  }

  const hits = hitsOf(r);
  if (hits.some((h) => h.position === null)) {
    // "none" (the documented failure marker), an empty cell, or a shape this build invented.
    // One unreadable domain in a bulk answer is enough: "www twin 0, host none" is not a miss.
    const raw = Array.isArray(r.bulkcheck) ? "bulkcheck" : `position=${JSON.stringify(r.position ?? null)}`;
    return fail("aparser_blocked_or_empty", raw);
  }

  const site = cleanHost(o.siteHost);
  const found = hits
    .filter((h): h is Hit & { position: number } => h.position !== null && h.position > 0)
    .sort((a, b) => a.position - b.position);

  if (found.length) {
    const best = found[0];
    // The parser's match must be ours. A link on another host means the match type did not do
    // what the plan assumed (or the build resolved a Google redirect to the wrong row); storing
    // it would draw a position for a page that is not the site's.
    if (best.link && !hostMatches(hostOfUrl(best.link), site)) {
      return fail("aparser_position_mismatch", `${hostOfUrl(best.link) || best.link.slice(0, 60)} ≠ ${site}`);
    }
    return { position: best.position, url: best.link || null, problem: null };
  }

  // Every domain answered 0: parsed, absent — if the parse went as deep as asked.
  if (stoppedEarly(r, logs, o.depth)) return fail("aparser_partial_serp", "stopped before the requested depth");
  return { position: null, url: null, problem: null };
}
