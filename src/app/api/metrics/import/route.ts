import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  decodeExport, parseTable, detectReport, mapKeywordRows, mapDomainRows, mapRefDomainRows,
} from "@/lib/seo/metricsCsv";
import { writeKeywordCache, writeDomainCache } from "@/lib/seo/metricsStore";
import { syncRefDomains } from "@/lib/seo/backlinkStore";

export const runtime = "nodejs";

// POST /api/metrics/import  (multipart/form-data)
//   file: the export downloaded from Ahrefs/Semrush
//   country: which market the keyword figures belong to (exports do not always say)
//   provider: which vendor produced the file — kept so a Semrush volume never silently
//             overwrites an Ahrefs one for the same keyword
//   observedAt: optional export date; see below
//
// This is the free half of the metrics feature and, for anyone on a browser-only subscription,
// the only half. It writes into exactly the same cache the paid path fills, so every consumer
// works identically whether the numbers were bought or uploaded.

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "bad_form" }, { status: 400 }); }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const country = String(form.get("country") ?? "us").toLowerCase();
  const provider = String(form.get("provider") ?? "ahrefs") === "semrush" ? "semrush" : "ahrefs";

  // An export is a snapshot of the day it was generated, not of the day it was uploaded. Dating
  // it "now" would let a month-old file outrank fresher API data in the write guard, which is
  // the exact silent-regression this parameter exists to prevent. The browser sends the file's
  // lastModified; when that is missing we fall back to now and accept the risk knowingly.
  const observedRaw = String(form.get("observedAt") ?? "");
  const observedAt = observedRaw && !Number.isNaN(Date.parse(observedRaw))
    ? new Date(observedRaw)
    : new Date();

  const text = decodeExport(await file.arrayBuffer());
  const table = parseTable(text);
  if (!table.headers.length) {
    return NextResponse.json({ error: "empty_file" }, { status: 400 });
  }

  const kind = detectReport(table.headers);
  if (!kind) {
    return NextResponse.json({
      error: "unknown_report",
      headers: table.headers.slice(0, 25),
    }, { status: 400 });
  }

  // A header-only export is a different failure from an unreadable one, and conflating them
  // sends people hunting for a parser bug that does not exist. This happens for real: a filter
  // or a date range with no results still downloads, producing a valid file with zero rows.
  // Reporting the recognised report type alongside the error is what makes that legible.
  if (!table.rows.length) {
    return NextResponse.json({
      error: "no_data_rows", kind, headers: table.headers.slice(0, 25),
    }, { status: 400 });
  }

  if (kind === "keywords") {
    const rows = mapKeywordRows(table);
    const written = await writeKeywordCache(rows, country, provider, "csv", observedAt);
    return NextResponse.json({
      kind, parsed: rows.length, written, country, provider,
      observedAt: observedAt.toISOString(),
      withDifficulty: rows.some(r => r.difficulty != null),
    });
  }

  if (kind === "refdomains") {
    // A referring-domains file lists links pointing AT something, and the file never says at
    // what. Without a target the rows are unattributable, so this is the one report that needs
    // the user to say which site it belongs to.
    const siteId = String(form.get("siteId") ?? "");
    const site = siteId
      ? await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } })
      : null;
    if (!site) return NextResponse.json({ error: "need_site" }, { status: 400 });

    const rows = mapRefDomainRows(table);
    // Never `complete`: an export may be filtered or truncated in ways the file does not record,
    // and treating absence as removal would invent lost links — and alert about them.
    const sync = await syncRefDomains(site.url.replace(/^sc-domain:/, ""), rows, {
      provider, source: "csv", complete: false,
    });
    return NextResponse.json({ kind, parsed: rows.length, written: sync.seen, added: sync.added, provider });
  }

  const rows = mapDomainRows(table);
  const written = await writeDomainCache(rows, provider, "csv", observedAt);
  return NextResponse.json({
    kind, parsed: rows.length, written, provider,
    observedAt: observedAt.toISOString(),
  });
}
