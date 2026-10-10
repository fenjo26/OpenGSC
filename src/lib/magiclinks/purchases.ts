// The purchase ledger — one row per accepted brief of a PAID order.
//
// A trace is written only after the provider accepted the order: a task that was created but
// never paid for is not a purchase, and marking it one would tell the striking-distance table
// a pair is covered when nothing was bought. For FieldLink the briefs are re-read from the
// service itself (taskRows) rather than trusted from the browser, and orderRecorded keeps a
// replayed submit from writing the order twice.
//
// Raw SQL throughout, following the convention for tables added after the initial schema (see
// docs/ARCHITECTURE.md §2 and the annotations route): an instance that has not run
// `prisma db push` yet gets empty lists instead of crashes.

import { rawQuery, rawExec } from "@/lib/db/raw";

export const PROVIDER_FIELDLINK = "fieldlink";
export const PROVIDER_MAGIC369 = "magic369";
/** 369Team homepage links (POST /link-orders) — same token and balance as PROVIDER_MAGIC369,
 *  but a separate product with its own order-id space, so it is its own provider id: the
 *  ledger, the tracker and the order views must know which endpoint an order id belongs to. */
export const PROVIDER_MAGIC369_LINKS = "magic369links";
export type MagicProviderId = "fieldlink" | "magic369" | "magic369links";

export function isMagicProviderId(v: unknown): v is MagicProviderId {
  return v === PROVIDER_FIELDLINK || v === PROVIDER_MAGIC369 || v === PROVIDER_MAGIC369_LINKS;
}

export function providerName(p: string): string {
  return p === PROVIDER_MAGIC369 ? "369Team"
    : p === PROVIDER_MAGIC369_LINKS ? "369Team · links"
    : p === PROVIDER_FIELDLINK ? "FieldLink"
    : p;
}

export interface PurchaseInput {
  siteId: string;
  targetUrl: string;
  query: string;
  anchor?: string;
  language: string;
  quantity: number;
  taskId: string | null;
  orderId: string;
  provider: MagicProviderId;
}

export interface PurchaseRow extends PurchaseInput {
  id: string;
  createdAt: Date;
}

interface DbRow {
  id: string; siteId: string; provider: string; orderId: string; taskId: string | null;
  query: string; targetUrl: string; anchor: string | null; language: string; quantity: number;
  createdAt: Date | string | number;
}

const COLS = `"id", "siteId", "provider", "orderId", "taskId", "query", "targetUrl", "anchor", "language", "quantity", "createdAt"`;

const toRow = (r: DbRow): PurchaseRow => ({
  id: r.id,
  siteId: r.siteId,
  provider: r.provider as MagicProviderId,
  orderId: r.orderId,
  taskId: r.taskId,
  query: r.query,
  targetUrl: r.targetUrl,
  anchor: r.anchor ?? undefined,
  language: r.language,
  quantity: Number(r.quantity),
  createdAt: new Date(r.createdAt),
});

/** One marker per order and site — the unit the chart and the annotations timeline draw, so a
 *  fifty-row order is one dated event and not a picket fence. Derived on read from the ledger,
 *  never stored: re-imports and retried submits cannot duplicate what is not persisted twice.
 *
 *  The date is the order day in UTC — a fact about when the money moved, not a claim that the
 *  placements are already live. Publications follow later; the reader is told so in the UI. */
export interface PurchaseOrderEvent {
  orderId: string;
  provider: MagicProviderId;
  /** UTC day of the earliest ledger row of this order, ISO YYYY-MM-DD. */
  dayUtc: string;
  quantity: number;
  targetUrls: string[];
  queries: string[];
  createdAt: Date;
}

export async function recordPurchases(rows: PurchaseInput[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map(r => {
    const id = `mp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tuple = "(?,?,?,?,?,?,?,?,?,?,?)";
    values.push(
      id, r.siteId, r.provider, r.orderId, r.taskId, r.query, r.targetUrl,
      r.anchor ?? r.query, r.language, r.quantity, new Date(),
    );
    return tuple;
  });
  // One INSERT for the whole batch: a partially-written order history is worse than none.
  await rawExec(
    `INSERT INTO "MagicPurchase" ("id","siteId","provider","orderId","taskId","query","targetUrl","anchor","language","quantity","createdAt")
     VALUES ${tuples.join(",")}`,
    ...values,
  );
}

export async function orderRecorded(orderId: string): Promise<boolean> {
  try {
    const rows = await rawQuery<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM "MagicPurchase" WHERE "orderId" = ?`, orderId,
    );
    return Number(rows?.[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Ledger rows for one site, newest first. Empty (not an error) before `prisma db push`. */
export async function listPurchases(siteId: string, limit = 500): Promise<PurchaseRow[]> {
  try {
    const rows = await rawQuery<DbRow[]>(
      `SELECT ${COLS} FROM "MagicPurchase"
       WHERE "siteId" = ?
       ORDER BY "createdAt" DESC LIMIT ?`,
      siteId, limit,
    );
    return rows.map(toRow);
  } catch {
    return [];
  }
}

/** Ledger rows across every site of one user, newest first — the /magiclinks page feed. */
export async function listUserPurchases(userId: string, limit = 2000): Promise<PurchaseRow[]> {
  try {
    const rows = await rawQuery<DbRow[]>(
      `SELECT p."id", p."siteId", p."provider", p."orderId", p."taskId", p."query", p."targetUrl", p."anchor", p."language", p."quantity", p."createdAt"
       FROM "MagicPurchase" p
       JOIN "Site" s ON s."id" = p."siteId"
       WHERE s."userId" = ?
       ORDER BY p."createdAt" DESC LIMIT ?`,
      userId, limit,
    );
    return rows.map(toRow);
  } catch {
    return [];
  }
}

/** Per pair "query + URL": how much was bought in total and when last — the striking-distance
 *  table marks these so the same pair is not bought a second time by accident. */
export interface PurchaseSummary {
  targetUrl: string;
  query: string;
  quantity: number;
  lastAt: string;
}

export function summarize(rows: PurchaseRow[]): PurchaseSummary[] {
  const byKey = new Map<string, PurchaseSummary>();
  for (const r of rows) {
    if (r.quantity <= 0) continue;
    const key = `${r.query}\n${r.targetUrl}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.quantity += r.quantity;
      if (r.createdAt > new Date(cur.lastAt)) cur.lastAt = r.createdAt.toISOString();
    } else {
      byKey.set(key, {
        targetUrl: r.targetUrl,
        query: r.query,
        quantity: r.quantity,
        lastAt: r.createdAt.toISOString(),
      });
    }
  }
  return [...byKey.values()];
}

/** Purchase rows folded into one event per order, for chart markers and the annotations
 *  timeline. `sinceIso` keeps the list inside the caller's lookback window. */
export async function purchaseOrderEvents(siteId: string, sinceIso?: string, limit = 100): Promise<PurchaseOrderEvent[]> {
  let rows: PurchaseRow[];
  try {
    const all = await rawQuery<DbRow[]>(
      `SELECT ${COLS} FROM "MagicPurchase" WHERE "siteId" = ? ORDER BY "createdAt" ASC`,
      siteId,
    );
    rows = all.map(toRow);
  } catch {
    return [];
  }
  if (sinceIso) rows = rows.filter(r => r.createdAt.toISOString().slice(0, 10) >= sinceIso);

  const byOrder = new Map<string, PurchaseOrderEvent>();
  for (const r of rows) {
    if (r.quantity <= 0) continue;
    let ev = byOrder.get(r.orderId);
    if (!ev) {
      ev = {
        orderId: r.orderId,
        provider: r.provider,
        dayUtc: r.createdAt.toISOString().slice(0, 10),
        quantity: 0,
        targetUrls: [],
        queries: [],
        createdAt: r.createdAt,
      };
      byOrder.set(r.orderId, ev);
    }
    ev.quantity += r.quantity;
    // The order's day is its EARLIEST row: with per-row dates a hair apart, the marker must
    // sit on the day the order started, not on whichever row sorted last.
    if (r.createdAt < ev.createdAt) {
      ev.createdAt = r.createdAt;
      ev.dayUtc = r.createdAt.toISOString().slice(0, 10);
    }
    if (!ev.targetUrls.includes(r.targetUrl)) ev.targetUrls.push(r.targetUrl);
    if (r.query && !ev.queries.includes(r.query)) ev.queries.push(r.query);
  }
  return [...byOrder.values()].sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf()).slice(0, limit);
}
