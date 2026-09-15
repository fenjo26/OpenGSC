// SERP Monitor — owner's A-Parser connection for server-side use. Stub: T1 owns the
// implementation (see docs/tasks/serp-monitor/).
import type { AparserCreds } from "./aparser";

/** Owner's A-Parser connection for server-side use: env wins over settings, like /api/aparser. Applies seoAparserConcurrency. null = not configured. */
export async function getAparserServerCreds(userId: string): Promise<AparserCreds | null> {
  throw new Error("serpmon: getAparserServerCreds not implemented (T1)");
}
