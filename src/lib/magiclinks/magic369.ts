// 369Team (Magic 369) client — the second purchase provider, magiclinks.online/api/v1.
//
// Adapted from gsc-hub (https://github.com/izzipizzy/gsc-hub, MIT). Deviations: no referral
// header (OpenGSC ships no affiliate tags) and tokens arrive through OpenGSC's settings mirror.
//
// Checked against the vendor's Swagger 2.0 spec v1.1 (magiclinks.online/docs/doc.json,
// 2026-10-10). Two products share one token and one balance, with SEPARATE order-id spaces:
//
//   • articles ("меджики")   POST /orders       — price by volume tier, +30% bonus per row
//   • homepage links         POST /link-orders  — flat link_price,     +20% bonus per row
//
// Both orders are one-shot: the POST charges immediately, there is no quote call and no
// idempotency, and the API exposes no order LIST — the purchase ledger is the only history.

import { languageNameFor } from "./languages";

export const MAGIC369_DEFAULT_BASE = "https://magiclinks.online/api/v1";

/** Free extra placements the service adds on top of each row's paid count. */
export const MAGIC369_ARTICLE_BONUS_RATE = 0.3;
export const MAGIC369_LINK_BONUS_RATE = 0.2;

/** Link-order limits from the spec: anchor ≤ 200 chars, surrounding text ≤ 1000 with $LINK once. */
export const MAGIC369_LINK_ANCHOR_MAX = 200;
export const MAGIC369_LINK_TEXT_MAX = 1000;
export const MAGIC369_LINK_PLACEHOLDER = "$LINK";

export interface Magic369PriceTier {
  /** Smallest paid placement count (summed over the whole order) this tier applies from. */
  from: number;
  priceMinor: number;
}

export interface Magic369Balance {
  /** Balance in minor units (1 token = 100). */
  balanceMinor: number;
  /** Price of one article placement on the FIRST (smallest-order) tier, minor units. */
  priceMinor: number;
  /** Article volume tiers, ascending by `from`. Never empty: falls back to one tier at priceMinor. */
  tiers: Magic369PriceTier[];
  /** Flat price of one homepage link, minor units; null when the service did not report it. */
  linkPriceMinor: number | null;
  currency: string;
}

/** An article order row: exactly the fields POST /orders accepts — anything extra is a 400. */
export interface Magic369OrderRow {
  url: string;
  anchor: string;
  /** The language NAME as the API spells it ("English", "German", "Русский"), not a code. */
  language: string;
  count: number;
}

/** A link order row: exactly the fields POST /link-orders accepts. `text` is optional. */
export interface Magic369LinkOrderRow {
  url: string;
  anchor: string;
  count: number;
  text?: string;
}

export interface Magic369Progress {
  /** All placements of the order, bonus ones included. */
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
  /** Paid placements. */
  totalCount: number;
  bonusCount: number;
  priceMinor: number;
  totalPriceMinor: number;
  refundedMinor: number;
  progress: Magic369Progress;
  items: {
    url: string;
    anchor: string;
    /** Articles only; "" on link orders. */
    language: string;
    /** Link orders only; "" on article orders. */
    text: string;
    /** Paid placements of this row. */
    count: number;
    bonusCount: number;
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

export interface Magic369Link {
  id: number;
  url: string;
  anchor: string;
  text: string;
  website: string;
  /** The donor homepage the link sits on. */
  pageUrl: string;
  publishedAt: string | null;
}

export interface Magic369Created {
  orderId: string;
  status: string;
  /** Paid placements. */
  totalCount: number;
  bonusCount: number;
  totalPriceMinor: number;
  priceMinor: number;
  balanceAfterMinor: number;
}

const MINOR_SCALE = 100; // tokens arrive as decimal numbers, money is counted in minor units

function toMinor(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * MINOR_SCALE) : 0;
}

// ─── pure pricing ─────────────────────────────────────────────────────────────

/** Normalise the vendor's tier list: drop junk, sort ascending, fall back to the first-tier
 *  price when the list is missing (older API) so a quote is never silently zero. */
export function normalizeTiers(raw: unknown, firstTierMinor: number): Magic369PriceTier[] {
  const tiers = (Array.isArray(raw) ? raw : [])
    .map(t => {
      const r = (t ?? {}) as Record<string, unknown>;
      return { from: Math.max(0, Math.floor(Number(r.from))), priceMinor: toMinor(r.price) };
    })
    .filter(t => Number.isFinite(t.from) && t.priceMinor > 0)
    .sort((a, b) => a.from - b.from);
  return tiers.length ? tiers : [{ from: 1, priceMinor: firstTierMinor }];
}

/** The article price for an order of `paidCount` paid placements: the tier with the largest
 *  `from` not exceeding the count (spec wording). Below the first tier, the first tier applies. */
export function articlePriceFor(tiers: Magic369PriceTier[], paidCount: number): number {
  if (tiers.length === 0) return 0;
  let price = tiers[0].priceMinor;
  for (const t of tiers) {
    if (t.from <= paidCount) price = t.priceMinor;
    else break;
  }
  return price;
}

/** Bonus placements the service adds to one row. The spec states the rate (+30% / +20% per
 *  row) but not the rounding, so this is an ESTIMATE rounded down — the real figure comes back
 *  as bonus_count in the create response and the order status. */
export function estimateBonus(count: number, rate: number): number {
  return Math.max(0, Math.floor(count * rate + 1e-9));
}

/** Validates a link-order row the way the service does, so a bad row is refused here — before
 *  any money question — instead of failing the whole order there. Returns the error or null. */
export function linkRowProblem(row: { anchor: string; text?: string }): string | null {
  const anchor = row.anchor;
  if (!anchor.trim()) return "anchor is empty";
  if (anchor.length > MAGIC369_LINK_ANCHOR_MAX) return `anchor longer than ${MAGIC369_LINK_ANCHOR_MAX} characters`;
  if (/[\r\n\t]/.test(anchor)) return "anchor must be one line";
  if (/[<>]/.test(anchor)) return "anchor must not contain < or >";
  if (anchor.includes(MAGIC369_LINK_PLACEHOLDER)) return "anchor must not contain $LINK";
  const text = row.text ?? "";
  if (!text || text === MAGIC369_LINK_PLACEHOLDER) return null; // bare link
  if (text.length > MAGIC369_LINK_TEXT_MAX) return `text longer than ${MAGIC369_LINK_TEXT_MAX} characters`;
  if (/[\r\n\t]/.test(text)) return "text must be one line";
  if (/[<>]/.test(text)) return "text must not contain < or >";
  if (text.split(MAGIC369_LINK_PLACEHOLDER).length - 1 !== 1) return "text must contain $LINK exactly once (uppercase)";
  return null;
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

type RawCreated = {
  order_id: string;
  status: string;
  total_count: number;
  bonus_count?: number;
  total_price: number;
  price_per_placement: number;
  balance: number;
};

type RawStatus = {
  order_id: string;
  status: string;
  created_at?: string | null;
  finalized_at?: string | null;
  total_count?: number;
  bonus_count?: number;
  price_per_placement: number;
  total_price: number;
  refunded?: number;
  progress?: Record<string, number>;
  items?: Record<string, unknown>[];
};

function mapCreated(d: RawCreated): Magic369Created {
  return {
    orderId: String(d.order_id),
    status: String(d.status ?? ""),
    totalCount: Number(d.total_count ?? 0),
    bonusCount: Number(d.bonus_count ?? 0),
    totalPriceMinor: toMinor(d.total_price),
    priceMinor: toMinor(d.price_per_placement),
    balanceAfterMinor: toMinor(d.balance),
  };
}

function mapStatus(d: RawStatus): Magic369OrderStatus {
  const p = d.progress ?? {};
  const num = (k: string) => Number(p[k] ?? 0);
  return {
    id: String(d.order_id),
    status: String(d.status ?? ""),
    createdAt: d.created_at ?? null,
    finalizedAt: d.finalized_at ?? null,
    totalCount: Number(d.total_count ?? 0),
    bonusCount: Number(d.bonus_count ?? 0),
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
      text: String(it.text ?? ""),
      count: Number(it.count ?? 0),
      bonusCount: Number(it.bonus_count ?? 0),
      published: Number(it.published ?? 0),
      inProgress: Number(it.in_progress ?? 0),
      awaitingContent: Number(it.awaiting_content ?? 0),
      failed: Number(it.failed ?? 0),
    })),
  };
}

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
        error?: { code?: string; message?: string } | string;
        code?: string;
        message?: string;
      };
      const err = typeof obj.error === "object" && obj.error ? obj.error : undefined;
      throw new Magic369Error(
        res.status,
        err?.code ?? obj.code,
        err?.message ?? obj.message ?? (typeof obj.error === "string" ? obj.error : `HTTP ${res.status} from 369Team`),
      );
    }
  }

  /** Balance plus every price the service publishes — the only price source in this API. */
  async balance(): Promise<Magic369Balance> {
    const d = await this.request<{
      balance: number;
      currency?: string;
      price_per_placement: number;
      price_tiers?: { from: number; price: number }[];
      link_price?: number | null;
    }>("GET", "/balance");
    const priceMinor = toMinor(d.price_per_placement);
    return {
      balanceMinor: toMinor(d.balance),
      priceMinor,
      tiers: normalizeTiers(d.price_tiers, priceMinor),
      linkPriceMinor: d.link_price == null ? null : toMinor(d.link_price),
      currency: d.currency ?? "tokens",
    };
  }

  /** Creates an ARTICLE order and charges immediately. No idempotency: runs only from the pay
   *  button, exactly once, never retried. */
  async createOrder(rows: Magic369OrderRow[]): Promise<Magic369Created> {
    return mapCreated(await this.request<RawCreated>("POST", "/orders", { body: rows, retries: 0 }));
  }

  /** Article order status: a progress summary plus per-row state. */
  async order(orderId: string): Promise<Magic369OrderStatus> {
    return mapStatus(await this.request<RawStatus>("GET", `/orders/${encodeURIComponent(orderId)}`));
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

  /** Creates a HOMEPAGE-LINK order and charges immediately (count × link_price). Same
   *  one-shot rule as createOrder. */
  async createLinkOrder(rows: Magic369LinkOrderRow[]): Promise<Magic369Created> {
    return mapCreated(await this.request<RawCreated>("POST", "/link-orders", { body: rows, retries: 0 }));
  }

  /** Link order status. Link-order ids are a separate space from article-order ids. */
  async linkOrder(orderId: string): Promise<Magic369OrderStatus> {
    return mapStatus(await this.request<RawStatus>("GET", `/link-orders/${encodeURIComponent(orderId)}`));
  }

  /** Already-placed links of a link order. */
  async linkOrderLinks(orderId: string): Promise<Magic369Link[]> {
    const d = await this.request<{
      links?: {
        id: number;
        url: string;
        anchor: string;
        text?: string;
        website?: string;
        page_url?: string;
        published_at?: string | null;
      }[];
    }>("GET", `/link-orders/${encodeURIComponent(orderId)}/links`);
    return (d.links ?? []).map(l => ({
      id: Number(l.id),
      url: l.url,
      anchor: l.anchor,
      text: l.text ?? "",
      website: l.website ?? "",
      pageUrl: l.page_url ?? "",
      publishedAt: l.published_at ?? null,
    }));
  }
}

/** Article order rows from validated briefs: language codes become the names the API expects. */
export function toMagic369Rows(items: { targetUrl: string; anchor: string; language: string; count: number }[]): Magic369OrderRow[] {
  return items.map(b => ({
    url: b.targetUrl,
    anchor: b.anchor,
    language: languageNameFor(b.language),
    count: b.count ?? 1,
  }));
}

/** Link order rows. `text` is sent only when it actually wraps the link — an empty or bare
 *  "$LINK" text means "bare link", which is what omitting the field already says. Throws with
 *  the 1-based row number on a row the service would reject. */
export function toMagic369LinkRows(
  items: { targetUrl: string; anchor: string; count: number; text?: string }[],
): Magic369LinkOrderRow[] {
  return items.map((b, i) => {
    const text = (b.text ?? "").trim();
    const problem = linkRowProblem({ anchor: b.anchor, text });
    if (problem) throw new Error(`row ${i + 1}: ${problem}`);
    const row: Magic369LinkOrderRow = { url: b.targetUrl, anchor: b.anchor, count: b.count ?? 1 };
    if (text && text !== MAGIC369_LINK_PLACEHOLDER) row.text = text;
    return row;
  });
}

/** Paid amount and bonus estimate for an ARTICLE order (tier picked by the order's total). */
export function quoteArticles(balance: Magic369Balance, counts: number[]): { paid: number; bonus: number; priceMinor: number; amountMinor: number } {
  const paid = counts.reduce((s, c) => s + c, 0);
  const priceMinor = articlePriceFor(balance.tiers, paid);
  return {
    paid,
    bonus: counts.reduce((s, c) => s + estimateBonus(c, MAGIC369_ARTICLE_BONUS_RATE), 0),
    priceMinor,
    amountMinor: paid * priceMinor,
  };
}

/** Paid amount and bonus estimate for a LINK order (flat price). Null price → cannot quote. */
export function quoteLinks(balance: Magic369Balance, counts: number[]): { paid: number; bonus: number; priceMinor: number; amountMinor: number } | null {
  if (balance.linkPriceMinor == null || balance.linkPriceMinor <= 0) return null;
  const paid = counts.reduce((s, c) => s + c, 0);
  return {
    paid,
    bonus: counts.reduce((s, c) => s + estimateBonus(c, MAGIC369_LINK_BONUS_RATE), 0),
    priceMinor: balance.linkPriceMinor,
    amountMinor: paid * balance.linkPriceMinor,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
