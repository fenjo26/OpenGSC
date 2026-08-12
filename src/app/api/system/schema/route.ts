import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { currentDialect } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";

// GET /api/system/schema — which expected tables are missing from the database.
//
// This exists because of a failure mode the codebase deliberately created and then had no way to
// report. Every feature added after the initial schema reads its tables through
// `$queryRawUnsafe` inside a `try { } catch { return empty }`, so that an instance which has not
// run `prisma db push` degrades instead of crashing. That is the right call — a missing table
// should not take down the dashboard — but it makes an un-migrated database indistinguishable
// from an empty one. "Find competitors, then pull the keywords of one of them" is what the
// Competitors screen says both when you have not pulled anything yet and when the table it would
// pull into does not exist.
//
// One cheap read of `sqlite_master` tells the two apart, and the banner turns a silent nothing
// into a sentence naming the command to run.

/**
 * Tables added after the first release, in the order they arrived. Not the full schema — only
 * the ones whose absence is survivable and therefore silent. A missing `Site` table would crash
 * long before anything got here.
 */
const EXPECTED_TABLES: { table: string; feature: string }[] = [
  { table: "KeywordMetricCache", feature: "Keyword weights" },
  { table: "DomainMetricCache", feature: "Domain metrics" },
  { table: "RefDomainRow", feature: "Backlink profile" },
  { table: "BacklinkSnapshot", feature: "Backlink history" },
  { table: "CompetitorKeyword", feature: "Competitors" },
  { table: "KeywordVolumeHistory", feature: "Demand check in Content Decay" },
  { table: "ApiUsage", feature: "Spending cap" },
  { table: "DemandSearch", feature: "Demand" },
  { table: "EnginePortfolioCache", feature: "Bing / Yandex portfolio" },
  { table: "SiteAudit", feature: "Site Audit" },
  { table: "AlertEvent", feature: "Alerts" },
  { table: "Digest", feature: "Digests" },
  { table: "GeoAudit", feature: "GEO Audit" },
  { table: "LinkWatchBrand", feature: "Link Monitor" },
  { table: "OutreachCampaign", feature: "Outreach Workspace" },
  { table: "OutreachProspect", feature: "Outreach Workspace" },
  { table: "OutreachStageEvent", feature: "Outreach Workspace" },
  { table: "ContentRepository", feature: "Content Operations" },
  { table: "ContentOperation", feature: "Content Operations" },
  { table: "ContentOperationEvent", feature: "Content Operations" },
  { table: "SourceAuditRun", feature: "Source Audit" },
];

export async function GET() {
  // Session-gated, not owner-gated: it reports table names, nothing about data, and a guest on a
  // share link has no shell to show the banner in anyway.
  const workspaceId = await workspaceUserId();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let present = new Set<string>();
  try {
    // `sqlite_master` does not exist outside SQLite, and this check would otherwise report every
    // table as missing on MySQL — turning the "run prisma db push" banner into a permanent false
    // alarm on exactly the setup that is hardest to debug.
    const rows: any[] = currentDialect() === "mysql"
      ? await rawQuery(
          `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
        )
      : await rawQuery(
          `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
    // Lower-cased on both sides, because MySQL on Windows runs with lower_case_table_names=1 and
    // stores every table folded to lowercase. `KeywordMetricCache` comes back as
    // `keywordmetriccache`, an exact-match check finds none of the expected tables, and the banner tells
    // a correctly migrated instance to run `prisma db push` — which then reports the schema is
    // already in sync, leaving the user with two tools contradicting each other.
    present = new Set(rows.map(r => String(r.name).toLowerCase()));
  } catch {
    // Reading sqlite_master itself failing means something is wrong that this endpoint is not
    // equipped to diagnose. Report "cannot tell" rather than "everything is missing", which
    // would put a false alarm on every screen.
    return NextResponse.json({ ok: true, checked: false, missing: [] });
  }

  const missing = EXPECTED_TABLES.filter(t => !present.has(t.table.toLowerCase()));

  return NextResponse.json({
    ok: missing.length === 0,
    checked: true,
    missing: missing.map(m => m.table),
    features: [...new Set(missing.map(m => m.feature))],
  });
}
