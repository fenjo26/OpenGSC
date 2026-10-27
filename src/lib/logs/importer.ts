/**
 * Server-log import: stream a file (plain or gzip) line by line through the aggregator, verify
 * crawler IPs, store one ServerLogImport row. Two sources:
 *   - an upload, sent by the browser in chunks (the proxy buffers request bodies up to 10 MB, so
 *     one large POST would be silently truncated) and reassembled in a temp file;
 *   - a file on this server, only inside a directory the operator allow-listed in
 *     OPENGSC_LOG_DIRS (comma or colon separated) — never an arbitrary path.
 * Owner-only at the routes. The new model is reached through dbAny, like other late tables.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dbAny } from "@/lib/prisma";
import type { LogSummary } from "./aggregate";
export { summarizeLogFile } from "./file";

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 3600_000;

const uploadDir = () => path.join(os.tmpdir(), "opengsc-log-uploads");
const UPLOAD_ID = /^[a-z0-9-]{8,64}$/;

export function uploadPath(siteId: string, uploadId: string): string | null {
  if (!UPLOAD_ID.test(uploadId) || !/^[a-z0-9]+$/i.test(siteId)) return null;
  return path.join(uploadDir(), `${siteId}-${uploadId}.part`);
}

/** Append one chunk; chunks must arrive in order (index = chunks already written). */
export async function appendUploadChunk(file: string, index: number, body: Buffer): Promise<number> {
  await fsp.mkdir(uploadDir(), { recursive: true });
  if (index === 0) {
    await sweepStaleUploads();
    await fsp.writeFile(file, body);
    return body.length;
  }
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw new Error("upload_not_started");
  if (stat.size !== index * UPLOAD_CHUNK_BYTES) throw new Error("chunk_out_of_order");
  if (stat.size + body.length > MAX_UPLOAD_BYTES) throw new Error("upload_too_large");
  await fsp.appendFile(file, body);
  return stat.size + body.length;
}

async function sweepStaleUploads(): Promise<void> {
  const names = await fsp.readdir(uploadDir()).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    const full = path.join(uploadDir(), name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > UPLOAD_TTL_MS) await fsp.unlink(full).catch(() => {});
  }
}

/** Directories the operator allowed server-side imports from (realpaths); empty = feature off. */
export async function allowedLogDirs(): Promise<string[]> {
  const raw = process.env.OPENGSC_LOG_DIRS ?? "";
  const dirs: string[] = [];
  for (const part of raw.split(/[,:]/).map(s => s.trim()).filter(Boolean)) {
    const real = await fsp.realpath(part).catch(() => null);
    if (real) dirs.push(real);
  }
  return dirs;
}

/** A server path, accepted only when its realpath sits inside an allowed directory. */
export async function resolveServerLog(requested: string): Promise<string | null> {
  const dirs = await allowedLogDirs();
  if (!dirs.length || !requested) return null;
  const real = await fsp.realpath(requested).catch(() => null);
  if (!real) return null;
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isFile()) return null;
  return dirs.some(dir => real.startsWith(dir + path.sep)) ? real : null;
}

/** Log-looking files in the allowed directories, newest first (for the picker). */
export async function listServerLogs(): Promise<{ path: string; size: number; mtime: string }[]> {
  const out: { path: string; size: number; mtime: string }[] = [];
  for (const dir of await allowedLogDirs()) {
    for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (!/access|\.log(\.\d+)?(\.gz)?$/i.test(name)) continue;
      const full = path.join(dir, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat?.isFile()) out.push({ path: full, size: stat.size, mtime: stat.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 100);
}

export interface StoredImport {
  id: string;
  createdAt: string;
  source: string;
  summary: LogSummary;
}

export async function storeImport(siteId: string, source: string, summary: LogSummary): Promise<StoredImport> {
  const row = await dbAny.serverLogImport.create({
    data: {
      siteId,
      source: source.slice(0, 300),
      lines: summary.lines,
      parsed: summary.parsed,
      skipped: summary.skipped,
      periodFrom: summary.from ? new Date(summary.from) : null,
      periodTo: summary.to ? new Date(summary.to) : null,
      googleHits: summary.google.hits,
      summary: JSON.stringify(summary),
    },
  });
  return { id: row.id, createdAt: new Date(row.createdAt).toISOString(), source: row.source, summary };
}

/** The newest import usable for the audit join: recent, and covering at least a week. */
export async function latestUsableImport(siteId: string, maxAgeDays = 30, minDays = 7): Promise<LogSummary | null> {
  const row = await dbAny.serverLogImport.findFirst({
    where: { siteId, periodTo: { gte: new Date(Date.now() - maxAgeDays * 86_400_000) } },
    orderBy: { periodTo: "desc" },
    select: { summary: true },
  }).catch(() => null);
  if (!row?.summary) return null;
  try {
    const summary = JSON.parse(row.summary) as LogSummary;
    return summary.days >= minDays && summary.google?.hits > 0 ? summary : null;
  } catch {
    return null;
  }
}
