// One row per outbound provider call — opened when the request settles, closed when the caller
// has finished with the response.
//
// The obvious shape, `loggedFetch(url, init, facts)` writing its row the moment headers arrive,
// cannot work: tokens and any provider-stated cost live in the body, so they do not exist yet
// when that row is written. The equally obvious fix — hold the row in memory until parsing is
// done — loses the record of a call the provider has already billed if the process dies in
// between, which is precisely the gap this feature exists to close.
//
// So a call is two writes: an incomplete row inserted the moment its status is known, and one
// update carrying the facts that only existed later. That does not contradict the design's
// "append-only": rows are never restated or corrected, and a row gaining facts that did not
// exist when it was opened is the same row telling the same story to its end. `complete` is what
// keeps the two readings apart — a row nobody closed is not a row whose provider reported no
// usage.
//
// A previous revision had the handle self-finish "on the next tick" as a safety net. That is
// wrong in the worst way, because `await res.json()` on a real streamed response routinely
// crosses a tick: every row would have been written before its tokens existed, and the
// idempotence guard would then have rejected the genuine `finish` that carried them. Silence,
// dressed as safety. The net here is the incomplete row itself, which needs no timer.
//
// Two rules hold the writes together. Nothing awaits them — `rankScheduler` makes up to fifty
// sequential checks per site, and a synchronous SQLite write hung off each one would be a
// self-inflicted slowdown — so they are queued, tracked, and drained by `flushProviderLog()`.
// And an update chains onto its own insert's promise, making the queue FIFO per row rather than
// merely per process: without that a slow insert and a fast finish race, the update addresses a
// row that does not exist yet, and the call sticks at `complete: false` with its tokens thrown
// away.
//
// The drain is wired to `beforeExit` and to nothing else. It deliberately does NOT listen for
// SIGTERM, because a library has no business owning the process's lifetime: registering any
// SIGTERM listener suppresses Node's default terminate for the whole process, so a handler that
// only flushes turns every passive listener elsewhere — and any flush blocked on a locked write —
// into a wait for SIGKILL. Under `next start` Next has already registered its own SIGTERM
// cleanup before route modules load, so the hook would stand down in production anyway and buy
// nothing for the hangs it costs everywhere else. The accepted consequence is that rows queued
// at the instant of a signal-driven stop can be lost. This is bookkeeping, not a ledger of
// record, and the queue drains in milliseconds; a host that wants the guarantee can await the
// exported `flushProviderLog()` in its own shutdown.
//
// Every write is wrapped, synchronously and asynchronously, and so is the row-building around
// it: `redact` can throw on a body no JSON serializer can represent, and it would do so on the
// happy path of a call the provider has already been paid for. Bookkeeping that can fail a paid
// provider call is worse than no bookkeeping.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { currentCallContext } from "./context";
import { redact, redactText, safeEndpoint } from "./redact";

export interface CallHandle {
  readonly id: string;
  finish(facts?: FinishFacts): void;
}

export interface FinishFacts {
  /**
   * The HTTP status, for a call this module did not make itself.
   *
   * `loggedFetch` knows its own and does not need telling. A hand-opened row would otherwise
   * keep the 0 the schema documents as "a transport failure that never got one", and every
   * SDK-path call would read as a failure to anyone filtering on status.
   */
  status?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
  model?: string;
  error?: string | null;
  /** The parsed body the caller already holds. Nothing here ever reads a Response stream. */
  responseBody?: unknown;
}

type WriteOp =
  | { kind: "insert"; row: Record<string, unknown> }
  | { kind: "update"; id: string; data: Record<string, unknown> };

type Writer = (op: WriteOp) => unknown;

/**
 * The row id is the application's, not the database's.
 *
 * `ProviderCall.id` has no SQL default, and it has to be known before the insert anyway: it is
 * what lets the later update address this exact row without a round-trip, and what guarantees
 * two concurrent calls can never write over each other. Built on randomUUID rather than the
 * `Math.random() + Date.now()` helper the older routes carry, because two calls started in the
 * same millisecond are the normal case here, not the exotic one.
 */
function cuid(): string {
  return `c${randomUUID().replace(/-/g, "")}`;
}

function providerCallTable(): any {
  return (prisma as any).providerCall;
}

// A client generated before this model existed would make every write a silent no-op, and an
// empty log reads exactly like an app that made no calls. Say so once, loudly, at load.
if (!providerCallTable()) {
  console.warn(
    "[providerLog] The Prisma client has no `providerCall` model, so no provider calls will be " +
    "recorded. Run `npx prisma generate` (and `prisma db push`) to pick up the schema.",
  );
}

/**
 * The write itself, given the delegate to write through.
 *
 * Split from `prismaWriter` so a test can hand it a stub: every test in this module replaces the
 * writer wholesale, which left the one decision that matters here — `updateMany` rather than
 * `update` — never actually executed.
 */
function writeToTable(table: any, op: WriteOp): unknown {
  if (!table) return undefined;
  if (op.kind === "insert") return table.create({ data: op.row });
  // `updateMany`, not `update`: retention can delete a row between its insert and the finish of
  // a very long call, and a log losing an old row is not a reason to raise into a provider call
  // that is still running. A zero count is a normal return here; `update` would throw.
  return table.updateMany({ where: { id: op.id }, data: op.data });
}

function prismaWriter(op: WriteOp): unknown {
  return writeToTable(providerCallTable(), op);
}

let writer: Writer = prismaWriter;

const pending = new Set<Promise<void>>();

let lastWarnAt = 0;

/**
 * A write that failed is worth knowing about, but a database outage would otherwise print once
 * per provider call and bury the failure that caused it. First one immediately, then at most one
 * a minute.
 */
function warnWriteFailed(err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn("[providerLog] a call could not be recorded:", err instanceof Error ? err.message : err);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** Hand an op to the writer now — never on a later tick — without letting it raise. */
function runWrite(op: WriteOp): unknown {
  try {
    return writer(op);
  } catch (err) {
    warnWriteFailed(err);
    return undefined;
  }
}

/**
 * Make a write awaitable by `flushProviderLog` without making anyone else await it.
 *
 * The returned promise never rejects, so chaining an update onto it cannot turn a failed insert
 * into an unhandled rejection.
 */
function track(value: unknown): Promise<void> | undefined {
  if (!isThenable(value)) return undefined;
  const p = Promise.resolve(value).then(() => {}, warnWriteFailed);
  pending.add(p);
  void p.then(() => { pending.delete(p); });
  return p;
}

/**
 * Write `op` after `previous` has settled.
 *
 * A writer that returned no promise has already done its work, so there is nothing to wait for
 * and the write happens now; that is what lets a synchronous writer be observed synchronously.
 * A writer that returned a promise is chained, which is the FIFO-per-row guarantee.
 */
function writeAfter(previous: unknown, op: WriteOp): unknown {
  if (!isThenable(previous)) return track(runWrite(op));
  return track(previous.then(() => runWrite(op)));
}

interface OpenOpts {
  provider: string;
  endpoint: string;
  model?: string;
  attempt?: number;
  requestBody?: unknown;
}

/**
 * Origin and path only, never a query string.
 *
 * Gemini's key travels in the query, so a raw URL must never reach `redact` — stripping is
 * `safeEndpoint`'s job. Callers may also pass something that is not a URL at all (a label, a
 * relative path), for which `safeEndpoint` returns empty; keeping the text up to the first "?"
 * is more useful than keeping nothing, and still drops the half where credentials live.
 */
function endpointFor(raw: string): string {
  return safeEndpoint(raw) || raw.split("?")[0];
}

/**
 * Redact a body without letting it take the row down with it.
 *
 * `redact` falls back to `String(value)` when `JSON.stringify` throws, and `String()` itself
 * throws on a null-prototype object; a deep enough structure overflows the stringifier outright.
 * Both are reachable only with capture switched on — which is to say, exactly when an operator
 * is already debugging something. A body we cannot represent is worth recording as such: the
 * row, and the call, cost nothing for it.
 */
function safeBody(value: unknown): string {
  try {
    return redact(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Sanitize what goes in the `error` column — here, once, rather than at every call site.
 *
 * Almost nothing that reaches this column is ours. `extractErrorDetail` in llm.ts returns the
 * provider's `{error:{message}}` or, when the body is not that shape, the raw body; demand.ts and
 * serp.ts slice the response text into it directly; the XML River key check copies `data.error`.
 * A gateway that rejects a credential and echoes it — in its message, or in a URL quoted inside
 * it — was therefore having its body redacted and the identical text stored in the clear beside
 * it, and served by the log view.
 *
 * Doing this at the call sites was the other option and is the wrong one: there are dozens of
 * them today, the next one will be written by someone who has never read this file, and a
 * sanitizer you have to remember is a sanitizer that will be forgotten. Every path that writes
 * the column goes through here.
 *
 * `null` survives as `null`: a row whose call succeeded must read as no error at all, and the
 * string "null" in the column would show on screen as a failure that never happened.
 */
function safeError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return redactText(typeof value === "string" ? value : String(value));
  } catch {
    return "[unserializable]";
  }
}

/**
 * A handle for a row that could not be opened. Its id is empty, and finishing it does nothing.
 *
 * Only reached when building the row threw, which means the call is running and the log is not.
 * That is the right way round.
 */
const NO_ROW: CallHandle = { id: "", finish() {} };

/**
 * Open a row.
 *
 * `at` is when the call began — before the fetch, not after it — so a slow call is filed under
 * the moment it started rather than the moment it returned. `ms` is wall time from `at` to
 * `finish()`, and time to the response headers only for a call nobody ever finishes: `await
 * fetch` resolves on headers, and for an LLM the generation happens inside the caller's
 * `res.json()`, so fixing the duration at header arrival would leave the provider's own time out
 * of every row. `status` is 0 for a call that has not got one yet — a transport failure keeps it,
 * and a hand-opened call reports its own through `finish`.
 */
function openRow(o: OpenOpts, at: number, status: number): CallHandle {
  try {
    // Read once, here: `finish` may well run in a different async context, and the row belongs to
    // the context the call was made in.
    const ctx = currentCallContext();
    const id = cuid();

    const row: Record<string, unknown> = {
      id,
      at: new Date(at),
      userId: ctx.userId,
      feature: ctx.feature,
      provider: o.provider,
      model: o.model ?? null,
      endpoint: endpointFor(o.endpoint),
      status,
      ms: Date.now() - at,
      attempt: o.attempt ?? 1,
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      // Nothing carries an error into an insert today, and the value still goes through the one
      // sanitizer this column has: the alternative is a literal here that quietly becomes the
      // second, unguarded way in the day someone gives `OpenOpts` an error to carry.
      error: safeError(null),
      complete: false,
      requestBody: ctx.captureBodies && o.requestBody !== undefined ? safeBody(o.requestBody) : null,
      responseBody: null,
    };

    let tail: unknown = track(runWrite({ kind: "insert", row }));
    let finished = false;

    return {
      id,
      finish(facts: FinishFacts = {}) {
        // First close wins. A second one is a caller bug, not a second call, and must not write.
        if (finished) return;
        finished = true;

        try {
          const data: Record<string, unknown> = { complete: true, ms: Date.now() - at };
          if (facts.status !== undefined) data.status = facts.status;
          if (facts.promptTokens !== undefined) data.promptTokens = facts.promptTokens;
          if (facts.completionTokens !== undefined) data.completionTokens = facts.completionTokens;
          // Only ever what a provider stated. Never derived from tokens and a price table.
          if (facts.costUsd !== undefined) data.costUsd = facts.costUsd;
          if (facts.model !== undefined) data.model = facts.model;
          if (facts.error !== undefined) data.error = safeError(facts.error);
          if (ctx.captureBodies && facts.responseBody !== undefined) {
            data.responseBody = safeBody(facts.responseBody);
          }

          tail = writeAfter(tail, { kind: "update", id, data });
        } catch (err) {
          // The row build is as capable of throwing as the write is, and a caller closing a call
          // it has already been billed for must not be the one to find out.
          warnWriteFailed(err);
        }
      },
    };
  } catch (err) {
    warnWriteFailed(err);
    return NO_ROW;
  }
}

/**
 * Open a row for a call this module did not make itself — an SDK call, or anything that is not
 * a bare fetch. The row exists from this moment, so an early return or a crash before `finish`
 * still leaves the evidence that the call happened.
 */
export function startProviderCall(o: OpenOpts): CallHandle {
  return openRow(o, Date.now(), 0);
}

/** Await every queued write. Called by tests, and on the way down. */
export async function flushProviderLog(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

/**
 * Capture what was sent, when capture is on.
 *
 * A string body is parsed back into an object first: `redact` blanks fields by NAME, and a body
 * left as a JSON string is one opaque value whose field names it can never see. Only strings are
 * touched — a stream or a FormData is left alone, because reading it here would consume the body
 * the request still needs.
 */
function requestBodyFrom(init: RequestInit): unknown {
  if (typeof init.body !== "string") return undefined;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

/**
 * `fetch`, with a row.
 *
 * Returns the response untouched alongside the handle: the caller parses it and then reports
 * what only the parsed body knows. Nothing here reads the stream — the response body reaches the
 * log through `finish({ responseBody })`, as an object the caller already has.
 */
export async function loggedFetch(
  url: string,
  init: RequestInit,
  o: { provider: string; model?: string; attempt?: number },
): Promise<{ res: Response; call: CallHandle }> {
  const at = Date.now();
  const ctx = currentCallContext();
  const opts: OpenOpts = {
    ...o,
    endpoint: url,
    requestBody: ctx.captureBodies ? requestBodyFrom(init) : undefined,
  };

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // A transport failure may well have been billed, so it gets a row like any other call, with
    // status 0 for "never got one". It is closed here because nobody else can: there is no
    // response to parse and no further fact will ever arrive.
    const call = openRow(opts, at, 0);
    call.finish({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  const call = openRow(opts, at, res.status);
  return { res, call };
}

/**
 * Drain on the way out.
 *
 * `beforeExit` fires when the loop has emptied of its own accord and suppresses nothing, so
 * unlike a SIGTERM listener it cannot hold a process open or convert someone else's passive
 * listener into a SIGKILL wait. Named, because the test that proves the drain is wired has to
 * find this exact handler: counting listeners proves nothing when the runtime registers its own.
 * It returns the promise so that test can await it; Node ignores the return.
 */
function drainProviderLogOnExit(): Promise<void> {
  return flushProviderLog();
}

// Guarded on globalThis the way `lib/prisma.ts` guards its client, because modules here do get
// re-evaluated and a listener registered twice per reload is a leak.
const globalForProviderLog = globalThis as unknown as { providerLogDrainRegistered?: boolean };
if (!globalForProviderLog.providerLogDrainRegistered) {
  globalForProviderLog.providerLogDrainRegistered = true;
  process.on("beforeExit", drainProviderLogOnExit);
}

// ---------------------------------------------------------------------------------------------
// Test hooks. The writer is the only seam: swapping it keeps every code path above under test,
// including the ordering guarantees, without a database.

let rows: any[] = [];

export function __rows(): any[] {
  return rows;
}

/** Run the real writer against a stub delegate — the one path a swapped writer hides. */
export function __writeToTableForTests(table: any, op: any): unknown {
  return writeToTable(table, op);
}

export function __setWriterForTests(fn?: (op: any) => unknown): void {
  rows = [];
  writer = (op) => {
    if (op.kind === "insert") rows.push({ ...op.row });
    else {
      const row = rows.find(r => r.id === op.id);
      if (row) Object.assign(row, op.data);
    }
    return fn?.(op);
  };
}
