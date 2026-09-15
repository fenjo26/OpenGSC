// SERP Monitor — keyword import parsing. Stub: T3 owns the implementation (see docs/tasks/serp-monitor/).

export function normaliseKeyword(raw: string): string | null {
  throw new Error("serpmon: normaliseKeyword not implemented (T3)");
}

export interface KeywordImport { rows: { keyword: string; group: string }[]; skipped: number; duplicates: number }

/** One keyword per line; optional group after TAB, ";" or "," (first separator found). Header line "keyword" is skipped. */
export function parseKeywordImport(raw: string): KeywordImport {
  throw new Error("serpmon: parseKeywordImport not implemented (T3)");
}
