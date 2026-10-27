import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { appendUploadChunk, storeImport, summarizeLogFile, uploadPath, UPLOAD_CHUNK_BYTES } from "@/lib/logs/importer";

export const dynamic = "force-dynamic";

// POST /api/logs/upload?siteId=&uploadId=&index=&final=0|1&name=
// Body: raw bytes of one chunk (≤ 8 MB — the request proxy buffers at most 10 MB per body, so a
// whole log in one POST would arrive truncated). Chunks are appended in order to a temp file;
// the final chunk triggers the import, and the temp file is removed whatever happens.
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const siteId = q.get("siteId") ?? "";
  const site = siteId ? await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } }) : null;
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const file = uploadPath(siteId, q.get("uploadId") ?? "");
  const index = Number(q.get("index"));
  if (!file || !Number.isInteger(index) || index < 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > UPLOAD_CHUNK_BYTES) return NextResponse.json({ error: "chunk_too_large", max: UPLOAD_CHUNK_BYTES }, { status: 413 });
  try {
    await appendUploadChunk(file, index, body);
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 400 });
  }
  if (q.get("final") !== "1") return NextResponse.json({ ok: true });

  try {
    const summary = await summarizeLogFile(file);
    if (!summary.parsed) return NextResponse.json({ error: "no_log_lines", skipped: summary.skipped }, { status: 400 });
    const stored = await storeImport(siteId, (q.get("name") ?? "upload").slice(0, 200), summary);
    return NextResponse.json({ id: stored.id });
  } catch (e) {
    return NextResponse.json({ error: "import_failed", message: String((e as Error)?.message ?? e).slice(0, 300) }, { status: 500 });
  } finally {
    await fsp.unlink(file).catch(() => {});
  }
}
