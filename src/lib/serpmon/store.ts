// SERP Monitor — storage layer. Stub: T3 owns the implementation (see docs/tasks/serp-monitor/).
import type {
  DomainQuery, KeywordHistory, MarketQuery, MarketRow,
  ProjectDetail, ProjectSummary, RunSummary, SnapshotView,
} from "./types";
import type { KeywordImport } from "./keywords";

export function schemaMissing(e: unknown): boolean {
  throw new Error("serpmon: schemaMissing not implemented (T3)");
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  throw new Error("serpmon: listProjects not implemented (T3)");
}

export async function getProject(userId: string, id: string): Promise<ProjectDetail | null> {
  throw new Error("serpmon: getProject not implemented (T3)");
}

export async function createProject(userId: string, input: ProjectInput): Promise<{ project: ProjectDetail; import: KeywordImport & { added: number } }> {
  throw new Error("serpmon: createProject not implemented (T3)");
}

export async function updateProject(userId: string, id: string, patch: Partial<ProjectInput>): Promise<ProjectDetail | null> {
  throw new Error("serpmon: updateProject not implemented (T3)");
}

export async function deleteProject(userId: string, id: string): Promise<boolean> {
  throw new Error("serpmon: deleteProject not implemented (T3)");
}

export async function addKeywords(userId: string, projectId: string, raw: string, mode: "add" | "replace"): Promise<KeywordImport & { added: number; deactivated: number } | null> {
  throw new Error("serpmon: addKeywords not implemented (T3)");
}

export async function removeKeywords(userId: string, projectId: string, ids: string[]): Promise<number> {
  throw new Error("serpmon: removeKeywords not implemented (T3)");
}

export async function listRuns(userId: string, projectId: string, limit: number): Promise<RunSummary[]> {
  throw new Error("serpmon: listRuns not implemented (T3)");
}

export async function marketRows(userId: string, projectId: string, q: MarketQuery): Promise<{ rows: MarketRow[]; total: number; all: number } | null> {
  throw new Error("serpmon: marketRows not implemented (T3)");
}

export async function keywordHistory(userId: string, keywordId: string, limit: number): Promise<KeywordHistory | null> {
  throw new Error("serpmon: keywordHistory not implemented (T3)");
}

export async function snapshotView(userId: string, snapshotId: string, compareId?: string): Promise<SnapshotView | null> {
  throw new Error("serpmon: snapshotView not implemented (T3)");
}

export interface ProjectInput {
  name: string; country: string; lang: string; depth: number; intervalHours: number;
  keywords?: string;          // raw import text
  ownDomains?: string; ignoreHosts?: string; retentionDays?: number; alertStorm?: boolean; paused?: boolean;
}
