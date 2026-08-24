// Copies the old `Backlink` rows into `SiteBacklink` (Backlinks v2).
//
//   npx tsx scripts/backfill-site-backlinks.ts          # report only, writes nothing
//   npx tsx scripts/backfill-site-backlinks.ts --apply  # write the missing rows
//
// Why this exists next to the migration
// -------------------------------------
// `prisma/migrations/20260825120000_add_site_backlinks/migration.sql` carries the same transfer
// in SQL, and on a database whose schema is built by `prisma migrate` it is the only thing that
// needs to run. This instance is not that database. `install.sh`, `update.sh`, the Docker image
// and every doc in this repo apply schema changes with `prisma db push`, which creates tables
// from `schema.prisma` and never executes a migration file. Left at the SQL alone, the three
// tables would appear empty on every real instance and the old links would silently not arrive.
//
// Re-runnable, and safe to run twice: a row whose (siteId, normalized donor URL, target) is
// already present is skipped, never rewritten. That matters more than it looks — by the time
// anyone runs this a second time the placement checker may have written real results into the
// check* columns, and re-importing would overwrite them with "unchecked".
//
// The old table is never modified or deleted. /api/backlinks/check-alive keeps reading it.

import { prisma } from "@/lib/prisma";

/**
 * The same five steps the migration's SQL performs: lowercase, drop #fragment, drop the scheme,
 * drop a leading `www.`, drop one trailing `/`.
 *
 * Deliberately not importing T2's normalizer: this has to produce keys identical to the SQL in
 * the migration file, and the two must change together or a row imported by one path will
 * duplicate the row imported by the other.
 */
function normalizeUrl(raw: string): string {
  let u = (raw || "").trim().toLowerCase();
  const hash = u.indexOf("#");
  if (hash >= 0) u = u.slice(0, hash);
  if (u.startsWith("https://")) u = u.slice(8);
  else if (u.startsWith("http://")) u = u.slice(7);
  if (u.startsWith("www.")) u = u.slice(4);
  if (u.length > 1 && u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

function domainOf(norm: string): string {
  const slash = norm.indexOf("/");
  return slash > 0 ? norm.slice(0, slash) : norm;
}

/**
 * The old liveness answer, mapped onto `pageStatus` only.
 *
 * It must never reach `checkStatus`. The old check asked "does the donor page respond?"; nothing
 * in the old table ever recorded whether our link was still on that page, so every migrated row
 * stays "unchecked". Marking them "found" would declare verified what was never verified — the
 * exact bug Backlinks v2 exists to remove.
 *
 * `isAlive === null` stays "unknown" rather than becoming "dead": null meant "not checked", and
 * for a blocked page it meant "we were refused". Neither is a death.
 */
function pageStatusOf(row: { aliveStatus: string | null; isAlive: boolean | null }): string {
  if (row.aliveStatus === "alive") return "alive";
  if (row.aliveStatus === "dead") return "dead";
  if (row.aliveStatus === "blocked") return "blocked";
  if (row.isAlive === true) return "alive";
  if (row.isAlive === false) return "dead";
  return "unknown";
}

type NewRow = {
  siteId: string; urlFrom: string; urlFromNorm: string; urlTo: string; domainFrom: string;
  checkStatus: string; pageStatus: string; pageTitle: string; pageCheckedAt: Date | null;
  xrStatus: string; xrCheckedAt: Date | null; twoIndexStatus: string; twoIndexAt: Date | null;
  source: string; sources: string; addedAt: Date;
};

const keyOf = (siteId: string, norm: string, urlTo: string) => `${siteId} ${norm} ${urlTo}`;

async function main() {
  const apply = process.argv.includes("--apply");

  // Oldest first, so that when two old rows collapse into one under the new unique key it is the
  // older row that survives — the same rule the migration's ORDER BY applies.
  const old = await prisma.backlink.findMany({ orderBy: [{ addedAt: "asc" }, { id: "asc" }] });

  const existing = await prisma.siteBacklink.findMany({
    select: { siteId: true, urlFromNorm: true, urlTo: true },
  });
  const alreadyStored = new Set(existing.map((r) => keyOf(r.siteId, r.urlFromNorm, r.urlTo)));
  const planned = new Set<string>();

  const toCreate: NewRow[] = [];
  let alreadyThere = 0;
  let collapsed = 0;

  for (const b of old) {
    const urlFromNorm = normalizeUrl(b.url);
    const key = keyOf(b.siteId, urlFromNorm, "");
    if (alreadyStored.has(key)) { alreadyThere++; continue; }
    if (planned.has(key)) { collapsed++; continue; }
    planned.add(key);
    toCreate.push({
      siteId: b.siteId,
      urlFrom: b.url,
      urlFromNorm,
      urlTo: "",
      domainFrom: domainOf(urlFromNorm),
      checkStatus: "unchecked",
      pageStatus: pageStatusOf(b),
      pageTitle: b.title ?? "",
      pageCheckedAt: b.aliveChecked ?? null,
      xrStatus: b.xrStatus ?? "",
      xrCheckedAt: b.xrChecked ?? null,
      twoIndexStatus: b.twoIndexStatus ?? "",
      twoIndexAt: b.twoIndexAt ?? null,
      source: "manual",
      sources: "manual",
      addedAt: b.addedAt,
    });
  }

  const byPageStatus = new Map<string, number>();
  for (const r of toCreate) byPageStatus.set(r.pageStatus, (byPageStatus.get(r.pageStatus) ?? 0) + 1);

  console.log(`Backlink rows:            ${old.length}`);
  console.log(`SiteBacklink rows before: ${existing.length}`);
  console.log(`Already carried over:     ${alreadyThere}`);
  console.log(`Collapsed as duplicates:  ${collapsed}   (identical after normalization)`);
  console.log(`To create:                ${toCreate.length}`);
  for (const [k, v] of [...byPageStatus].sort()) console.log(`   pageStatus=${k.padEnd(8)} ${v}`);
  console.log(`   checkStatus=unchecked  ${toCreate.length}   (always — the old check never looked for our link)`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (let i = 0; i < toCreate.length; i += 500) {
    const res = await prisma.siteBacklink.createMany({
      data: toCreate.slice(i, i + 500),
      skipDuplicates: true,
    });
    written += res.count;
  }
  console.log(`\nCreated ${written} rows.`);
  console.log(`SiteBacklink rows after:  ${await prisma.siteBacklink.count()}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
