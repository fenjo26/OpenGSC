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

/** The env base URL, if the deployment set one. The route layers: explicit body, then this. */
export function envBaseUrl(): string {
  return (process.env.OPENGSC_APARSER_BASE_URL || "").trim();
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
  opts: { preset?: string; timeoutMs?: number; doLog?: boolean } = {},
): Promise<AparserResult<AparserOneRequestData>> {
  const send = (configPreset: string) => withSlot(() => aparserCall<AparserOneRequestData>(creds, "oneRequest", {
    query,
    parser,
    configPreset,
    preset: opts.preset || "default",
    rawResults: 1,
    // Logs are the only place A-Parser says WHY a parse came back empty (captcha, proxy refused,
    // retries exhausted); callers that turn an empty result into a stored error ask for them.
    doLog: opts.doLog ? 1 : 0,
    ...(options.length ? { options } : {}),
  }, opts.timeoutMs ?? APARSER_DEFAULT_TIMEOUT_MS));
  return withConfigPresetFallback(creds, send);
}

// ─── Thread config fallback ──────────────────────────────────────────────────

/**
 * `configPreset` names a thread config ("Settings → Thread settings" in A-Parser), and a name
 * that does not exist there fails EVERY request with `configPreset 'x' not exists` — while ping
 * and info, which take no config, stay green. One mistyped settings field therefore used to turn
 * a whole SERP Monitor run red. A-Parser always ships a config called "default", so a missing
 * name is retried once with it and the owner is told in the log instead.
 */
export const APARSER_DEFAULT_CONFIG = "default";

export function isMissingConfigPreset(error: string | undefined | null): boolean {
  return /configPreset\b.*\bnot\s+exists?\b/i.test(String(error ?? ""));
}

/**
 * `getParserPreset` / `oneRequest` naming a parser preset the instance does not have. The exact
 * wording is not documented, so this matches the family ("preset 'x' not exists", "… not
 * found") and deliberately NOT a thread-config miss, which has its own fallback.
 */
export function isMissingParserPreset(error: string | undefined | null): boolean {
  const s = String(error ?? "");
  return !isMissingConfigPreset(s) && /preset\b.*\bnot\s+(exists?|found)\b|no\s+such\s+preset/i.test(s);
}

const warnedConfigPresets = new Set<string>();

async function withConfigPresetFallback<T>(
  creds: AparserCreds,
  send: (configPreset: string) => Promise<AparserResult<T>>,
): Promise<AparserResult<T>> {
  const wanted = String(creds.configPreset ?? "").trim() || APARSER_DEFAULT_CONFIG;
  const first = await send(wanted);
  if (first.data || wanted === APARSER_DEFAULT_CONFIG || !isMissingConfigPreset(first.error)) return first;
  if (!warnedConfigPresets.has(wanted)) {
    warnedConfigPresets.add(wanted);
    console.warn(`[aparser] thread config "${wanted}" does not exist in A-Parser; using "${APARSER_DEFAULT_CONFIG}". Fix the thread config name in Settings → A-Parser.`);
  }
  return send(APARSER_DEFAULT_CONFIG);
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
  // Field set and values as the A-Parser API reference prints them for addTask. `resultsSaveTo`
  // is an enum whose only value is "file" (the name goes to `resultsFileName`) — passing a path
  // there fails validation with "must be one of [file]". `keepUnique` is required since
  // 1.2.364x ("Task Conf Error: Required field \"keepUnique\" not set") even though the docs
  // list it as optional; 1 deduplicates the query list, matching `uniqueQueries`. `$p1.preset`
  // is the task editor's own default: use parser 1's preset format, so a task returns what the
  // console test shows.
  const data = (configPreset: string): Record<string, unknown> => ({
    preset: task.preset || "default",
    configPreset,
    parsers: [[task.parser, task.preset || "default"]],
    resultsFormat: task.resultsFormat || "$p1.preset",
    resultsSaveTo: "file",
    resultsFileName: `OpenGSC-${task.parser.replace(/::/g, "-")}-${Date.now()}.txt`,
    additionalFormats: [],
    keepUnique: 1,
    resultsUnique: "no",
    queriesFrom: "text",
    queryFormat: ["$query"],
    uniqueQueries: false,
    saveFailedQueries: false,
    doLog: "db", // the reference's value; the task log then shows in A-Parser's own task list
    removeOnComplete: false,
    queries,
  });
  const r = await withConfigPresetFallback(creds, cfg => aparserCall<any>(creds, "addTask", data(cfg)));
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
  // builds, raw file text on some older ones. Passed through unmodified.
  return aparserCall<any>(creds, "getTaskResultsFile", { taskid });
}

/** Cap on a results file pulled through this server — past it the owner downloads it in A-Parser. */
export const APARSER_RESULTS_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The finished task's results as text.
 *
 * `getTaskResultsFile` answers with a link like `http://127.0.0.1:9091/downloadResults?…` — an
 * address that means "this server", which the owner's browser cannot open. The file is fetched
 * here instead. Only the path and query of that link are used, always against the configured
 * base URL: the link comes from the instance, but following an arbitrary host from a response
 * is exactly the redirect this module refuses elsewhere.
 */
export async function aparserTaskResultsText(creds: AparserCreds, taskid: number): Promise<AparserResult<{ text: string; truncated: boolean }>> {
  const r = await aparserTaskResults(creds, taskid);
  if (r.data == null) return fail(r.error ?? "aparser: no results");
  const d: unknown = r.data;
  const obj = d && typeof d === "object" ? d as Record<string, unknown> : {};
  const link = typeof d === "string" ? d : typeof obj.link === "string" ? obj.link : typeof obj.url === "string" ? obj.url : "";
  if (!/^https?:\/\//i.test(link)) {
    // Older builds hand back the file body itself.
    const text = typeof d === "string" ? d : JSON.stringify(d, null, 2);
    return { data: { text, truncated: false } };
  }
  let target: URL;
  try {
    const u = new URL(link);
    if (!/downloadResults/i.test(u.pathname)) return fail("aparser: unexpected results link");
    target = new URL(u.pathname + u.search, creds.baseUrl);
  } catch {
    return fail("aparser: bad results link");
  }
  try {
    const res = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(APARSER_DEFAULT_TIMEOUT_MS) });
    if (!res.ok) return fail(`aparser ${redactBaseUrl(creds.baseUrl)} results ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > APARSER_RESULTS_MAX_BYTES;
    return { data: { text: buf.subarray(0, APARSER_RESULTS_MAX_BYTES).toString("utf8"), truncated } };
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    return fail(`сеть A-Parser (${redactBaseUrl(creds.baseUrl)}): ${err.name === "TimeoutError" ? "timeout" : (err.cause?.code || err.message || "fetch failed")}`);
  }
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
