// N8 — one frozen snapshot's artifacts. format=html (default, inline — also the "print to
// PDF from the browser" path when the server has no Playwright) or format=pdf (the stored
// file under data/reports/). Ownership is checked through the run's report; read capability.
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import { reportsSchemaMissing } from "@/lib/reports/store";
import { reportPdfPath } from "@/lib/reports/pdf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

const fileResponse = (body: BodyInit, filename: string, type: string, inline: boolean): Response =>
  new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });

/** What the artifact route reads from one snapshot row (db is untyped, this keeps it honest). */
interface RunRow { id: string; html: string; pdfPath: string | null; periodFrom: Date }

export async function GET(req: Request, context: { params: Promise<{ id: string; runId: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, runId } = await context.params;
  const format = new URL(req.url).searchParams.get("format") === "pdf" ? "pdf" : "html";
  try {
    const run: RunRow | null = await db.clientReportRun.findFirst({
      where: { id: runId, report: { id, userId } },
      select: { id: true, html: true, pdfPath: true, periodFrom: true },
    });
    if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const stamp = run.periodFrom ? new Date(run.periodFrom).toISOString().slice(0, 10) : run.id.slice(0, 8);
    if (format === "pdf") {
      const stored = typeof run.pdfPath === "string" && run.pdfPath ? run.pdfPath : null;
      // Only ever serve the file this app itself wrote for this run: same generated path,
      // inside data/reports. A corrupted row cannot point the reader at arbitrary files.
      if (!stored || path.resolve(stored) !== path.resolve(reportPdfPath(runId))) {
        return NextResponse.json({ error: "pdf_unavailable" }, { status: 404 });
      }
      try {
        const buf = await readFile(stored);
        return fileResponse(new Uint8Array(buf), `report-${stamp}.pdf`, "application/pdf", false);
      } catch {
        return NextResponse.json({ error: "pdf_unavailable" }, { status: 404 });
      }
    }
    return fileResponse(run.html, `report-${stamp}.html`, "text/html; charset=utf-8", false);
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] run artifact failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
