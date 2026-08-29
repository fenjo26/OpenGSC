// GEO Audit's A-Parser engine — the mapping layer only.
//
// The transport, credentials and the "success: 1 that is really a failure" rule live in
// lib/seo/aparser.ts, which the A-Parser provider work owns. This file adds exactly one thing:
// turning a FreeAI::ChatGPT row into the shape the GEO report is assembled from.
//
// Why the engine is worth having at all: GEO stage 1 is the most expensive request in the app
// and the only one with no token ceiling, so a run that times out bills in full and returns
// nothing. FreeAI::ChatGPT reaches the same public ChatGPT surface a person would use, through
// software the operator already runs, and answers with a typed `$sources` array that is strictly
// better than what the Responses API relays give us — those arrive with no annotation metadata
// at all, which is why geo.ts has to mine links out of the prose as a fallback.
//
// What it cannot do: report the search steps. `$sources` says what the answer used, not which
// queries found them, and there is no open-page equivalent. That is the same trade the Gemini
// engine already makes for `opened`.

import {
  aparserOneRequest, parserResultProblem, resolveBaseUrl, envPassword,
  type AparserCreds, type AparserOption,
} from "@/lib/seo/aparser";

export const GEO_APARSER_PARSER = "FreeAI::ChatGPT";

/** One entry of the parser's `$sources`. `type` is "citation" for sources the answer cites. */
export interface GeoAparserSource { link: string; anchor: string; snippet: string; type: string }

export interface GeoAparserAnswer {
  answer: string;
  /** Reported by the parser, never requested: the free session serves what it serves. */
  model: string;
  sources: GeoAparserSource[];
  /** True when the row carried no `$sources` and only the answer text survived. */
  textOnly: boolean;
}

/**
 * "Search the web" is OFF by default in this parser, and with it off the answer comes out of the
 * model's weights — which is precisely the thing the GEO module exists to say is not evidence.
 * So it is sent as an explicit override rather than trusted to the user's preset, following the
 * same rule the transport documents for every answer-changing parameter.
 *
 * The option id is the one thing here that cannot be verified from the docs, so a rejected
 * override is retried once without it instead of failing the audit: a preset that already has
 * web search on then still works, and the alternative is an engine that dies on an id typo.
 */
const WEB_SEARCH_OVERRIDE: AparserOption[] = [{ type: "override", id: "search", value: 1 }];

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Reads one `$sources` entry, tolerating the key spellings A-Parser's output modes produce. */
function readSource(raw: any): GeoAparserSource | null {
  if (!raw || typeof raw !== "object") return null;
  const link = asString(raw.link ?? raw.url ?? raw.href).trim();
  if (!/^https?:\/\//i.test(link)) return null;
  return {
    link,
    anchor: asString(raw.anchor ?? raw.title ?? raw.text).trim(),
    snippet: asString(raw.snippet ?? raw.description).trim(),
    // An untyped source is never promoted to a citation. Over-counting citations inflates every
    // downstream metric — top-3 concentration, source-type mix, trust — while an
    // uncited-but-scanned source only costs precision.
    type: (asString(raw.type).trim() || "other").toLowerCase(),
  };
}

/**
 * The parser's structured row → our shape.
 *
 * Only `results[0]` is read, never `resultString`: that string is rendered through the preset's
 * own Template-Toolkit format, which A-Parser owners edit as a matter of course, so parsing it
 * would make the engine's contract depend on somebody's formatting choices.
 */
export function mapGeoAparserRow(row: any): GeoAparserAnswer | null {
  if (!row || typeof row !== "object") return null;
  const answer = asString(row.answer ?? row.text).trim();
  if (!answer) return null;
  const rawSources = Array.isArray(row.sources) ? row.sources : [];
  const seen = new Set<string>();
  const sources: GeoAparserSource[] = [];
  for (const s of rawSources) {
    const parsed = readSource(s);
    if (!parsed || seen.has(parsed.link)) continue;
    seen.add(parsed.link);
    sources.push(parsed);
  }
  return { answer, model: asString(row.model).trim(), sources, textOnly: sources.length === 0 };
}

export interface GeoAparserOpts {
  /** From Settings → SEO Tools (`seoBaseUrl_aparser`); falls back to the instance env var. */
  baseUrl?: string;
  /** From Settings → SEO Tools (`seoKey_aparser`); falls back to OPENGSC_APARSER_PASSWORD. */
  password?: string;
  configPreset?: string;
  preset?: string;
  query: string;
  timeoutMs: number;
}

/**
 * One FreeAI::ChatGPT request, normalised.
 *
 * Errors are returned as `aparser_*` strings rather than thrown: a GEO audit stores the failure
 * on its row and shows it, so these strings are user-facing.
 */
export async function runGeoAparser(opts: GeoAparserOpts): Promise<GeoAparserAnswer | { error: string }> {
  // resolveBaseUrl, not normaliseBaseUrl: the env var wins over the settings field on purpose
  // (a server-side fetch of a URL typed into a browser is the shape of an SSRF target), and this
  // engine must not be the one place that quietly opts out of that rule.
  const base = resolveBaseUrl(opts.baseUrl);
  if ("problem" in base) return { error: `aparser_${base.problem}` };
  const password = (opts.password || "").trim() || envPassword();
  if (!password) return { error: "aparser_no_password" };

  const creds: AparserCreds = { baseUrl: base.url, password, configPreset: opts.configPreset || undefined };
  const call = (options: AparserOption[]) =>
    aparserOneRequest(creds, GEO_APARSER_PARSER, opts.query, options, { preset: opts.preset, timeoutMs: opts.timeoutMs });

  let res = await call(WEB_SEARCH_OVERRIDE);
  if (!res.data && /option|override|unknown/i.test(res.error ?? "")) {
    // The instance did not accept the override; a preset with web search already on is still a
    // valid setup, so try it rather than failing outright.
    res = await call([]);
  }
  if (!res.data) return { error: res.error ?? "aparser_failed" };

  const row = Array.isArray(res.data.results) ? res.data.results[0] : null;
  // An empty answer from this parser is a burnt session or a blocked request, not a query with
  // no results — there is no "the engine said zero" case for a chat answer, so the transport's
  // emptiness rule applies with the content keys that matter here.
  const problem = parserResultProblem(row, ["answer", "sources"]);
  if (problem) return { error: problem };

  const mapped = mapGeoAparserRow(row);
  if (!mapped) return { error: "aparser_no_answer" };
  return mapped;
}
