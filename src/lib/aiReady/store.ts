// Where the AI Readiness report lives: one row per domain in DomainMetricCache under the
// provider "aiready", the whole report as the JSON payload, the score mirrored into `dr` so the
// table stays readable in SQL. No schema change — the table is provider-string generic, the same
// reason the Crawlgraph wave shipped without a `prisma db push`.

import { rawQuery } from "@/lib/db/raw";
import { writeDomainCache } from "@/lib/seo/metricsStore";
import { computeScore } from "./score";
import type { AccessPart, AiReadyReport, PresencePart, RankPart } from "./types";

export const AIREADY_PROVIDER = "aiready";

export const normAiDomain = (raw: string): string =>
  String(raw ?? "").trim().toLowerCase()
    .replace(/^sc-domain:/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");

export function emptyReport(domain: string, now: Date = new Date()): AiReadyReport {
  return { domain, score: computeScore({}), updatedAt: now.toISOString() };
}

export async function readReport(domain: string): Promise<AiReadyReport | null> {
  const d = normAiDomain(domain);
  if (!d) return null;
  try {
    const rows = await rawQuery<Array<{ payload: string | null }>>(
      `SELECT payload FROM "DomainMetricCache" WHERE provider = ? AND domain = ?`, AIREADY_PROVIDER, d,
    );
    const raw = rows?.[0]?.payload;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AiReadyReport;
    if (!parsed || typeof parsed !== "object" || parsed.domain !== d) return null;
    // The score is derived, never trusted from storage: weights may have changed since the write.
    return { ...parsed, score: computeScore(parsed) };
  } catch {
    return null; // table missing until prisma db push, or a payload from an older shape
  }
}

/** Merge one part into the stored report, recompute the score, write it back. */
export async function saveParts(
  domain: string,
  parts: { access?: AccessPart; presence?: PresencePart; rank?: RankPart },
  now: Date = new Date(),
): Promise<AiReadyReport> {
  const d = normAiDomain(domain);
  const prev = (await readReport(d)) ?? emptyReport(d, now);
  const next: AiReadyReport = { ...prev, ...parts, domain: d, updatedAt: now.toISOString() };
  next.score = computeScore(next);
  await writeDomainCache([{ domain: d, dr: next.score.score, payload: next }], AIREADY_PROVIDER, "api", now);
  return next;
}
