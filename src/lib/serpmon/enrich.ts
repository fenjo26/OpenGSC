// SERP Monitor — host enrichment (registration age, DR). Stub: T4 owns the implementation
// (see docs/tasks/serp-monitor/).

/** Age (RDAP/WHOIS) for hosts never checked or failed > 7 days ago, then DR (free endpoint) older than 30 days. Bounded by `limit` and `deadline`. */
export async function enrichPendingHosts(opts: { limit: number; deadline: number; userId?: string; hostIds?: number[]; what?: "age" | "dr" | "both" }):
  Promise<{ age: number; dr: number; errors: number }> {
  throw new Error("serpmon: enrichPendingHosts not implemented (T4)");
}
