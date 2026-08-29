// A-Parser — a client for a scraper the user runs on their own hardware.
//
// Proposed in issue #5. Every other data source in this app is a metered API on a hardcoded
// public host: the app holds a key, the vendor holds the machine, and a request costs money.
// A-Parser inverts all three. It is commercial software the user has already bought, it listens
// on their own network, it uses their own proxies, and a request costs nothing. That inversion
// is what makes it worth wiring in — clustering a 500-keyword list is a priced decision on
// Serper and a free one here — and it is also what makes it the first provider that can be
// pointed anywhere, run out of threads, or answer with a page its proxy never actually loaded.
// Those three consequences are what this file is mostly about.
//
// Wire format (https://a-parser.com/docs/api): POST {base}/API, JSON
// `{ password, action, data }` → `{ success: 0|1, data }`. Actions used here: ping, info,
// getProxies, getParserPreset, oneRequest, addTask, getTaskState, getTaskResultsFile.
//
// What is deliberately NOT here: any task *store* of our own. Batch mode talks to the
// instance's own queue — the task id lives in the client that queued it, the results file
// lives on the instance — because a server-side job store would duplicate a scheduler the
// user already owns. `oneRequest` plus the concurrency limiter covers everything the app
// itself drives; `addTask` exists for the console, where a human decides what runs.

// ─── Base URL ────────────────────────────────────────────────────────────────

export const APARSER_DEFAULT_PORT = 9091;

export type AparserUrlProblem =
  | "empty"
  | "bad_url"
  | "bad_protocol"
  | "credentials_in_url"
  | "no_host";

/**
 * Normalise whatever the user typed into an origin we can POST to.
 *
 * People paste three things into this field: the dashboard URL, the API URL with `/API` already
 * on it, and a bare `host:port`. All three mean the same instance, so all three are accepted and
 * reduced to an origin; `/API` is appended at call time, once, in one place.
 *
 * Credentials in the URL are rejected rather than stripped. `http://user:pass@host:9091` is not
 * a typo — it is someone trying to authenticate a different way — and silently discarding half
 * of what they typed would produce an auth failure they cannot see the cause of.
 */
export function normaliseBaseUrl(raw: string): { url: string } | { problem: AparserUrlProblem } {
  const value = String(raw ?? "").trim();
  if (!value) return { problem: "empty" };

  // A bare `192.168.1.50:9091` has no protocol; `new URL` would read `192.168.1.50:` as one.
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;

  let u: URL;
  try { u = new URL(withProtocol); } catch { return { problem: "bad_url" }; }

  if (u.protocol !== "http:" && u.protocol !== "https:") return { problem: "bad_protocol" };
  if (u.username || u.password) return { problem: "credentials_in_url" };
  if (!u.hostname) return { problem: "no_host" };

  const port = u.port || (u.protocol === "https:" ? "" : String(APARSER_DEFAULT_PORT));
  const host = port ? `${u.hostname}:${port}` : u.hostname;
  return { url: `${u.protocol}//${host}` };
}

/**
 * The base URL, and where it came from.
 *
 * `OPENGSC_APARSER_BASE_URL` wins over the settings value on purpose. The settings value is a
 * user-supplied URL that a server-side process then fetches, which is the shape of an SSRF
 * target — the write is already owner-only (`manageSecrets` in lib/team/roles.ts is owner-only,
 * and the settings mirror is written through that capability), so this is not a privilege hole,
 * but an instance that never fetches a URL typed into a browser is strictly safer than one that
 * does. Docker deployments should set the env var and leave the field read-only.
 *
 * Note what is NOT done here: `OPENGSC_ALLOW_PRIVATE_TARGETS` is not consulted and must not be.
 * That flag is global — it also relaxes the site-audit crawler and every other server-side
 * fetch — so requiring it for A-Parser would mean opening unrelated surfaces to enable a
 * feature whose normal deployment is a LAN address. A LAN address is the expected case here,
 * not the suspicious one, and it is scoped to this module.
 */
export function resolveBaseUrl(fromSettings?: string): { url: string; fromEnv: boolean } | { problem: AparserUrlProblem } {
  const env = (process.env.OPENGSC_APARSER_BASE_URL || "").trim();
  const r = normaliseBaseUrl(env || fromSettings || "");
  if ("problem" in r) return r;
  return { url: r.url, fromEnv: !!env };
}

export function envPassword(): string {
  return (process.env.OPENGSC_APARSER_PASSWORD || "").trim();
}

/** Base URL as it may appear in a message: host:port only, never a path, never credentials. */
export function redactBaseUrl(url: string): string {
  try { return new URL(url).host; } catch { return "a-parser"; }
}

// ─── Transport ───────────────────────────────────────────────────────────────

export interface AparserCreds {
  /** Origin, as returned by `normaliseBaseUrl`. */
  baseUrl: string;
  /** The API password from the A-Parser settings screen. */
  password: string;
  /** Thread-count config to run under. A-Parser's own default is called "default". */
  configPreset?: string;
}

export interface AparserResult<T> { data: T | null; error?: string }

const fail = <T>(error: string): AparserResult<T> => ({ data: null, error });

export interface AparserInfo {
  version: string;
  pid: string;
  activeThreads: number;
  workingTasks: number;
  tasksInQueue: number;
  activeProxyCheckerThreads: number;
  availableParsers: string[];
}

/** `oneRequest` blocks until the parse finishes; a deep run on slow proxies outlives 60s. */
export const APARSER_DEFAULT_TIMEOUT_MS = 120_000;
/** ping/info answer instantly or not at all — a long wait here is a wrong host, not a slow one. */
export const APARSER_PROBE_TIMEOUT_MS = 8_000;

export async function aparserCall<T = any>(
  creds: AparserCreds,
  action: string,
  data?: unknown,
  timeoutMs: number = APARSER_DEFAULT_TIMEOUT_MS,
): Promise<AparserResult<T>> {
  const base = String(creds.baseUrl ?? "").trim();
  if (!base) return fail<T>("no_aparser_base_url");
  if (!String(creds.password ?? "").trim()) return fail<T>("no_aparser_password");

  const host = redactBaseUrl(base);
  let res: Response;
  try {
    res = await fetch(`${base}/API`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: creds.password, action, ...(data === undefined ? {} : { data }) }),
      // A redirect would re-send the password to wherever the redirect points. There is no
      // legitimate reason for this endpoint to redirect, so treat one as a failure.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const code = e?.name === "TimeoutError" ? "timeout" : (e?.cause?.code || e?.message || "fetch failed");
    // The request body carries the password; nothing derived from it may reach this string.
    return fail<T>(`сеть A-Parser (${host}): ${code}`);
  }

  if (!res.ok) return fail<T>(`aparser ${host} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);

  let body: any;
  try { body = await res.json(); } catch { return fail<T>(`aparser ${host}: non-JSON response (${res.status})`); }

  if (body?.success !== 1) {
    // A-Parser puts the reason in `data` on failure — a wrong password, an unknown parser, an
    // option id this build does not have. All three are actionable and all three are lost if we
    // collapse them into "request failed".
    const reason = typeof body?.data === "string" ? body.data : JSON.stringify(body?.data ?? body ?? {});
    return fail<T>(`aparser: ${String(reason).slice(0, 300)}`);
  }
  return { data: body.data as T };
}

export async function aparserPing(creds: AparserCreds): Promise<AparserResult<string>> {
  return aparserCall<string>(creds, "ping", undefined, APARSER_PROBE_TIMEOUT_MS);
}

export async function aparserInfo(creds: AparserCreds): Promise<AparserResult<AparserInfo>> {
  const r = await aparserCall<any>(creds, "info", undefined, APARSER_PROBE_TIMEOUT_MS);
  if (!r.data) return fail<AparserInfo>(r.error ?? "aparser: no info");
  const d = r.data;
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    data: {
      version: String(d.version ?? ""),
      pid: String(d.pid ?? ""),
      activeThreads: num(d.activeThreads),
      workingTasks: num(d.workingTasks),
      tasksInQueue: num(d.tasksInQueue),
      activeProxyCheckerThreads: num(d.activeProxyCheckerThreads),
      availableParsers: Array.isArray(d.availableParsers) ? d.availableParsers.map(String) : [],
    },
  };
}

/**
 * The proxy pool, by type.
 *
 * Worth surfacing because of what this provider is: with a metered API, result quality is the
 * vendor's problem and there is nothing for the user to look at. Here the proxies ARE the
 * quality, and an empty pool explains every symptom downstream — see `parserResultProblem`.
 */
export async function aparserProxies(creds: AparserCreds): Promise<AparserResult<Record<string, string[]>>> {
  return aparserCall<Record<string, string[]>>(creds, "getProxies", undefined, APARSER_PROBE_TIMEOUT_MS);
}

/**
 * A parser's saved preset, as the instance actually has it.
 *
 * This is the introspection call that makes the option ids knowable instead of guessed: the
 * documentation names options in prose ("Pages count", "Results language"), while `options`
 * overrides need the internal ids (`pagecount`, `linksperpage`, …). Reading the preset off a
 * live instance is the only reliable way to learn them, which is why it is exposed to the
 * /aparser screen rather than kept internal.
 */
export async function aparserParserPreset(
  creds: AparserCreds, parser: string, preset = "default",
): Promise<AparserResult<Record<string, any>>> {
  return aparserCall<Record<string, any>>(creds, "getParserPreset", { parser, preset }, APARSER_PROBE_TIMEOUT_MS);
}

// ─── oneRequest ──────────────────────────────────────────────────────────────

export interface AparserOption { type: "override" | "set"; id: string; value: unknown }

export interface AparserOneRequestData {
  /** The formatted string. Never parse it — see below. */
  resultString?: string;
  results?: any[];
  logs?: any[];
}

/**
 * One synchronous parse.
 *
 * `rawResults: 1` is not optional and the reason belongs next to the call: without it the only
 * output is `resultString`, which A-Parser renders through the preset's `formatresult`
 * Template-Toolkit template. That template is a thing A-Parser owners routinely edit — it is the
 * point of the product — so anything parsed out of `resultString` silently changes shape when
 * the user tunes a preset, with no error anywhere. `results[0]` is the structured object and is
 * the only thing callers may read.
 *
 * For the same reason every parameter that changes the answer is sent as an explicit `override`
 * rather than left to the preset. `preset` is a starting point, not a contract.
 */
export async function aparserOneRequest(
  creds: AparserCreds,
  parser: string,
  query: string,
  options: AparserOption[] = [],
  opts: { preset?: string; timeoutMs?: number } = {},
): Promise<AparserResult<AparserOneRequestData>> {
  return withSlot(() => aparserCall<AparserOneRequestData>(creds, "oneRequest", {
    query,
    parser,
    configPreset: creds.configPreset || "default",
    preset: opts.preset || "default",
    rawResults: 1,
    doLog: 0,
    ...(options.length ? { options } : {}),
  }, opts.timeoutMs ?? APARSER_DEFAULT_TIMEOUT_MS));
}

/**
 * Why a successful response can still be a failure.
 *
 * When the proxy is burnt, rate-limited or served a captcha, A-Parser answers `success: 1` with
 * an empty result set. That is byte-identical to "this keyword genuinely has no results", and
 * the difference is not cosmetic: a caller that maps it to an empty list makes the Rank Tracker
 * write a null position for every keyword on the day the proxy pool dies, and the chart then
 * shows a clean, plausible, completely wrong "dropped out of the top 100" for the whole project.
 * `lib/rank.ts` already refuses a provider for a milder version of this (see RANK_UNSUPPORTED):
 * a wrong history is worse than a missing one, because the missing one gets fixed.
 *
 * So: an emptiness that comes with no evidence of a real page is an ERROR, and only an emptiness
 * the search engine itself confirmed — a zero total count — is a legitimate empty result.
 *
 * Returns null when the row is usable, otherwise a reason code.
 */
export function parserResultProblem(row: any, contentKeys: string[] = ["serp"]): string | null {
  if (!row || typeof row !== "object") return "aparser_no_result";
  // The parser reports its own outcome per query, independently of the API envelope.
  if (row.success !== undefined && Number(row.success) !== 1) return "aparser_parser_failed";

  const hasContent = contentKeys.some(k => {
    const v = row[k];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== "";
  });
  if (hasContent) return null;

  // Nothing came back. Did the engine actually say "zero", or did we never reach it?
  const total = row.totalcount ?? row.totalCount ?? row.total;
  if (total !== undefined && total !== null && String(total).trim() !== "" && Number(total) === 0) return null;

  return "aparser_blocked_or_empty";
}

// ─── Batch mode: addTask / getTaskState / getTaskResultsFile ─────────────────

export interface AparserAddTask {
  parser: string;
  preset?: string;
  queries: string[];
  /** Optional resultsFormat template; when omitted the preset's own format applies. */
  resultsFormat?: string;
}

export interface AparserTaskState {
  status: string;
  raw: Record<string, any>;
}

/**
 * Batch was deliberately left out of the first cut — "oneRequest plus the concurrency limiter
 * covers the bulk cases" — and that holds for everything the app itself drives. What it does
 * not cover is the console: two thousand queries do not belong in a synchronous call through
 * this server, they belong in A-Parser's own queue, running on the instance's own schedule
 * with its own thread config. The wrappers stay thin on purpose: field names below are what
 * the A-Parser API documents, and responses are passed through with minimal normalisation
 * because the shapes drifted across builds.
 */
export async function aparserAddTask(creds: AparserCreds, task: AparserAddTask): Promise<AparserResult<number>> {
  const queries = task.queries.map(q => q.trim()).filter(Boolean);
  if (!queries.length) return fail<number>("no_queries");
  const data: Record<string, unknown> = {
    parsers: [[task.parser, task.preset || "default"]],
    configPreset: creds.configPreset || "default",
    preset: task.preset || "default",
    queries,
    resultsSaveTo: `OpenGSC/${Date.now()}-${task.parser.replace(/::/g, "-")}.txt`,
    doLog: 0,
    keepLinks: 0,
    ...(task.resultsFormat ? { resultsFormat: task.resultsFormat } : {}),
  };
  const r = await aparserCall<any>(creds, "addTask", data);
  if (!r.data) return fail<number>(r.error ?? "aparser: no task id");
  const d = r.data as any;
  const id = Number(d?.taskid ?? d?.taskId ?? d);
  return Number.isFinite(id) ? { data: id } : fail<number>("aparser: no task id");
}

export async function aparserTaskState(creds: AparserCreds, taskid: number): Promise<AparserResult<AparserTaskState>> {
  const r = await aparserCall<any>(creds, "getTaskState", { taskid }, APARSER_PROBE_TIMEOUT_MS);
  if (!r.data) return fail<AparserTaskState>(r.error ?? "aparser: no state");
  const d = r.data as any;
  return { data: { status: String(d.status ?? d.state ?? ""), raw: d } };
}

export async function aparserTaskResults(creds: AparserCreds, taskid: number): Promise<AparserResult<any>> {
  // Whatever this build produces for a finished task: a download-link object on current
  // builds, raw file text on some older ones. Passed through unmodified — the console
  // renders either.
  return aparserCall<any>(creds, "getTaskResultsFile", { taskid });
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

/**
 * A limiter, because for the first time the machine on the other end is the user's own.
 *
 * With a metered API the vendor absorbs a burst and bills for it. Here a 500-keyword clustering
 * run would open 500 sockets against a box the user configured for, say, 20 threads — the
 * queries do not run any faster and the instance the user also uses for other work stops
 * responding. The default is deliberately low; `seoAparserConcurrency` raises it for people who
 * know what their build can take.
 */
let maxParallel = 5;
let inFlight = 0;
const waiting: (() => void)[] = [];

export function setAparserConcurrency(n: number) {
  const v = Math.floor(Number(n));
  if (Number.isFinite(v) && v >= 1 && v <= 64) maxParallel = v;
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= maxParallel) await new Promise<void>(resolve => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}
