// Storage for the backlink profile: referring domains and daily summaries.
//
// The interesting part is `syncRefDomains`. A provider only tells you what is live right now,
// but the question people actually have is "what changed" — and change is the difference
// between this pull and the last one. Computing it locally means new and lost links fall out of
// a single request rather than costing a second one, and it works identically for an imported
// CSV, which has no notion of history at all.
//
// Raw SQL with swallowed errors throughout, like the rest of the metrics layer: on a database
// that has not run `prisma db push`, every one of these returns empty instead of taking a page
// down with it.

import { runUpsert } from "@/lib/db/upsert";
import { rawQuery, rawExec } from "@/lib/db/raw";

export interface RefDomainRecord {
  refDomain: string;
  dr: number | null;
  linksToTarget: number | null;
  dofollow: boolean;
  firstSeen: string;
  lost: boolean;
  lostAt: string;
  source: "api" | "csv";
  fetchedAt: string;
}

export interface SyncResult {
  seen: number;
  added: number;
  lost: number;
}

const today = () => new Date().toISOString().slice(0, 10);
export const normDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

export async function readRefDomains(
  target: string,
  opts: { provider?: string; includeLost?: boolean; limit?: number } = {},
): Promise<RefDomainRecord[]> {
  const provider = opts.provider ?? "ahrefs";
  const limit = Math.max(1, Math.min(2000, opts.limit ?? 500));
  try {
    const rows: any[] = await rawQuery(
      `SELECT refDomain, dr, linksToTarget, dofollow, firstSeen, lost, lostAt, source, fetchedAt
         FROM "RefDomainRow"
        WHERE target = ? AND provider = ?${opts.includeLost ? "" : " AND lost = 0"}
        ORDER BY lost ASC, dr DESC
        LIMIT ${limit}`,
      normDomain(target), provider,
    );
    return rows.map(r => ({
      refDomain: r.refDomain,
      dr: r.dr == null ? null : Number(r.dr),
      linksToTarget: r.linksToTarget == null ? null : Number(r.linksToTarget),
      dofollow: !!r.dofollow,
      firstSeen: r.firstSeen ?? "",
      lost: !!r.lost,
      lostAt: r.lostAt ?? "",
      source: r.source === "csv" ? "csv" : "api",
      fetchedAt: new Date(r.fetchedAt).toISOString(),
    }));
  } catch {
    return [];
  }
}

export interface RefDomainInput {
  refDomain: string;
  dr?: number | null;
  linksToTarget?: number | null;
  dofollow?: boolean;
  firstSeen?: string;
}

/**
 * Writes the live set and marks everything else as lost.
 *
 * `complete` is the crucial argument. A full pull can conclude that an absent domain is gone; a
 * partial one — a CSV filtered to DR ≥ 50, or a capped limit — absolutely cannot, and marking
 * those as lost would invent link losses that never happened and fire alerts about them. When
 * in doubt the caller passes `false` and only additions are recorded.
 */
export async function syncRefDomains(
  target: string,
  rows: RefDomainInput[],
  opts: { provider?: string; source?: "api" | "csv"; complete: boolean },
): Promise<SyncResult> {
  const t = normDomain(target);
  const provider = opts.provider ?? "ahrefs";
  const source = opts.source ?? "api";
  const at = new Date().toISOString();
  const day = today();

  const before = await readRefDomains(t, { provider, includeLost: true, limit: 2000 });
  const knownLive = new Set(before.filter(r => !r.lost).map(r => r.refDomain));
  const seenNow = new Set<string>();
  let added = 0;

  for (const r of rows) {
    const d = normDomain(r.refDomain);
    if (!d.includes(".")) continue;
    seenNow.add(d);
    if (!knownLive.has(d)) added++;
    try {
      await runUpsert({
        table: "RefDomainRow",
        conflict: ["target", "refDomain", "provider"],
        values: {
          target: t, refDomain: d, provider,
          dr: r.dr ?? null,
          linksToTarget: r.linksToTarget ?? null,
          dofollow: r.dofollow === false ? 0 : 1,
          firstSeen: r.firstSeen ?? "",
          // A domain present in this pull is live by definition, so both insert and update
          // reset the lost flag — that is how a link that came back stops reading as lost.
          lost: 0, lostAt: "",
          source, fetchedAt: at,
        },
        update: {
          dr: "keep", linksToTarget: "keep",
          dofollow: "set",
          firstSeen: "keepEmpty",
          lost: "set", lostAt: "set",
          source: "set", fetchedAt: "set",
        },
      });
    } catch { /* best effort */ }
  }

  let lost = 0;
  if (opts.complete) {
    for (const prev of before) {
      if (prev.lost || seenNow.has(prev.refDomain)) continue;
      try {
        await rawExec(
          `UPDATE "RefDomainRow" SET lost = 1, lostAt = ? WHERE target = ? AND refDomain = ? AND provider = ?`,
          day, t, prev.refDomain, provider,
        );
        lost++;
      } catch { /* best effort */ }
    }
  }

  return { seen: seenNow.size, added, lost };
}

// ─── Daily summary ─────────────────────────────────────────────────────────────

export interface Snapshot {
  date: string;
  refDomains: number | null;
  backlinks: number | null;
  dofollowPct: number | null;
}

/** One row per day: a second pull on the same day corrects it rather than adding noise. */
export async function writeSnapshot(
  target: string,
  s: { refDomains?: number | null; backlinks?: number | null; dofollowPct?: number | null },
  opts: { provider?: string; source?: "api" | "csv" } = {},
): Promise<void> {
  try {
    await runUpsert({
      table: "BacklinkSnapshot",
      conflict: ["target", "date", "provider"],
      values: {
        target: normDomain(target), date: today(), provider: opts.provider ?? "ahrefs",
        refDomains: s.refDomains ?? null,
        backlinks: s.backlinks ?? null,
        dofollowPct: s.dofollowPct ?? null,
        source: opts.source ?? "api",
        createdAt: new Date().toISOString(),
      },
      // `createdAt` is absent from the update map on purpose: a correction later the same day
      // should not move the moment the day's row was first written.
      update: {
        refDomains: "keep", backlinks: "keep", dofollowPct: "keep",
        source: "set",
      },
    });
  } catch { /* best effort */ }
}

export async function readSnapshots(target: string, limit = 90, provider = "ahrefs"): Promise<Snapshot[]> {
  try {
    const rows: any[] = await rawQuery(
      `SELECT date, refDomains, backlinks, dofollowPct FROM "BacklinkSnapshot"
        WHERE target = ? AND provider = ? ORDER BY date DESC LIMIT ${Math.max(1, Math.min(365, limit))}`,
      normDomain(target), provider,
    );
    return rows.map(r => ({
      date: r.date,
      refDomains: r.refDomains == null ? null : Number(r.refDomains),
      backlinks: r.backlinks == null ? null : Number(r.backlinks),
      dofollowPct: r.dofollowPct == null ? null : Number(r.dofollowPct),
    })).reverse();
  } catch {
    return [];
  }
}

/** Referring domains marked lost since a given day — the input to the lost-link alert. */
export async function lostSince(target: string, sinceDay: string, minDr: number, provider = "ahrefs") {
  try {
    const rows: any[] = await rawQuery(
      `SELECT refDomain, dr, lostAt FROM "RefDomainRow"
        WHERE target = ? AND provider = ? AND lost = 1 AND lostAt >= ? AND dr >= ?
        ORDER BY dr DESC LIMIT 50`,
      normDomain(target), provider, sinceDay, minDr,
    );
    return rows.map(r => ({ refDomain: r.refDomain, dr: Number(r.dr ?? 0), lostAt: r.lostAt }));
  } catch {
    return [];
  }
}
