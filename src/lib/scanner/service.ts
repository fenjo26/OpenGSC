import "server-only";
import { prisma } from "@/lib/prisma";
import { describeFingerprint, fingerprintStrength } from "./fingerprints";
import { runScan, scanHost, type ScanReport } from "./scan";

// Same dynamic access as the other post-1.4.0 tables: an instance mid-update may not have the table
// yet, and a hard import would break the route instead of degrading to "not migrated".
const scans = () => (prisma as any).siteScan;

export interface RelatedDomain {
  host: string;
  scanId: string;
  matches: string[];
  strength: "strong" | "weak";
}

function parse(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function scanDto(row: any, related: RelatedDomain[] = []) {
  return {
    id: row.id, host: row.host, url: row.url, finalUrl: row.finalUrl,
    status: row.status, httpStatus: row.httpStatus, score: row.score, error: row.error,
    report: parse(row.report) as ScanReport | null,
    createdAt: row.createdAt, finishedAt: row.finishedAt,
    related,
  };
}

/**
 * Other domains this operator has scanned that share an identity signal with this one.
 *
 * Strong matches (an analytics property, a tag container, an ads publisher id) are billed to a
 * person and are close to proof of shared ownership. Weak ones (nameservers, an IP) are shared by
 * every customer of a host, so they are shown separately and never presented as a conclusion —
 * the tool reports the overlap and lets the operator decide what it means.
 */
export async function findRelated(userId: string, scanId: string, keys: string[]): Promise<RelatedDomain[]> {
  const strong = keys.filter(key => fingerprintStrength(key) === "strong");
  if (!keys.length) return [];
  const rows = await scans().findMany({
    where: { userId, status: "completed", NOT: { id: scanId } },
    select: { id: true, host: true, fingerprints: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  }).catch(() => []);

  const seen = new Map<string, RelatedDomain>();
  for (const row of rows) {
    const theirs: string[] = parse(row.fingerprints) ?? [];
    if (!theirs.length) continue;
    const shared = theirs.filter(key => keys.includes(key));
    if (!shared.length) continue;
    const isStrong = shared.some(key => strong.includes(key));
    const existing = seen.get(row.host);
    // One domain, one row: keep the most recent scan and the strongest evidence found for it.
    if (existing && (existing.strength === "strong" || !isStrong)) continue;
    seen.set(row.host, {
      host: row.host,
      scanId: row.id,
      matches: shared.map(describeFingerprint).slice(0, 6),
      strength: isStrong ? "strong" : "weak",
    });
  }
  return [...seen.values()].sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "strong" ? -1 : 1)).slice(0, 25);
}

export async function createScan(userId: string, input: string) {
  const host = scanHost(new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`));
  const row = await scans().create({
    data: { userId, host, url: input.trim().slice(0, 500), status: "running" },
  });
  try {
    const report = await runScan(input);
    const updated = await scans().update({
      where: { id: row.id },
      data: {
        status: "completed", httpStatus: report.httpStatus, finalUrl: report.finalUrl,
        host: report.host, score: report.score, report: JSON.stringify(report),
        fingerprints: JSON.stringify(report.fingerprintKeys), finishedAt: new Date(), error: null,
      },
    });
    return scanDto(updated, await findRelated(userId, row.id, report.fingerprintKeys));
  } catch (error) {
    const message = error instanceof Error ? error.message : "scan_failed";
    const failed = await scans().update({
      where: { id: row.id },
      data: { status: "error", error: message.slice(0, 200), finishedAt: new Date() },
    });
    return scanDto(failed);
  }
}
