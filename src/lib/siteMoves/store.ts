// SiteMove persistence — raw SQL, like Annotation and MagicPurchase: an instance that has not run
// `prisma db push` yet gets `null` from the readers (the caller says "needs db push") instead of a
// crash. Ownership is always the join to Site.userId, never a userId column alone.

import { rawQuery, rawExec } from "@/lib/db/raw";
import { normalizeReason, type SiteMoveRow } from "./chain";

const dayOf = (v: Date | string | number): string => new Date(v as never).toISOString().slice(0, 10);

type DbRow = {
  id: string; fromSiteId: string; toSiteId: string; date: Date | string | number;
  reason: string; redirect301: number | boolean | bigint | null; note: string | null;
};

const toRow = (r: DbRow): SiteMoveRow => ({
  id: r.id,
  fromSiteId: r.fromSiteId,
  toSiteId: r.toSiteId,
  date: dayOf(r.date),
  reason: normalizeReason(r.reason),
  redirect301: Number(r.redirect301 ?? 0) === 1 || r.redirect301 === true,
  note: r.note,
});

export function tableMissing(e: unknown): boolean {
  return /no such table|doesn't exist|does not exist/i.test(String((e as { message?: string })?.message ?? e));
}

/** Every move between the user's own sites; null when the table does not exist yet. */
export async function listUserMoves(userId: string): Promise<SiteMoveRow[] | null> {
  try {
    const rows = await rawQuery<DbRow[]>(
      `SELECT m."id", m."fromSiteId", m."toSiteId", m."date", m."reason", m."redirect301", m."note"
       FROM "SiteMove" m
       JOIN "Site" a ON a."id" = m."fromSiteId" AND a."userId" = ?
       JOIN "Site" b ON b."id" = m."toSiteId" AND b."userId" = ?
       ORDER BY m."date" ASC`,
      userId, userId,
    );
    return rows.map(toRow);
  } catch (e) {
    if (tableMissing(e)) return null;
    throw e;
  }
}

/** Moves touching one site, for markers on its charts. Empty when the table is missing. */
export async function movesForSite(siteId: string): Promise<SiteMoveRow[]> {
  try {
    const rows = await rawQuery<DbRow[]>(
      `SELECT "id", "fromSiteId", "toSiteId", "date", "reason", "redirect301", "note"
       FROM "SiteMove" WHERE "fromSiteId" = ? OR "toSiteId" = ?`,
      siteId, siteId,
    );
    return rows.map(toRow);
  } catch (e) {
    if (tableMissing(e)) return [];
    throw e;
  }
}

export async function insertMove(userId: string, m: Omit<SiteMoveRow, "id">): Promise<string> {
  const id = `mv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await rawExec(
    `INSERT INTO "SiteMove" ("id","userId","fromSiteId","toSiteId","date","reason","redirect301","note","createdAt")
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, userId, m.fromSiteId, m.toSiteId, new Date(`${m.date}T00:00:00Z`), m.reason, m.redirect301 ? 1 : 0, m.note, new Date(),
  );
  return id;
}

export async function deleteMove(userId: string, id: string): Promise<void> {
  await rawExec(
    `DELETE FROM "SiteMove" WHERE "id" = ?
     AND "fromSiteId" IN (SELECT "id" FROM "Site" WHERE "userId" = ?)`,
    id, userId,
  );
}

/** Site-level daily clicks (the aggregate row: url='' AND query='') for several sites at once. */
export async function dailyClicks(siteIds: string[], from: string, dayExpr: string): Promise<Map<string, { day: string; clicks: number }[]>> {
  const out = new Map<string, { day: string; clicks: number }[]>(siteIds.map(id => [id, []]));
  if (!siteIds.length) return out;
  const rows = await rawQuery<{ siteId: string; day: string; clicks: number | bigint }[]>(
    `SELECT "siteId", ${dayExpr} AS day, SUM("clicks") AS clicks
     FROM "DailyMetric"
     WHERE "siteId" IN (${siteIds.map(() => "?").join(",")}) AND "date" >= ? AND "url" = '' AND "query" = ''
     GROUP BY "siteId", day
     ORDER BY day ASC`,
    ...siteIds, new Date(`${from}T00:00:00Z`),
  );
  for (const r of rows) out.get(r.siteId)?.push({ day: r.day, clicks: Number(r.clicks ?? 0) });
  return out;
}
