// Pure mappers shared by the browser History cache (src/lib/seo/history.ts, jobs.ts) and the
// server-side job→history bridge (src/lib/seo/historyServer.ts). No imports at all — this file
// is pulled into both a client bundle and API routes, so it must stay dependency-free.

// Job types (SeoJob.type) → History record types. outline_auto (batch SERP→scrape→outline)
// lands in History as a regular outline; anything absent here has no History representation.
export const HISTORY_TYPE: Record<string, string> = {
  outline: "outline", outline_auto: "outline", text: "text",
  analysis: "analysis", landing: "landing", cluster: "cluster",
};

export interface SeoDiagnostics {
  mechanics?: { code: string; detail: string; fixed?: boolean; samples?: string[] }[];
  judgeConcerns?: string[];
  usedSources?: number;
  autoCleaned?: boolean;
  incomplete?: boolean;
  missingHeadings?: string[];
}

// A text record keeps only the article STRING in `data`, so everything the generator reported
// alongside it — the mechanics audit, the QA reviewer's soft findings, how many sources
// grounded it — must be carried in meta.diagnostics or it is dropped at import.
export function textDiagnostics(result: any): SeoDiagnostics | null {
  if (!result || typeof result !== "object") return null;
  const diag: Record<string, unknown> = {
    ...(Array.isArray(result.mechanics) ? { mechanics: result.mechanics as SeoDiagnostics["mechanics"] } : {}),
    ...(Array.isArray(result.judgeConcerns) ? { judgeConcerns: result.judgeConcerns as string[] } : {}),
    ...(typeof result.usedSources === "number" ? { usedSources: result.usedSources } : {}),
    ...(result.autoCleaned ? { autoCleaned: true } : {}),
    ...(result.incomplete ? { incomplete: true, missingHeadings: result.missingHeadings ?? [] } : {}),
  };
  return Object.keys(diag).length ? (diag as SeoDiagnostics) : null;
}
