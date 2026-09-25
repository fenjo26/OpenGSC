// N8 — the public, token-gated surface of ONE client report (CONTRACT §0.7): the list of
// its frozen snapshots and, with ?run=<id>&format=html|pdf, an artifact. No session — the
// proxy lets /api/reports/share/ through and this route is the whole access check.
//
// The token is compared in constant time: every stored shareToken is hashed and compared
// with timingSafeEqual, so response time does not depend on how much of the token matched
// (a WHERE shareToken = ? lookup would). The row cap is generous (1000 reports with a
// link) and honest — beyond it the scan is not exhaustive, so it refuses instead of
// pretending: an agency that big can rotate to fresh links.

import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getBranding, reportsSchemaMissing } from "@/lib/reports/store";
import { reportPdfPath } from "@/lib/reports/pdf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

const TOKEN_SCAN_CAP = 1000;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Constant-time equality of the presented token against every stored one. */
function tokensMatch(presented: string, stored: string): boolean {
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(sha256(presented), sha256(stored));
}

/** The report fields the token scan reads (db is untyped, this keeps it honest). */
interface TokenRow { id: string; userId: string; siteId: string; title: string; shareToken: string | null }
/** One snapshot row of the artifact branch. */
interface RunRow { id: string; html: string; pdfPath: string | null; periodFrom: Date }
/** The client listing shape. */
interface RunListRow { id: string; createdAt: Date; periodFrom: Date; periodTo: Date; pdfPath: string | null }

async function findByToken(token: string): Promise<TokenRow | null> {
  const rows: TokenRow[] = await db.clientReport.findMany({
    where: { shareToken: { not: null } },
    select: { id: true, userId: true, siteId: true, title: true, shareToken: true },
    take: TOKEN_SCAN_CAP + 1,
  });
  if (rows.length > TOKEN_SCAN_CAP) throw new Error("token_scan_overflow");
  for (const r of rows) {
    if (typeof r.shareToken === "string" && tokensMatch(token, r.shareToken)) return r;
  }
  return null;
}

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function domainOfSite(site: { siteId: string; url: string | null }): string {
  const raw = site.siteId.startsWith("sc-domain:") ? site.siteId.slice("sc-domain:".length) : (site.url || site.siteId);
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

export async function GET(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const url = new URL(req.url);
  const runId = url.searchParams.get("run");
  const format = url.searchParams.get("format") === "pdf" ? "pdf" : "html";
  try {
    const report = await findByToken(token);
    if (!report) return notFound();

    // Artifact of one run — only of THIS report's runs, never anything else the owner has.
    if (runId) {
      const run: RunRow | null = await db.clientReportRun.findFirst({
        where: { id: runId, reportId: String(report.id) },
        select: { id: true, html: true, pdfPath: true, periodFrom: true },
      });
      if (!run) return notFound();
      const stamp = run.periodFrom ? new Date(run.periodFrom).toISOString().slice(0, 10) : String(run.id).slice(0, 8);
      if (format === "pdf") {
        const stored = typeof run.pdfPath === "string" && run.pdfPath ? run.pdfPath : null;
        if (!stored || path.resolve(stored) !== path.resolve(reportPdfPath(String(run.id)))) {
          return notFound();
        }
        try {
          const buf = await readFile(stored);
          return new Response(new Uint8Array(buf), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `inline; filename="report-${stamp}.pdf"`,
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return notFound();
        }
      }
      // The snapshot is scriptless and self-contained; serving it inline is the point.
      return new Response(run.html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `inline; filename="report-${stamp}.html"`,
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }

    // The client page: report identity, branding, and the snapshots — nothing else.
    const [site, branding, runs] = await Promise.all([
      db.site.findUnique({ where: { id: String(report.siteId) }, select: { siteId: true, url: true } }),
      getBranding(String(report.userId)),
      db.clientReportRun.findMany({
        where: { reportId: String(report.id) },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { id: true, createdAt: true, periodFrom: true, periodTo: true, pdfPath: true },
      }) as Promise<RunListRow[]>,
    ]);
    return NextResponse.json({
      report: {
        title: report.title,
        siteDomain: site ? domainOfSite(site as { siteId: string; url: string | null }) : "",
      },
      branding: {
        companyName: branding.companyName,
        logoDataUrl: branding.logoDataUrl,
        accentColor: branding.accentColor,
        footer: branding.footer,
        website: branding.website,
      },
      runs: runs.map(r => ({
        id: r.id,
        createdAt: new Date(r.createdAt).toISOString(),
        periodFrom: new Date(r.periodFrom).toISOString().slice(0, 10),
        periodTo: new Date(r.periodTo).toISOString().slice(0, 10),
        hasPdf: Boolean(r.pdfPath),
      })),
    });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ notMigrated: true }, { status: 503 });
    console.warn("[reports] share failed:", e);
    return notFound();
  }
}
