import { factDrift, driftSeverity } from "@/lib/seo/factDrift";
import { uniquenessPct, wordCount } from "@/lib/seo/textMetrics";

export const CONTENT_STATUSES = [
  "idea", "approved", "review", "pr_open", "pr_merged", "live", "measuring", "completed", "failed",
] as const;

export type ContentStatus = typeof CONTENT_STATUSES[number];
export type ContentOperationType = "new" | "update";
export type ContentSourceType = "manual" | "history" | "demand" | "gsc" | "content_gap";
export type GateSeverity = "pass" | "warning" | "error";

export interface ContentGate {
  id: string;
  severity: GateSeverity;
  message: string;
  detail?: string;
}
export interface ContentPreflight {
  checkedAt: string;
  words: number;
  blockers: number;
  warnings: number;
  uniquenessPercent: number | null;
  factDrift: "clean" | "warn" | "danger" | null;
  gates: ContentGate[];
}

const TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  idea: ["approved", "failed"],
  approved: ["idea", "review", "failed"],
  review: ["approved", "pr_open", "failed"],
  pr_open: ["pr_merged", "failed"],
  pr_merged: ["live", "failed"],
  live: ["measuring", "completed", "failed"],
  measuring: ["completed", "failed"],
  completed: [],
  failed: ["idea", "approved"],
};

export function isContentStatus(value: unknown): value is ContentStatus {
  return CONTENT_STATUSES.includes(String(value) as ContentStatus);
}

export function canTransition(from: string, to: string): boolean {
  return isContentStatus(from) && isContentStatus(to) && TRANSITIONS[from].includes(to);
}

function cleanSegment(value: unknown, name: string, max = 100): string {
  const s = String(value ?? "").trim();
  if (!s || s.length > max || !/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") {
    throw new Error(`invalid_${name}`);
  }
  return s;
}

export interface RepositoryInput {
  name: string;
  owner: string;
  repo: string;
  baseBranch: string;
  contentRoot: string;
}

/** Validate repository coordinates before any request can reach GitHub. */
export function validateRepositoryInput(input: Record<string, unknown>): RepositoryInput {
  const owner = cleanSegment(input.owner, "owner", 100);
  const repo = cleanSegment(input.repo, "repo", 100).replace(/\.git$/i, "");
  const name = String(input.name ?? `${owner}/${repo}`).trim().slice(0, 120) || `${owner}/${repo}`;
  const baseBranch = String(input.baseBranch ?? "main").trim();
  if (!baseBranch || baseBranch.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.includes("..") || baseBranch.startsWith("/") || baseBranch.endsWith("/")) {
    throw new Error("invalid_base_branch");
  }
  const contentRoot = normalizeContentPath(String(input.contentRoot ?? "content"), { allowEmpty: true, requireContentExtension: false });
  return { name, owner, repo, baseBranch, contentRoot };
}

export function normalizeContentPath(
  value: string,
  options: { allowEmpty?: boolean; requireContentExtension?: boolean } = {},
): string {
  const raw = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw && options.allowEmpty) return "";
  if (!raw || raw.length > 500 || raw.startsWith("/") || raw.includes("\0")) throw new Error("invalid_file_path");
  const parts = raw.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.length > 180)) throw new Error("invalid_file_path");
  if (parts[0].toLowerCase() === ".github" || parts.some(p => p.startsWith("."))) throw new Error("protected_file_path");
  if (options.requireContentExtension !== false && !/\.(?:md|mdx|html?|txt)$/i.test(parts.at(-1) || "")) {
    throw new Error("unsupported_content_extension");
  }
  return parts.join("/");
}

export function joinContentPath(root: string, filePath: string): string {
  const cleanRoot = normalizeContentPath(root, { allowEmpty: true, requireContentExtension: false });
  const cleanFile = normalizeContentPath(filePath);
  return cleanRoot ? `${cleanRoot}/${cleanFile}` : cleanFile;
}

/** Pull the publishable text out of the shapes used by Text, Rewrite and Landing history. */
export function extractHistoryContent(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  for (const key of ["text", "content", "article", "markdown", "html"]) {
    if (typeof obj[key] === "string" && String(obj[key]).trim()) return String(obj[key]);
  }
  if (obj.result && typeof obj.result === "object") return extractHistoryContent(obj.result);
  return "";
}

function frontMatter(text: string): string {
  return text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] ?? "";
}

export function runContentPreflight(text: string, source = ""): ContentPreflight {
  const content = String(text ?? "");
  const words = wordCount(content);
  const h1 = (content.match(/^#\s+\S.*$/gm) || []).length;
  const fm = frontMatter(content);
  const gates: ContentGate[] = [];
  const add = (id: string, severity: GateSeverity, message: string, detail?: string) => gates.push({ id, severity, message, detail });

  add("content", words >= 120 ? "pass" : "error", words >= 120 ? "Draft has publishable length" : "Draft is too short", `${words} words; minimum 120`);
  add("heading", h1 <= 1 ? (h1 === 1 ? "pass" : "warning") : "error", h1 > 1 ? "Multiple H1 headings" : h1 === 1 ? "Single H1 heading" : "No Markdown H1 heading", `${h1} H1`);
  add("title", /(^|\n)title\s*:/im.test(fm) || h1 === 1 ? "pass" : "warning", "Title metadata or H1");
  add("description", /(^|\n)(description|metaDescription)\s*:/im.test(fm) ? "pass" : "warning", "Meta description in front matter");

  const placeholder = content.match(/\b(?:TODO|TBD|FIXME|LOREM\s+IPSUM)\b|\{\{[^}\n]+\}\}|\[[A-Z][A-Z _-]{3,}\]/i)?.[0];
  add("placeholders", placeholder ? "error" : "pass", placeholder ? "Unresolved placeholder" : "No unresolved placeholders", placeholder);

  const unsafeLink = /\]\(\s*(?:javascript|data|file):/i.test(content) || /href\s*=\s*["']\s*(?:javascript|data|file):/i.test(content);
  add("links", unsafeLink ? "error" : "pass", unsafeLink ? "Unsafe link protocol" : "No unsafe link protocols");

  let drift: ContentPreflight["factDrift"] = null;
  let unique: number | null = null;
  if (source.trim()) {
    const report = factDrift(source, content);
    drift = driftSeverity(report);
    unique = uniquenessPct(source, content);
    const added = report.numbers.added.length + report.identifiers.added.length;
    const lost = report.numbers.lost.length + report.identifiers.lost.length;
    add("fact_drift", drift === "danger" ? "error" : drift === "warn" ? "warning" : "pass",
      drift === "danger" ? "New checkable values need verification" : drift === "warn" ? "Some source values were dropped" : "No numeric or identifier drift",
      `${added} added, ${lost} dropped`);
  }

  return {
    checkedAt: new Date().toISOString(), words,
    blockers: gates.filter(g => g.severity === "error").length,
    warnings: gates.filter(g => g.severity === "warning").length,
    uniquenessPercent: unique, factDrift: drift, gates,
  };
}
