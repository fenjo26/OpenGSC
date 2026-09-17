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
  redirectBrowserSingle?: string; // share one JS-check browser across the task (we turn it off)
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
  redirectBrowserSingle: "redirectBrowserSingle",
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
  // One JS-check browser per request, not one shared across the task. With the shared browser
  // (the preset default) live probes on 1.2.3640 failed with "Process redirect error: mismatch"
  // — the check was passed from one proxy and the SERP fetched from another; with this override
  // the same query succeeded. The id is the preset's own ("Single redirect browser for task").
  if (ids.redirectBrowserSingle) options.push({ type: "override", id: ids.redirectBrowserSingle, value: 0 });
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

export function captchaShows(row: unknown): number {
  const info = row && typeof row === "object" ? (row as Record<string, unknown>).info : null;
  const stats = info && typeof info === "object" ? (info as Record<string, unknown>).stats : null;
  const n = stats && typeof stats === "object" ? Number((stats as Record<string, unknown>).reCaptchaShows) : 0;
  return Number.isFinite(n) ? n : 0;
}

function featuresOf(row: Record<string, unknown>): string[] {
  const features: string[] = [];
  // The AI overview arrives as a string plus a type, not as an array: "none" when absent.
  const aiAnswer = asString(row.ai_answer).trim();
  const aiType = asString(row.ai_type).trim();
  if ((aiAnswer && !/^none$/i.test(aiAnswer)) || (aiType && !/^none$/i.test(aiType))) features.push("ai_overview");
  for (const { keys, id } of FEATURE_KEYS) {
    for (const k of keys) {
      const v = row[k];
      if (Array.isArray(v) && v.length > 0) { features.push(id); break; }
    }
  }
  return features;
}

/**
 * SE::Google's `serp` as a list of objects, whichever shape the build sends.
 *
 * Documented shape: objects with `link`/`anchor`/`snippet`. What A-Parser 1.2.3640 actually
 * returns with `rawResults: 1` is FLAT — every result's fields one after another:
 *
 *   ["https://a.gr/", "Title", "Snippet", 0, "21 Αυγ 2026", "", "https://www.google.com/goto?…",
 *    "https://b.gr/", "Title", …]
 *
 * (63 values for "Total grabbed 9 links" → 7 per result). The width is not in the response and
 * does not match the documented field list, so it is detected: the smallest width that divides
 * the list and puts a URL at every row start and a non-URL title right after it. Link, anchor and
 * snippet are the first three fields in both the documentation and the live answer; nothing past
 * them is read. A list no width explains yields no rows — never a guess.
 */
export function serpItems(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.some((v) => v && typeof v === "object")) {
    return raw.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  }
  const isUrl = (v: unknown) => typeof v === "string" && /^https?:\/\//i.test(v);
  for (let width = 3; width <= 16; width++) {
    if (raw.length % width !== 0) continue;
    let fits = true;
    for (let i = 0; i < raw.length; i += width) {
      if (!isUrl(raw[i]) || isUrl(raw[i + 1]) || typeof raw[i + 1] !== "string") { fits = false; break; }
    }
    if (!fits) continue;
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < raw.length; i += width) {
      // The Google redirect this row's link was resolved from (last field on 1.2.3640) — kept for
      // diagnostics only: it is what tells a mis-resolved link from a real one.
      const goto = raw.slice(i + 3, i + width).find((v) => typeof v === "string" && /^https?:\/\/[^/]*google\.[^/]+\/(goto|url)\?/i.test(v));
      out.push({ link: raw[i], anchor: raw[i + 1], snippet: raw[i + 2], ...(goto ? { goto } : {}) });
    }
    return out;
  }
  return [];
}

/**
 * Rows whose link A-Parser mis-resolved, pinned down precisely, so the rest of the answer can
 * be kept.
 *
 * Seen live on 1.2.3640 with a captcha-solving preset: a result that came through a Google
 * redirect (`goto`) and sits right before a result with a DIRECT link (no goto — app listings,
 * mostly) gets that next row's link instead of its own:
 *
 *   5. "NV Casino Ελλάδα 2026: Αξιολόγηση…"  link play.google.com/…finderr   goto …
 *   6. "NV Casino - Apps on Google Play"     link play.google.com/…finderr   (direct)
 *
 * The real link of row 5 is unknown, so the row is dropped — but its position stays taken
 * (`skip`), otherwise every result below it would appear to move up. Returns the indexes into
 * `items` to skip. Rows without goto information (object-shaped builds) are never touched.
 */
export function shiftedGotoRows(items: readonly Record<string, unknown>[]): Set<number> {
  const skip = new Set<number>();
  for (let i = 0; i + 1 < items.length; i++) {
    const cur = items[i];
    const next = items[i + 1];
    if (!cur.goto || next.goto) continue;
    const link = asString(cur.link).trim();
    if (link && link === asString(next.link).trim()) skip.add(i);
  }
  return skip;
}

/**
 * Whether a successful-looking answer can be trusted, or null when it can.
 *
 * A-Parser 1.2.3640 was seen answering `success: 1` with links that belong to other results:
 * the same titles and snippets as a correct run, but `play.google.com/store/apps/…` and
 * YouTube URLs in the link slot, repeated across rows (9 rows → 5 distinct links). Stored as a
 * snapshot, that is a fake "everyone dropped out, app stores took the top" and a fake storm.
 * Three signals, any one of which rejects the row — the snapshot is then `failed` and never
 * compared, exactly like a captcha:
 *
 *   - many repeated links: fewer than 80% distinct among ≥ 5 rows (Google does repeat a URL
 *     across pages now and then, which is why this is a ratio and not "any repeat");
 *   - one link carrying different titles — a link cannot be two different pages;
 *   - app-store links under titles that do not read like app-store listings ("… – Apps on
 *     Google Play", "Εφαρμογές στο Google Play"), at least 3 of them or 30% of the rows.
 *
 * Runs AFTER `repairShiftedGotoLinks`, which removes the one mis-resolution pattern that can be
 * pinned to single rows; what is left here is damage too spread out to repair.
 */
export function assessSerpIntegrity(items: readonly Record<string, unknown>[]): string | null {
  const rows = items
    .map((it) => ({ url: asString(it.link ?? it.url).trim(), title: asString(it.anchor ?? it.title).trim() }))
    .filter((it) => /^https?:\/\//i.test(it.url));
  if (rows.length === 0) return null;
  const reasons: string[] = [];

  const titlesByUrl = new Map<string, Set<string>>();
  for (const { url, title } of rows) {
    const set = titlesByUrl.get(url) ?? new Set<string>();
    if (title) set.add(title.toLowerCase().replace(/\s+/g, " "));
    titlesByUrl.set(url, set);
  }
  const distinct = titlesByUrl.size;
  if (rows.length >= 5 && distinct / rows.length < 0.8) reasons.push(`repeated links ${rows.length - distinct}/${rows.length}`);

  const conflicting = [...titlesByUrl.values()].filter((t) => t.size > 1).length;
  if (conflicting > 0) reasons.push(`${conflicting} link(s) with different titles`);

  const storeLike = /google\s*play|app\s*store|apps?\s+on|\bapp\b|\bapk\b|εφαρμογ|приложени|додат/i;
  const store = rows.filter(({ url, title }) => {
    const host = domainOf(url).toLowerCase();
    return (host === "play.google.com" || host === "apps.apple.com") && !storeLike.test(title);
  }).length;
  if (store >= 3 || (rows.length >= 3 && store / rows.length >= 0.3)) reasons.push(`app-store links under site titles ${store}`);

  return reasons.length ? reasons.join(", ") : null;
}

/**
 * One SE::Google structured row (`results[0]` of a `rawResults: 1` response) → our shape.
 *
 * `parserResultProblem` runs first with `["serp"]` as the content key, so a burnt proxy that
 * answers `success: 1` with an empty page arrives as the problem code it is — never as "the
 * SERP is empty". Only a `totalcount` of 0 the engine itself reported passes as a legitimate
 * empty result. Rows are deduped by exact URL (Google repeats a URL across pages) and
 * positions are renumbered 1..n AFTER the dedupe — a dropped duplicate or a javascript: row
 * must never leave a hole in the positions the diff engine compares. The one deliberate hole is
 * a row whose link A-Parser mis-resolved (`shiftedGotoRows`): a result WAS there, only its link
 * is unknown, so its position is kept and reported in `repaired`.
 */
export function mapAparserSerp(row: unknown, want: number): {
  results: SerpResultItem[];   // position = 1-based order after dedupe by exact url, cut to `want`
  totalCount: string;          // "" when absent
  features: string[];
  problem: string | null;      // parserResultProblem(row, ["serp"]) or "suspicious_links"
  problemDetail?: string;      // why a row was judged suspicious, for the stored detail
  repaired?: { position: number; title: string }[]; // slots left empty: A-Parser mis-resolved their link
} {
  let problem = parserResultProblem(row, ["serp"]);
  // A parser-level failure after captchas is a blocked proxy, not a broken request: SE::Google
  // reports it as `success: 0` with `info.stats.reCaptchaShows > 0` ("Ban proxy … All retries
  // exceed" in the log). Filing it under the proxy code sends the owner to the right fix.
  if (problem === "aparser_parser_failed" && captchaShows(row) > 0) problem = "aparser_blocked_or_empty";
  if (problem) return { results: [], totalCount: "", features: [], problem };

  const r = (row ?? {}) as Record<string, unknown>;
  const serp = serpItems(r.serp);
  const skip = shiftedGotoRows(serp);
  // More than a quarter of the page mis-resolved is not a page worth keeping.
  if (skip.size > 0 && skip.size / serp.length > 0.25) {
    return { results: [], totalCount: "", features: [], problem: "suspicious_links",
      problemDetail: `${skip.size}/${serp.length} links mis-resolved from Google redirects` };
  }
  const integrity = assessSerpIntegrity(serp.filter((_, i) => !skip.has(i)));
  if (integrity) {
    return { results: [], totalCount: "", features: [], problem: "suspicious_links", problemDetail: integrity };
  }
  const limit = Number.isFinite(want) && want > 0 ? Math.floor(want) : 0;
  const seen = new Set<string>();
  const results: SerpResultItem[] = [];
  const repaired: { position: number; title: string }[] = [];
  let pos = 0; // last position handed out; a repaired row takes one without producing a result

  for (const [index, raw] of serp.entries()) {
    if (pos >= limit) break;
    if (!raw || typeof raw !== "object") continue;
    if (skip.has(index)) {
      pos += 1;
      repaired.push({ position: pos, title: asString((raw as Record<string, unknown>).anchor).trim() });
      continue;
    }
    const item = raw as Record<string, unknown>;
    // SE::Google names the fields `$link` / `$anchor` / `$snippet`; `url`/`title`/`description`
    // are tolerated because the probe script — not hope — is what confirms the names on the
    // build the user actually runs.
    const url = asString(item.link ?? item.url).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    pos += 1;
    results.push({
      position: pos,
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
    ...(repaired.length ? { repaired } : {}),
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
  // Ordered by what a person needs first, because the UI shows one truncated line: the parser's
  // own verdict (captchas, proxies, retries), then the log lines that name the cause, and the raw
  // key list only when the row has no stats to report — an unexpected shape is the one case
  // where the keys ARE the finding.
  const parts: string[] = [];
  const r = row && typeof row === "object" ? row as Record<string, unknown> : null;
  const info = r && r.info && typeof r.info === "object" ? r.info as Record<string, unknown> : null;
  const stats = info && info.stats && typeof info.stats === "object" ? info.stats as Record<string, unknown> : null;
  if (stats) {
    const stat = (k: string, label: string) => (stats[k] !== undefined ? `${label} ${asString(stats[k])}` : "");
    const line = [stat("reCaptchaShows", "captcha"), stat("proxiesUsed", "proxies"), stat("retries", "retries")]
      .filter(Boolean).join(", ");
    if (line) parts.push(line);
  }
  const lines = logLines(logs).slice(-4);
  if (lines.length) parts.push(`log: ${lines.join(" | ")}`);
  if (!r) {
    parts.push("results[0]: absent");
  } else if (!stats) {
    const keys = Object.keys(r).slice(0, 20).map((k) => {
      const v = r[k];
      if (Array.isArray(v)) return `${k}[${v.length}]`;
      if (v && typeof v === "object") return `${k}{}`;
      if (k === "success" || k === "totalcount" || k === "pagecount") return `${k}=${asString(v).slice(0, 20)}`;
      return k;
    });
    parts.push(`keys: ${keys.join(", ") || "none"}`);
  }
  const text = parts.join(" · ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A-Parser log entries arrive as strings or as [level, timestamp, message, …] tuples depending on
 * build. Only the text survives — level and epoch numbers are noise in a one-line detail — and
 * the two lines every run ends with (the stats JSON dump and "Thread complete work") are dropped:
 * the stats are already summarised above them.
 */
export function logLines(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  const out: string[] = [];
  for (const entry of logs) {
    let text: string;
    if (Array.isArray(entry)) {
      const strings = entry.filter((x) => typeof x === "string") as string[];
      text = strings.length ? strings.join(" ") : entry.map(String).join(" ");
    } else if (typeof entry === "string") {
      text = entry;
    } else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      text = asString(o.message ?? o.msg ?? JSON.stringify(entry));
    } else {
      text = "";
    }
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || /^\{.*\}$/.test(clean) || /^thread complete work$/i.test(clean)) continue;
    out.push(clean.slice(0, 120));
  }
  return out;
}
