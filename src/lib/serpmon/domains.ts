// SERP Monitor — domain catalogue. Stub: T4 owns the implementation (see docs/tasks/serp-monitor/).
import type { DomainQuery, DomainRow, DomainTag } from "./types";

export function domainTags(row: Omit<DomainRow, "tags">, ctx: {
  now: Date; firstRunAt: Date | null; ownDomains: readonly string[]; isPlatform: (h: string) => boolean; maxAgeMonths: number;
}): DomainTag[] {
  throw new Error("serpmon: domainTags not implemented (T4)");
}

export async function domainRows(userId: string, projectId: string, q: DomainQuery): Promise<{ rows: DomainRow[]; total: number } | null> {
  throw new Error("serpmon: domainRows not implemented (T4)");
}

export async function rebuildProjectHosts(projectId: string, runId: string): Promise<void> {
  throw new Error("serpmon: rebuildProjectHosts not implemented (T4)");
}
