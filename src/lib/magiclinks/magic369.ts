// 369Team (Magic 369) client — the second purchase provider.
//
// Adapted from gsc-hub (https://github.com/izzipizzy/gsc-hub, MIT). Deviations: no referral
// header (OpenGSC ships no affiliate tags) and tokens arrive through OpenGSC's settings mirror.
//
// Unlike FieldLink the order here is one-shot: POST /orders charges immediately, there is no
// separate quote call — the price comes with /balance — and the API exposes no order LIST, so
// the purchase ledger is the only history this provider has inside OpenGSC.

import { languageNameFor } from "./languages";

export const MAGIC369_DEFAULT_BASE = "https://magiclinks.online/api/v1";

export interface Magic369Balance {
  /** Balance in minor units (1 token = 100). */
  balanceMinor: number;
  /** Price of one placement in minor units. */
  priceMinor: number;
  currency: string;
}

/** An order row: exactly the fields POST /orders accepts — anything extra is a 400. */
export interface Magic369OrderRow {
  url: string;
  anchor: string;
  /** The human language name ("English"), not a code. */
  language: string;
  count: number;
}

export interface Magic369Progress {
  total: number;
  published: number;
  inProgress: number;
  awaitingContent: number;
  failed: number;
  remaining: number;
}

export interface Magic369OrderStatus {
  id: string;
  status: string;
  createdAt: string | null;
  finalizedAt: string | null;
  priceMinor: number;
  totalPriceMinor: number;
  refundedMinor: number;
  progress: Magic369Progress;
  items: {
    url: string;
    anchor: string;
    language: string;
    count: number;
    published: number;
    inProgress: number;
    awaitingContent: number;
    failed: number;
  }[];
}

export interface Magic369Article {
  id: number;
  url: string;
  anchor: string;
  title: string;
  publishedUrl: string;
  publishedAt: string | null;
}

const MINOR_SCALE = 100; // tokens arrive as decimal numbers, money is counted in minor units

function toMinor(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * MINOR_SCALE) : 0;
}

export class Magic369Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "Magic369Error";
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Magic369Client {
  private readonly token: string;
  private readonly base: string;
  private lastAt = 0;

  constructor(token: string, base: string = MAGIC369_DEFAULT_BASE, private readonly minIntervalMs = 250) {
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
    opts: { body?: unknown; retries?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const retries = opts.retries ?? 2;
    const backoff = [2000, 5000, 10000];
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // An authorized request never follows a redirect: the token header must not travel
        // to somebody else's origin.
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Magic369Error(res.status, "REDIRECT", "369Team answered with a redirect to another address");
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
      const obj = (payload && typeof payload === "object" ? payload : {}) as {
        error?: { code?: string; message?: string };
        code?: string;
        message?: string;
      };
      throw new Magic369Error(
        res.status,
        obj.error?.code ?? obj.code,
        obj.error?.message ?? obj.message ?? `HTTP ${res.status} from 369Team`,
      );
    }
  }

  /** Balance and the current placement price — the only price source in this API. */
  async balance(): Promise<Magic369Balance> {
    const d = await this.request<{ balance: number; currency?: string; price_per_placement: number }>(
      "GET",
      "/balance",
    );
    return {
      balanceMinor: toMinor(d.balance),
      priceMinor: toMinor(d.price_per_placement),
      currency: d.currency ?? "tokens",
    };
  }

  /** Creates the order and charges immediately. The API has no idempotency, so this runs only
   *  from the pay button, exactly once. */
  async createOrder(rows: Magic369OrderRow[]): Promise<{
    orderId: string;
    status: string;
    totalCount: number;
    totalPriceMinor: number;
    priceMinor: number;
    balanceAfterMinor: number;
  }> {
    const d = await this.request<{
      order_id: string;
      status: string;
      total_count: number;
      total_price: number;
      price_per_placement: number;
      balance: number;
    }>("POST", "/orders", { body: rows, retries: 0 });
    return {
      orderId: d.order_id,
      status: d.status,
      totalCount: Number(d.total_count),
      totalPriceMinor: toMinor(d.total_price),
      priceMinor: toMinor(d.price_per_placement),
      balanceAfterMinor: toMinor(d.balance),
    };
  }

  /** Order status: a progress summary plus per-row state. */
  async order(orderId: string): Promise<Magic369OrderStatus> {
    const d = await this.request<{
      order_id: string;
      status: string;
      created_at?: string | null;
      finalized_at?: string | null;
      price_per_placement: number;
      total_price: number;
      refunded?: number;
      progress?: Record<string, number>;
      items?: Record<string, unknown>[];
    }>("GET", `/orders/${encodeURIComponent(orderId)}`);

    const p = d.progress ?? {};
    const num = (k: string) => Number(p[k] ?? 0);
    return {
      id: d.order_id,
      status: d.status,
      createdAt: d.created_at ?? null,
      finalizedAt: d.finalized_at ?? null,
      priceMinor: toMinor(d.price_per_placement),
      totalPriceMinor: toMinor(d.total_price),
      refundedMinor: toMinor(d.refunded),
      progress: {
        total: num("total"),
        published: num("published"),
        inProgress: num("in_progress"),
        awaitingContent: num("awaiting_content"),
        failed: num("failed"),
        remaining: num("remaining"),
      },
      items: (d.items ?? []).map(it => ({
        url: String(it.url ?? ""),
        anchor: String(it.anchor ?? ""),
        language: String(it.language ?? ""),
        count: Number(it.count ?? 0),
        published: Number(it.published ?? 0),
        inProgress: Number(it.in_progress ?? 0),
        awaitingContent: Number(it.awaiting_content ?? 0),
        failed: Number(it.failed ?? 0),
      })),
    };
  }

  /** Already-published articles; the list grows as the order executes. */
  async orderArticles(orderId: string): Promise<Magic369Article[]> {
    const d = await this.request<{
      articles?: {
        id: number;
        url: string;
        anchor: string;
        title?: string;
        published_url: string;
        published_at?: string;
      }[];
    }>("GET", `/orders/${encodeURIComponent(orderId)}/articles`);
    return (d.articles ?? []).map(a => ({
      id: Number(a.id),
      url: a.url,
      anchor: a.anchor,
      title: a.title ?? "",
      publishedUrl: a.published_url,
      publishedAt: a.published_at ?? null,
    }));
  }
}

/** Order rows for the 369Team API from validated briefs: language codes become the human
 *  names the API expects. */
export function toMagic369Rows(items: { targetUrl: string; anchor: string; language: string; count: number }[]): Magic369OrderRow[] {
  return items.map(b => ({
    url: b.targetUrl,
    anchor: b.anchor,
    language: languageNameFor(b.language),
    count: b.count ?? 1,
  }));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
