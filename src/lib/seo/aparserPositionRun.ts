// Rank Tracker — one SE::Google::Position call through the shared A-Parser transport.
// Mapping rules live in aparserPosition.ts (pure, tested); this owns the call, the preset
// introspection that keeps unknown override ids out of the request, and nothing else.

import { aparserOneRequest, aparserParserPreset, type AparserCreds } from "./aparser";
import {
  APARSER_POSITION_MAX_DEPTH, APARSER_POSITION_PARSER, aparserPositionOptions, aparserPositionQuery,
  filterOptionsByPreset, mapAparserPosition, positionMatchPlan, type PositionMapped,
} from "./aparserPosition";

const POSITION_TIMEOUT_MS = 180_000; // ten pages on slow proxies, same budget as SE::Google
const PRESET_TTL_MS = 10 * 60_000;
const PRESET = "default";

let presetCache: { key: string; at: number; keys: Set<string> | null } | null = null;
const warnedDropped = new Set<string>();

/** Option ids of the live `default` Position preset; null when it cannot be read. */
async function presetKeys(creds: AparserCreds): Promise<Set<string> | null> {
  const key = creds.baseUrl;
  if (presetCache && presetCache.key === key && Date.now() - presetCache.at < PRESET_TTL_MS) return presetCache.keys;
  const r = await aparserParserPreset(creds, APARSER_POSITION_PARSER, PRESET).catch(() => null);
  const keys = r?.data && typeof r.data === "object" ? new Set(Object.keys(r.data)) : null;
  // A failed read is cached too (briefly the same TTL): the parse call right after it will
  // surface the real error, and hammering getParserPreset before every keyword helps nobody.
  presetCache = { key, at: Date.now(), keys };
  return keys;
}

export interface PositionCheck extends PositionMapped { depth: number }

export async function aparserRankPosition(
  creds: AparserCreds,
  q: { keyword: string; gl: string; hl: string; siteHost: string; depth?: number },
): Promise<PositionCheck> {
  const depth = Math.min(APARSER_POSITION_MAX_DEPTH, Math.max(10, q.depth ?? APARSER_POSITION_MAX_DEPTH));
  const plan = positionMatchPlan(q.siteHost);
  const all = aparserPositionOptions({ depth, gl: q.gl, hl: q.hl, matchType: plan.matchType });
  const { options, dropped } = filterOptionsByPreset(all, await presetKeys(creds));
  if (dropped.length) {
    const k = dropped.join(",");
    if (!warnedDropped.has(k)) {
      warnedDropped.add(k);
      console.warn(`[rank/aparser] ${APARSER_POSITION_PARSER} preset has no option(s) ${k}; not sent. Run scripts/aparser-position-probe.ts.`);
    }
    // Without the match type the parser falls back to exact-domain matching, which misses
    // `www.` for a tld plan; the mismatch/miss would be silent, so the check is refused instead.
    if (dropped.includes("matchtype") && plan.matchType !== "domain") {
      return { position: null, url: null, depth, problem: "aparser_position_option_missing", detail: `preset has no matchtype option` };
    }
  }

  const r = await aparserOneRequest(creds, APARSER_POSITION_PARSER, aparserPositionQuery(plan, q.keyword), options, {
    preset: PRESET, timeoutMs: POSITION_TIMEOUT_MS, doLog: true,
  });
  if (!r.data) {
    return { position: null, url: null, depth, problem: r.error ?? "aparser_failed", detail: r.error ?? "aparser_failed" };
  }
  const row = Array.isArray(r.data.results) ? r.data.results[0] : null;
  const mapped = mapAparserPosition(row, r.data.logs, { siteHost: q.siteHost, depth });
  return { ...mapped, depth };
}
