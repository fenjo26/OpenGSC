// FieldLink customer API client (contract 1.14.0).
//
// Adapted from gsc-hub (https://github.com/izzipizzy/gsc-hub, MIT — notice preserved here per
// its license), which built the first integration against this API. Deviations from the port:
// no referral header (OpenGSC ships no affiliate tags), tokens arrive through OpenGSC's
// settings mirror instead of a config table, and the idempotency prefix is our own.
//
// The two-step money flow is the contract's core: POST /posts only saves a task (nothing is
// billed), GET /tasks/:id/quote prices it, and POST /tasks/:id/orders submits it with the
// expected amount in a header. If the price moved since the quote the service answers
// 409 PRICE_CHANGED instead of charging — the header is never dropped to force it through.

import { createHash } from "crypto";
import { LANGUAGE_CODES } from "./languages";

export const FIELDLINK_DEFAULT_BASE = "https://seoboost-root.info/api/customer/v1";

/** Price of one post placement in minor units (0.2 credits at scale 100). */
export const POST_UNIT_MINOR = 20;

/** The service's standing bonus: 25% extra placements, per order, rounded up. */
export function bonusFor(requested: number): number {
  return Math.ceil(requested / 4);
}

export const MAX_COUNT_PER_BRIEF = 250;

export interface FieldLinkBrief {
  targetUrl: string;
  anchor: string;
  titleKeyword: string;
  language: string;
  count: number;
}

export interface FieldLinkLifecycle {
  trashedAt: string | null;
  executionState: "active" | "held" | string;
  clientStatus: "prepared" | "queued" | "processing" | "completed" | string;
  startedAt: string | null;
  cancellationLocked?: boolean;
  resumeBlockedReason?: string | null;
}

export interface FieldLinkBilling {
  mode: "reserved" | "charged" | "test-unmetered" | string;
  currency: string;
  scale: number;
  amountMinor: number;
  reservedMinor?: number;
  settledMinor?: number;
  releasedMinor?: number;
  balanceAfterMinor?: number;
}

export interface FieldLinkOrderSummary {
  id: string;
  taskId?: string;
  type?: "posts" | "links" | string;
  status: "queued" | "processing" | "completed" | "partial" | "failed" | string;
  createdAt?: string;
  updatedAt?: string;
  rowCount: number;
  requestedCount?: number;
  bonusCount?: number;
  completedCount: number;
  failedCount: number;
  lifecycle?: FieldLinkLifecycle;
  billing?: FieldLinkBilling;
}

export interface FieldLinkTask {
  id: string;
  code?: string;
  name?: string;
  status: string;
  type: "posts" | "links" | string;
  topic?: string;
  createdAt?: string;
  rowCount: number;
  placementCount: number;
  order: FieldLinkOrderSummary | null;
}

export interface FieldLinkRow {
  id: string;
  taskRowId?: string;
  placementIndex?: number;
  isBonus?: boolean;
  status: "queued" | "processing" | "completed" | "failed" | string;
  outcome?: "pending" | "success" | "failed" | string;
  input: {
    targetUrl: string;
    anchor: string;
    titleKeyword?: string;
    language: string;
    quantity?: number;
    tier?: string;
  };
  // Posts return the publication URL as `destination`; link rows return donor + text.
  result: { destination?: string; source?: string; donor?: string; text?: string } | null;
  error?: string | null;
  indexing?: { status: "in_progress" | "completed" | "attention" | null } | null;
}

export interface FieldLinkBalance {
  balanceMinor: number;
  totalBalanceMinor: number;
  reservedMinor: number;
  scale: number;
  prices?: Record<string, number>;
}

export interface FieldLinkQuote {
  placementCount: number;
  bonusCount: number;
  totalPlacementCount: number;
  amountMinor: number;
  balanceMinor: number;
  shortfallMinor: number;
  canSubmit: boolean;
  billed: boolean;
  priceVersion?: string;
  billingMode?: string;
  indexingIncluded?: boolean;
  lines?: Array<{ service: string; quantity: number; unitMinor: number; amountMinor: number }>;
}

/** One purchase brief as the modal sends it. `query` is our striking-distance context — it never
 *  reaches the service, it only rides along so the purchase ledger can mark the pair later. */
export interface BriefInput {
  targetUrl: string;
  query: string;
  anchor?: string;
  language: string;
  count: number;
}

/** Validate a brief before any paid endpoint sees it: the service would reject a malformed one
 *  too, but a legible error in our own UI beats a 400 from someone else's API. */
export function validateBrief(b: BriefInput, index = 0): FieldLinkBrief {
  const where = `row ${index + 1}`;
  const bad = (m: string): never => {
    throw new Error(`${where}: ${m}`);
  };

  const url = String(b.targetUrl ?? "").trim();
  if (!url) bad("missing target URL");
  if (url.length > 2048) bad("target URL longer than 2048 characters");
  // One row is one acceptor URL — not a list, not HTML.
  if (/\s/.test(url)) bad("target URL contains whitespace; exactly one URL per row");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return bad("target URL is not absolute");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") bad("target URL is not http(s)");
  if (parsed.username || parsed.password) bad("target URL carries a login");

  const anchor = String(b.anchor ?? b.query ?? "").trim();
  if (anchor.length < 1 || anchor.length > 300) bad("anchor must be 1-300 characters");
  if (/<[a-z/]/i.test(anchor)) bad("anchor contains HTML tags");

  const titleKeyword = String(b.query ?? "").trim();
  if (titleKeyword.length < 1 || titleKeyword.length > 300) bad("keywords must be 1-300 characters");
  if (/<[a-z/]/i.test(titleKeyword)) bad("keywords contain HTML tags");

  const language = String(b.language ?? "").trim();
  // Language is never derived from geo or guessed from the domain: only what the operator
  // picked themselves reaches the service.
  if (!LANGUAGE_CODES.has(language)) bad(`language "${language || "empty"}" is not on the service list`);

  const raw = b.count;
  const count = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT_PER_BRIEF) {
    bad(`count must be an integer from 1 to ${MAX_COUNT_PER_BRIEF}`);
  }

  // `count` leaves as a JSON number and nothing else: count together with quantity is rejected.
  return { targetUrl: url, anchor, titleKeyword, language, count };
}

/** Idempotency key derived from the body: replaying the same request must not fork tasks. */
export function idempotencyKeyFor(payload: unknown): string {
  return "ogsc-" + createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

export class FieldLinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "FieldLinkError";
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class FieldLinkClient {
  private readonly token: string;
  private readonly base: string;
  private lastAt = 0;

  // The account budget is 60 requests/minute, so calls are spaced out here: one page of our UI
  // can legitimately fire several in a row.
  constructor(token: string, base: string = FIELDLINK_DEFAULT_BASE, private readonly minIntervalMs = 250) {
    this.token = token;
    this.base = base.replace(/\/+$/, "");
  }

  private async throttle(): Promise<void> {
    const wait = this.lastAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      idempotencyKey?: string;
      expectedMinor?: number;
      retries?: number;
    } = {},
  ): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    if (opts.expectedMinor !== undefined) headers["X-FieldLink-Expected-Credits"] = String(opts.expectedMinor);

    const retries = opts.retries ?? 2;
    const backoff = [2000, 5000, 10000];
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // An authorized request never follows a redirect: the token header must not travel
        // to somebody else's origin.
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new FieldLinkError(res.status, "REDIRECT", "FieldLink answered with a redirect to another address");
      }

      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      const payload: unknown = ct.includes("json") ? safeJson(text) : text;

      if (res.ok) return payload as T;

      const retryable = res.status === 429 || res.status === 500 || res.status === 503;
      if (retryable && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff[Math.min(attempt, 2)]);
        continue;
      }
      const obj = (payload && typeof payload === "object" ? payload : {}) as { code?: string; message?: string };
      throw new FieldLinkError(res.status, obj.code, obj.message ?? `HTTP ${res.status} from FieldLink`);
    }
  }

  health() {
    return this.request<{ ok: boolean; token?: { name?: string; scopes?: string[] } }>("GET", "/health");
  }

  balance() {
    return this.request<FieldLinkBalance>("GET", "/balance");
  }

  async listTasks(limit = 100): Promise<FieldLinkTask[]> {
    const all: FieldLinkTask[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: { tasks?: FieldLinkTask[]; nextOffset: number | null } = await this.request("GET", "/tasks", {
        query: { offset, limit },
      });
      all.push(...(page.tasks ?? []));
      offset = page.nextOffset;
      if (all.length >= 1000) break; // a guard against an endless scroll
    }
    return all;
  }

  async listOrders(limit = 100): Promise<FieldLinkOrderSummary[]> {
    const page = await this.request<{ orders?: FieldLinkOrderSummary[] }>("GET", "/orders", {
      query: { offset: 0, limit },
    });
    return page.orders ?? [];
  }

  /** Saves a task. Publication does not start and no money moves. */
  createPosts(payload: { name?: string; topic: string; items: FieldLinkBrief[] }, idempotencyKey: string) {
    return this.request<{ taskId?: string; task?: { id: string }; replayed?: boolean }>("POST", "/posts", {
      body: payload,
      idempotencyKey,
    });
  }

  /** The briefs a task was saved with — the purchase ledger is written from these, not from
   *  whatever the browser happened to send, so a replayed submit cannot double-record. */
  async taskRows(taskId: string, pageSize = 100): Promise<FieldLinkBrief[]> {
    const out: FieldLinkBrief[] = [];
    let page = 0;
    for (;;) {
      const data = await this.request<{
        task?: { rows?: FieldLinkBrief[] };
        pagination?: { totalPages?: number };
      }>("GET", `/tasks/${encodeURIComponent(taskId)}/rows`, { query: { page, pageSize } });
      out.push(...(data.task?.rows ?? []));
      const totalPages = Number(data.pagination?.totalPages ?? 1);
      if (page + 1 >= totalPages) break;
      page++;
    }
    return out;
  }

  /** Submits the order: an empty body plus the amount from a just-fetched quote in the header.
   *  If the price moved in between, the service answers 409 PRICE_CHANGED — the header is not
   *  dropped to sneak past the conflict. */
  submitOrder(taskId: string, expectedMinor: number) {
    return this.request<{ order: FieldLinkOrderSummary; replayed?: boolean }>(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/orders`,
      { query: { view: "summary" }, expectedMinor },
    );
  }

  quote(taskId: string) {
    return this.request<{ quote: FieldLinkQuote }>("GET", `/tasks/${encodeURIComponent(taskId)}/quote`)
      .then(d => d.quote);
  }

  /** A whole order: reads every page and merges rows by id. Pages can shift while statuses
   *  change, so the merge is by id and not a plain concatenation. */
  async order(orderId: string, pageSize = 100): Promise<{ order: FieldLinkOrderSummary; rows: FieldLinkRow[] }> {
    const byId = new Map<string, FieldLinkRow>();
    let head: FieldLinkOrderSummary | null = null;
    let page = 0;
    for (;;) {
      const data = await this.request<{
        order: FieldLinkOrderSummary & { rows?: FieldLinkRow[]; pagination?: { totalPages?: number } };
      }>("GET", `/orders/${encodeURIComponent(orderId)}`, { query: { page, pageSize, status: "all" } });
      const ord = data.order;
      head ??= ord;
      for (const row of ord.rows ?? []) byId.set(row.id, row);
      const totalPages = Number(ord.pagination?.totalPages ?? 1);
      if (page + 1 >= totalPages) break;
      page++;
    }
    if (!head) throw new FieldLinkError(404, "NOT_FOUND", "Order not found");
    return { order: head, rows: [...byId.values()] };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
