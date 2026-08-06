// Fills `Site.market` for every site whose ccTLD names its country, and lists the ones it
// refuses to guess.
//
//   npx tsx scripts/backfill-site-market.ts          # report only, writes nothing
//   npx tsx scripts/backfill-site-market.ts --apply  # write the inferable ones
//
// Why a script and not a migration
// --------------------------------
// A migration that guessed would be the exact bug this whole change exists to remove. `.gr` is
// Greece and that is safe to write; `.com`, `.org`, `.vip` and `.click` are sold worldwide and
// say nothing, so they are printed for a human to answer rather than filled with a plausible
// default. The dry run is the default for the same reason: this writes to the column that
// decides which country every future keyword purchase is filed under.
//
// Re-runnable. Sites that already carry a market are never touched, so a hand-corrected value
// survives every later run.

import { prisma } from "@/lib/prisma";
import { marketFromDomain, tldOf } from "@/lib/seo/market";

async function main() {
  const apply = process.argv.includes("--apply");

  const sites = await prisma.site.findMany({
    select: { id: true, url: true, siteId: true, market: true },
    orderBy: { url: "asc" },
  });

  const already: string[] = [];
  const inferable: { id: string; url: string; market: string }[] = [];
  const unknown: { url: string; tld: string }[] = [];

  for (const s of sites) {
    if ((s.market || "").trim()) { already.push(s.url); continue; }
    const guess = marketFromDomain(s.url || s.siteId || "");
    if (guess) inferable.push({ id: s.id, url: s.url, market: guess });
    else unknown.push({ url: s.url, tld: tldOf(s.url || s.siteId || "") || "—" });
  }

  console.log(`Sites:            ${sites.length}`);
  console.log(`Already set:      ${already.length}`);
  console.log(`Inferable (ccTLD):${inferable.length}`);
  console.log(`Needs a human:    ${unknown.length}`);

  const byMarket = new Map<string, number>();
  for (const i of inferable) byMarket.set(i.market, (byMarket.get(i.market) ?? 0) + 1);
  if (byMarket.size) {
    console.log("\nWould set:");
    for (const [m, n] of [...byMarket].sort((a, z) => z[1] - a[1])) console.log(`  ${m}  ${n}`);
  }

  if (unknown.length) {
    console.log("\nGeneric TLD — market cannot be inferred, set it in the site's settings:");
    for (const u of unknown) console.log(`  ${u.url}  (.${u.tld})`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write the inferable ones.");
    return;
  }

  let written = 0;
  for (const i of inferable) {
    await prisma.site.update({ where: { id: i.id }, data: { market: i.market } });
    written++;
  }
  console.log(`\nWrote ${written} markets. The ${unknown.length} generic-TLD sites were left empty.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
