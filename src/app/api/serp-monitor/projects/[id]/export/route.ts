// SERP Monitor — CSV export.
//
// kind=keywords is the "фразы для Ahrefs" button: active keywords one per line, no header,
// no quoting — it is pasted into Keywords Explorer as-is. kind=domains is the catalogue with
// the same filters as the listing, all pages, RFC 4180 quoting, UTF-8 BOM for Excel.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  csvLine, domainQueryFromSearchParams, domainRows, isSchemaMissing, slugifyName,
} from "@/lib/serpmon/domains";

const BOM = "\uFEFF";
const DOMAIN_CSV_COLUMNS = [
  "domain", "registrable", "keywords", "prev_keywords", "top10", "top30",
  "best", "avg", "first_seen", "registered", "age_months", "dr", "refdomains", "tags",
] as const;

function csvResponse(body: string, filename: string): Response {
  return new Response(BOM + body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "");
const num = (v: number | null): number | string => (v == null ? "" : Math.round(v * 10) / 10);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("read");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const kind = new URL(req.url).searchParams.get("kind");
  if (kind !== "keywords" && kind !== "domains") {
    return NextResponse.json({ error: "kind must be keywords or domains" }, { status: 400 });
  }

  let project: { id: string; name: string } | null = null;
  try {
    project = await prisma.serpProject.findFirst({ where: { id, userId }, select: { id: true, name: true } });
  } catch (e) {
    if (isSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
  if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const today = new Date().toISOString().slice(0, 10);
  const filename = `serpmon-${slugifyName(project.name)}-${kind}-${today}.csv`;

  if (kind === "keywords") {
    try {
      const keywords = await prisma.serpKeyword.findMany({
        where: { projectId: id, active: true },
        orderBy: { createdAt: "asc" },
        select: { keyword: true },
      });
      const body = keywords.map(k => k.keyword).join("\n");
      return csvResponse(body ? `${body}\n` : "", filename);
    } catch (e) {
      if (isSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
      throw e;
    }
  }

  // Same filters as the listing, every page: walk the pages until the honest `total` is reached.
  const query = domainQueryFromSearchParams(new URL(req.url).searchParams);
  delete query.page;
  delete query.pageSize;
  query.pageSize = 200;
  const lines: string[] = [csvLine(DOMAIN_CSV_COLUMNS)];
  try {
    for (let page = 1; ; page++) {
      const result = await domainRows(userId, id, { ...query, page });
      if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
      for (const r of result.rows) {
        lines.push(csvLine([
          r.host, r.registrable, r.keywords, r.prevKeywords, r.top10, r.top30,
          r.bestPos ?? "", num(r.avgPos), day(r.firstSeenAt), day(r.registeredAt),
          r.ageMonths ?? "", r.dr ?? "", r.refdomains ?? "", r.tags.join(" "),
        ]));
      }
      if (result.rows.length === 0 || lines.length - 1 >= result.total) break;
    }
  } catch (e) {
    if (isSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
  return csvResponse(lines.join(""), filename);
}
