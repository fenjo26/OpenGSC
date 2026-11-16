// Self-hosted SearXNG adapter for the SEO Tools SERP abstraction.
//
// SearXNG is a metasearch engine: one request fans out to its configured engines and merges
// what comes back. That has three consequences the rest of this module is built around:
//
//   1. It is keyless. The instance lives on this host and is addressed by SEARXNG_BASE_URL, so
//      the credential is the base URL itself — never a value the browser sends.
//   2. Its ordering is SearXNG's merged score, NOT a Google SERP position. `position` here is
//      the order of this answer; results carry the engines that found them so callers can tell.
//   3. It takes no country (`gl`) and no city. `language` is real, `gl` is not, so the adapter
//      never pretends a country was applied.
//
// Everything is bounded: one instance-wide concurrency slot, two attempts per page, a TTL cache
// and a hard timeout. A failure is always an error code — never a fabricated result list.

import { defaultLanguageFor } from "./regions";
import type { SerpEngine, SerpOptions, SerpResponse, SerpResultItem } from "./serp";
import { SEARXNG_PROVIDER_ID } from "./serpReadiness";

const DEFAULT_BASE_URL = "http://127.0.0.1:8889";
const DEFAULT_ENGINES = "bing,google cse";
const DEFAULT_FALLBACK_ENGINES = "duckduckgo,brave";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 300;
const MAX_PAGES = 3;
const MAX_RESULTS = 50;
const STATUS_CACHE_MS = 30_000;

export interface SearxngStatus {
  ok: boolean;
  configured: boolean;
  /** Host and port only — never a full URL with credentials, and never the query. */
  baseUrl: string;
  latencyMs: number;
  resultCount: number;
  engines: string[];
  error?: string;
  errorDetail?: string;
  checkedAt: string;
  cached?: boolean;
}

type Json = Record<string, unknown>;

interface FetchDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  bypassCache?: boolean;
}

interface CacheEntry {
  at: number;
  response: SerpResponse;
}

const cache = new Map<string, CacheEntry>();
let statusCache: { at: number; value: SearxngStatus } | null = null;

let activeRequests = 0;
const waiters: Array<() => void> = [];

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function nowMs(deps?: FetchDeps): number {
  return deps?.now ? deps.now() : Date.now();
}

function baseUrlProblem(): string | null {
  const raw = (process.env.SEARXNG_BASE_URL || DEFAULT_BASE_URL).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "SEARXNG_BASE_URL must be http or https";
    if (url.username || url.password) return "SEARXNG_BASE_URL must not contain credentials";
    if (url.search || url.hash) return "SEARXNG_BASE_URL must not contain a query or fragment";
    return null;
  } catch {
    return "SEARXNG_BASE_URL is not a valid URL";
  }
}

export function searxngBaseUrl(): string {
  return (process.env.SEARXNG_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

export function searxngBaseHost(): string {
  if (baseUrlProblem()) return "";
  try {
    return new URL(searxngBaseUrl()).host;
  } catch {
    return "";
  }
}

export function searxngConfigured(): boolean {
  return baseUrlProblem() === null;
}

export function defaultSearxngEngines(): string[] {
  return (process.env.SEARXNG_ENGINES || DEFAULT_ENGINES)
    .split(",")
    .map((engine) => engine.trim())
    .filter(Boolean);
}

function resolveEngines(opts: SerpOptions): string[] {
  if (Array.isArray(opts.searxngEngines) && opts.searxngEngines.length) {
    return opts.searxngEngines.map((engine) => String(engine).trim()).filter(Boolean);
  }
  // Explicit engine semantics: the outline screen's "bing" choice is a real request for Bing. Its
  // "google" choice maps to the configured Google-backed CSE + Bing set, because direct Google
  // is blocked from this host (verified: "access denied").
  if (opts.engine === "bing") return ["bing"];
  if (opts.engine === "yandex") return [];
  return defaultSearxngEngines();
}

function parseEngines(raw: string): string[] {
  return raw.split(",").map((engine) => engine.trim()).filter(Boolean);
}

export function buildSearxngParams(
  keyword: string,
  opts: SerpOptions,
  engines: string[],
  page = 1,
): Record<string, string> {
  const params: Record<string, string> = {
    q: keyword,
    format: "json",
    pageno: String(page),
    categories: opts.categories?.trim() || "general",
    language: opts.hl?.trim() || defaultLanguageFor(opts.gl || "us"),
    safesearch: String(opts.safesearch ?? 0),
  };
  if (engines.length) params.engines = engines.join(",");
  if (opts.timeRange) params.time_range = opts.timeRange;
  return params;
}

function cacheKey(keyword: string, opts: SerpOptions, engines: string[], want: number): string {
  return JSON.stringify({
    base: searxngBaseUrl(),
    keyword: keyword.trim().toLowerCase(),
    want,
    engines,
    language: opts.hl?.trim() || defaultLanguageFor(opts.gl || "us"),
    categories: opts.categories?.trim() || "general",
    safesearch: opts.safesearch ?? 0,
    timeRange: opts.timeRange ?? "",
  });
}

function cloneResponse(response: SerpResponse, cached: boolean): SerpResponse {
  return {
    ...response,
    cached,
    tookMs: cached ? 0 : response.tookMs,
    results: response.results.map((result) => ({
      ...result,
      ...(result.engines ? { engines: [...result.engines] } : {}),
    })),
    ...(response.engines ? { engines: [...response.engines] } : {}),
    ...(response.unresponsiveEngines
      ? { unresponsiveEngines: response.unresponsiveEngines.map((item) => ({ ...item })) }
      : {}),
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function domainOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Map one SearXNG JSON payload to the app's result shape. Pure, so the mapping is testable. */
export function normalizeSearxngResponse(
  data: unknown,
  want: number,
): {
  results: SerpResultItem[];
  unresponsive: { engine: string; error: string }[];
} {
  const record = data && typeof data === "object" ? (data as Json) : {};
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const rawUnresponsive = Array.isArray(record.unresponsive_engines) ? record.unresponsive_engines : [];

  const unresponsive: { engine: string; error: string }[] = [];
  for (const item of rawUnresponsive) {
    if (Array.isArray(item) && item.length >= 2) {
      unresponsive.push({ engine: String(item[0]), error: String(item[1]) });
    }
  }

  const seen = new Set<string>();
  const results: SerpResultItem[] = [];
  for (const entry of rawResults) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Json;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const dedupe = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const engines = stringArray(row.engines);
    if (!engines.length) {
      const single = typeof row.engine === "string" ? row.engine.trim() : "";
      if (single) engines.push(single);
    }
    const score = Number(row.score);
    results.push({
      position: results.length + 1,
      url,
      title: cleanText(row.title),
      snippet: cleanText(row.content),
      domain: domainOf(url),
      ...(engines.length ? { engine: engines[0], engines } : {}),
      ...(Number.isFinite(score) ? { score } : {}),
    });
    if (results.length >= want) break;
  }

  return { results, unresponsive };
}

type PageOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: string; detail?: string; retryable: boolean; retryAfterMs?: number };

function classifyHttp(status: number): { error: string; retryable: boolean } {
  if (status === 429) return { error: "searxng_rate_limited", retryable: true };
  if (status === 403) return { error: "searxng_forbidden", retryable: false };
  if (status >= 500) return { error: "searxng_http_error", retryable: true };
  if (status >= 400) return { error: "searxng_http_error", retryable: false };
  return { error: "searxng_http_error", retryable: false };
}

function classifyTransport(error: unknown): { error: string; detail: string; retryable: boolean } {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const name = String(err?.name ?? "");
  const code = String(err?.cause?.code ?? "");
  if (name === "TimeoutError" || name === "AbortError") {
    return { error: "searxng_timeout", detail: "the instance did not answer before the timeout", retryable: true };
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH") {
    return { error: "searxng_unreachable", detail: `${code}: ${searxngBaseHost() || "SEARXNG_BASE_URL"}`, retryable: true };
  }
  return {
    error: "searxng_network_error",
    detail: String(code || err?.cause?.message || err?.message || "fetch failed").slice(0, 200),
    retryable: true,
  };
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = envInt("SEARXNG_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 16);
  if (activeRequests >= limit) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeRequests += 1;
  try {
    return await fn();
  } finally {
    activeRequests -= 1;
    waiters.shift()?.();
  }
}

async function fetchPage(
  params: Record<string, string>,
  deps: FetchDeps | undefined,
  timeoutMs: number,
): Promise<PageOutcome> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const target = `${searxngBaseUrl()}/search`;
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const text = await response.text();
    if (!response.ok) {
      const classified = classifyHttp(response.status);
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        ok: false,
        error: classified.error,
        detail: `HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
        retryable: classified.retryable,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    }
    try {
      const data = JSON.parse(text) as unknown;
      if (!data || typeof data !== "object") {
        return { ok: false, error: "searxng_invalid_json", detail: "the response was not an object", retryable: false };
      }
      return { ok: true, data };
    } catch {
      return {
        ok: false,
        error: "searxng_invalid_json",
        detail: `expected JSON, got ${text.slice(0, 120) || "an empty body"}`,
        retryable: false,
      };
    }
  } catch (error) {
    return { ok: false, ...classifyTransport(error) };
  }
}

async function fetchPageWithRetry(
  params: Record<string, string>,
  deps: FetchDeps | undefined,
  timeoutMs: number,
): Promise<PageOutcome> {
  let last: PageOutcome = { ok: false, error: "searxng_network_error", retryable: true };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await withSlot(() => fetchPage(params, deps, timeoutMs));
    if (last.ok) return last;
    if (!last.retryable || attempt === 1) return last;
    if (last.retryAfterMs && last.retryAfterMs > 5_000) return last;
    const wait = last.retryAfterMs ?? 350 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return last;
}

/** Drop every cached answer. Exposed for tests and for an operator who needs a fresh read. */
export function clearSearxngCache(): void {
  cache.clear();
  statusCache = null;
}

export async function searxngSearch(
  _apiKey: string,
  keyword: string,
  opts: SerpOptions,
  deps?: FetchDeps,
): Promise<SerpResponse> {
  const engine: SerpEngine = opts.engine ?? "google";
  const started = nowMs(deps);
  const fail = (error: string, errorDetail?: string): SerpResponse => ({
    engine,
    provider: SEARXNG_PROVIDER_ID,
    keyword,
    results: [],
    error,
    ...(errorDetail ? { errorDetail } : {}),
    tookMs: nowMs(deps) - started,
  });

  const configProblem = baseUrlProblem();
  if (configProblem) return fail("searxng_not_configured", configProblem);

  const want = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(Number(opts.num) || 10)));
  let engines = resolveEngines(opts);
  if (!engines.length) return fail("searxng_engine_unsupported", "SearXNG has no configured engine for that request");

  const key = cacheKey(keyword, opts, engines, want);
  const ttl = envInt("SEARXNG_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS, 0, 3_600_000);
  if (!deps?.bypassCache && ttl > 0) {
    const hit = cache.get(key);
    if (hit && nowMs(deps) - hit.at < ttl) return cloneResponse(hit.response, true);
  }

  const timeoutMs = envInt("SEARXNG_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 60_000);
  const wantedPages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(want / 20)));

  const results: SerpResultItem[] = [];
  const seen = new Set<string>();
  const unresponsive: { engine: string; error: string }[] = [];
  const failures: PageOutcome[] = [];

  const runPass = async (passEngines: string[], pages: number): Promise<void> => {
    for (let page = 1; page <= pages; page += 1) {
      const params = buildSearxngParams(keyword, opts, passEngines, page);
      const outcome = await fetchPageWithRetry(params, deps, timeoutMs);
      if (!outcome.ok) {
        if (failures.length === 0) failures.push(outcome);
        return;
      }
      const mapped = normalizeSearxngResponse(outcome.data, want - results.length);
      for (const item of mapped.unresponsive) {
        if (!unresponsive.some((row) => row.engine === item.engine)) unresponsive.push(item);
      }
      for (const item of mapped.results) {
        const dedupe = item.url.replace(/\/+$/, "").toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        results.push({ ...item, position: results.length + 1 });
        if (results.length >= want) return;
      }
      if (mapped.results.length === 0) return;
    }
  };

  await runPass(engines, wantedPages);

  // A sparse answer usually means the primary pair was rate-limited or blocked for this query.
  // One extra pass on the independent engines is cheaper than failing the user's job, and it is
  // skipped entirely when the caller named its engines explicitly.
  if (results.length < 3 && !opts.searxngEngines?.length && opts.engine !== "bing") {
    const fallback = parseEngines(process.env.SEARXNG_FALLBACK_ENGINES || DEFAULT_FALLBACK_ENGINES)
      .filter((name) => !engines.includes(name));
    if (fallback.length) {
      engines = [...engines, ...fallback];
      await runPass(fallback, 1);
    }
  }

  const tookMs = nowMs(deps) - started;

  if (results.length === 0) {
    const firstError = failures[0];
    if (firstError && !firstError.ok) {
      const detail = [
        firstError.detail,
        unresponsive.length ? unresponsive.map((row) => `${row.engine}: ${row.error}`).join("; ") : "",
      ].filter(Boolean).join(" — ");
      return {
        ...fail(firstError.error, detail || undefined),
        engines,
        unresponsiveEngines: unresponsive,
      };
    }
    return {
      ...fail(
        unresponsive.length ? "searxng_engines_unavailable" : "searxng_no_results",
        unresponsive.length
          ? unresponsive.map((row) => `${row.engine}: ${row.error}`).join("; ")
          : "SearXNG answered with zero results for this query",
      ),
      engines,
      unresponsiveEngines: unresponsive,
    };
  }

  const response: SerpResponse = {
    engine,
    provider: SEARXNG_PROVIDER_ID,
    keyword,
    results: results.slice(0, want),
    engines,
    unresponsiveEngines: unresponsive,
    tookMs,
    cached: false,
  };

  if (ttl > 0) {
    cache.set(key, { at: nowMs(deps), response: cloneResponse(response, false) });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }

  return response;
}

/**
 * Deep readiness probe: a real search, not just a socket check, so "connected" cannot be shown
 * for an instance whose JSON output is off, whose engines are all blocked, or whose answer is
 * not JSON at all.
 */
export async function searxngStatus(deps?: FetchDeps): Promise<SearxngStatus> {
  const checkedAt = new Date(nowMs(deps)).toISOString();
  if (!deps?.bypassCache && statusCache && nowMs(deps) - statusCache.at < STATUS_CACHE_MS) {
    return { ...statusCache.value, cached: true };
  }

  const base = { configured: searxngConfigured(), baseUrl: searxngBaseHost(), checkedAt };
  if (baseUrlProblem()) {
    const value: SearxngStatus = {
      ...base,
      ok: false,
      latencyMs: 0,
      resultCount: 0,
      engines: [],
      error: "searxng_not_configured",
      errorDetail: baseUrlProblem() ?? undefined,
    };
    statusCache = { at: nowMs(deps), value };
    return value;
  }

  const started = nowMs(deps);
  const response = await searxngSearch(
    "",
    "searxng health check",
    { num: 3, gl: "us", hl: "en" },
    { ...deps, bypassCache: true },
  );
  const value: SearxngStatus = {
    ...base,
    ok: !response.error && response.results.length > 0,
    latencyMs: nowMs(deps) - started,
    resultCount: response.results.length,
    engines: response.engines ?? defaultSearxngEngines(),
    ...(response.error ? { error: response.error } : {}),
    ...(response.errorDetail ? { errorDetail: response.errorDetail } : {}),
  };
  statusCache = { at: nowMs(deps), value };
  return value;
}
