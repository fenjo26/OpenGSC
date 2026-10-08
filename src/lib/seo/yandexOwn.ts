// The site's own Yandex positions — the "ours" side of every Yandex-market join.
//
// The competitor gap and keyword demand both split rows by "do we already rank for this". On
// Google markets that answer comes from Search Console. On the Yandex market it must come from
// Yandex — GSC positions next to Yandex ones would make "within reach" mean nothing — so the
// site's own top Yandex keywords are pulled from Keys.so and stored in CompetitorKeyword under
// the site's own domain and the region's market key (`yandexMarketKey`), refreshed at most weekly.
// Every function takes that key: Moscow and Saint Petersburg positions are different facts.

import { runUpsert } from "@/lib/db/upsert";
import { rawExec, rawQuery } from "@/lib/db/raw";
import { fetchOrganicKeywords, keyssoListUnits, type MetricsCreds } from "@/lib/seo/metrics";

/** Ten Keys.so pages of the site's own best positions. */
export const OWN_YANDEX_ROWS = 1000;
/** What a refresh can cost at most — quoted alongside any pull that may trigger one. */
export const OWN_YANDEX_UNITS = keyssoListUnits(OWN_YANDEX_ROWS);
const OWN_YANDEX_TTL_MS = 7 * 24 * 3600 * 1000;

export async function ownYandexStale(siteId: string, own: string, market: string): Promise<boolean> {
  try {
    const rows: { fetchedAt: string | null }[] = await rawQuery(
      `SELECT MAX(fetchedAt) AS fetchedAt FROM "CompetitorKeyword" WHERE siteId = ? AND competitor = ? AND country = ?`,
      siteId, own, market);
    const at = rows?.[0]?.fetchedAt;
    return !at || Date.now() - new Date(at).getTime() > OWN_YANDEX_TTL_MS;
  } catch { return true; }
}

/** Pull and store the site's own Yandex positions; returns the credits actually spent. */
export async function refreshOwnYandex(creds: MetricsCreds, siteId: string, own: string, market: string): Promise<number> {
  const res = await fetchOrganicKeywords(creds, own, { limit: OWN_YANDEX_ROWS, country: market, maxPosition: 100 });
  if (res.error && !res.items.length) return res.units;
  try {
    await rawExec(`DELETE FROM "CompetitorKeyword" WHERE siteId = ? AND competitor = ? AND country = ?`, siteId, own, market);
    const at = new Date().toISOString();
    for (const k of res.items) {
      await runUpsert({
        table: "CompetitorKeyword",
        conflict: ["siteId", "competitor", "keyword", "country"],
        values: {
          siteId, competitor: own, keyword: k.keyword, country: market,
          position: k.position ?? null, volume: k.volume ?? null, difficulty: null, url: k.url,
          source: "api", fetchedAt: at,
        },
        update: { position: "set", volume: "set", url: "set", fetchedAt: "set" },
      });
    }
  } catch { /* the "ours" side simply stays empty — every row then reads as not ranking */ }
  return res.units;
}

/** keyword → our best Yandex position and URL, from the stored own rows. */
export async function readOwnYandex(siteId: string, own: string, market: string): Promise<Map<string, { position: number; url: string }>> {
  const out = new Map<string, { position: number; url: string }>();
  try {
    const rows: { keyword: string; position: number | null; url: string | null }[] = await rawQuery(
      `SELECT keyword, position, url FROM "CompetitorKeyword" WHERE siteId = ? AND competitor = ? AND country = ?`,
      siteId, own, market);
    for (const r of rows) {
      if (r.position == null) continue;
      const k = String(r.keyword).toLowerCase();
      const prev = out.get(k);
      if (!prev || Number(r.position) < prev.position) out.set(k, { position: Number(r.position), url: String(r.url ?? "") });
    }
  } catch { /* table missing — nothing known */ }
  return out;
}
