import "server-only";
import { Buffer } from "node:buffer";
import { createLineDiff } from "./diff";
import { joinContentPath, runContentPreflight, validateRepositoryInput } from "./types";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(message: string, public status = 502, public code = "github_error") { super(message); }
}

interface RepoConfig { owner: string; repo: string; baseBranch: string; contentRoot: string; }

export interface RepositorySourceSnapshot {
  ref: string;
  commitSha: string;
  files: Array<{ path: string; content: string; size: number }>;
  totalFiles: number;
  truncated: boolean;
}

const SOURCE_FILE_LIMIT = 80;
const SOURCE_FILE_BYTES = 256 * 1024;
const SOURCE_TOTAL_BYTES = 4 * 1024 * 1024;
const SOURCE_CONCURRENCY = 5;

function pathPart(value: string): string { return value.split("/").map(encodeURIComponent).join("/"); }

export function validateSourceRef(value: unknown, fallback = "main"): string {
  const ref = String(value ?? fallback).trim() || fallback;
  if (ref.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
    throw new Error("invalid_source_ref");
  }
  return ref;
}

async function githubRequest<T>(token: string, pathname: string, init: RequestInit = {}, accepted: number[] = [200]): Promise<T> {
  if (!pathname.startsWith("/")) throw new Error("invalid_github_path");
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "OpenGSC-Content-Operations",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const raw = await res.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  if (!accepted.includes(res.status)) {
    const safeMessage = typeof body?.message === "string" ? body.message.slice(0, 240) : `GitHub returned ${res.status}`;
    throw new GitHubError(safeMessage, res.status === 401 || res.status === 403 ? 400 : 502, `github_${res.status}`);
  }
  return body as T;
}

export async function verifyRepository(token: string, config: RepoConfig) {
  const c = validateRepositoryInput(config as unknown as Record<string, unknown>);
  const repo: any = await githubRequest(token, `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`);
  const branch: any = await githubRequest(token, `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/branches/${pathPart(c.baseBranch)}`);
  return {
    fullName: String(repo.full_name ?? `${c.owner}/${c.repo}`),
    private: !!repo.private,
    defaultBranch: String(repo.default_branch ?? ""),
    baseSha: String(branch?.commit?.sha ?? ""),
    canPush: repo?.permissions?.push === true,
  };
}

function sourcePriority(path: string): number {
  if (/^(?:package\.json|next\.config\.[cm]?[jt]s|(?:src\/)?app\/(?:layout|robots|sitemap)\.[cm]?[jt]sx?|public\/(?:robots\.txt|sitemap\.xml))$/i.test(path)) return 0;
  if (/(?:^|\/)(?:page|layout|route|middleware|proxy)\.[cm]?[jt]sx?$/i.test(path)) return 1;
  if (/(?:^|\/)(?:components?|lib)\//i.test(path)) return 2;
  return 3;
}

function sourcePathCandidate(entry: any): boolean {
  const path = String(entry?.path ?? "");
  if (entry?.type !== "blob" || !path) return false;
  if (/(?:^|\/)(?:node_modules|\.next|dist|build|coverage|vendor|generated|__snapshots__)(?:\/|$)/i.test(path)) return false;
  if (/(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path)) return false;
  if (/(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock|bun\.lock)/i.test(path)) return false;
  return /(?:^|\/)(?:package\.json|next\.config\.[cm]?[jt]s|public\/(?:robots\.txt|sitemap\.xml))$|\.(?:[cm]?[jt]sx?|mdx|css|scss|json|html?)$/i.test(path);
}

/** Read a bounded, immutable source snapshot through GitHub's tree/blob APIs. */
export async function readRepositorySource(
  token: string,
  config: RepoConfig,
  requestedRef?: string,
  onProgress?: (completed: number, total: number) => Promise<void> | void,
): Promise<RepositorySourceSnapshot> {
  const c = validateRepositoryInput(config as unknown as Record<string, unknown>);
  const ref = validateSourceRef(requestedRef, c.baseBranch);
  const repoPath = `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
  const branch: any = await githubRequest(token, `${repoPath}/git/ref/heads/${pathPart(ref)}`);
  const commitSha = String(branch?.object?.sha ?? "");
  if (!commitSha) throw new GitHubError("Source ref has no commit", 400, "github_empty_branch");
  const commit: any = await githubRequest(token, `${repoPath}/git/commits/${encodeURIComponent(commitSha)}`);
  const treeSha = String(commit?.tree?.sha ?? "");
  if (!treeSha) throw new GitHubError("Commit has no source tree", 400, "github_empty_tree");
  const tree: any = await githubRequest(token, `${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  const relevant = (Array.isArray(tree?.tree) ? tree.tree : []).filter(sourcePathCandidate);
  const oversized = relevant.some((entry: any) => Number(entry?.size ?? 0) > SOURCE_FILE_BYTES);
  const candidates = relevant
    .filter((entry: any) => Number(entry?.size ?? 0) <= SOURCE_FILE_BYTES)
    .sort((a: any, b: any) => sourcePriority(String(a.path)) - sourcePriority(String(b.path)) || String(a.path).localeCompare(String(b.path)));
  const selected = candidates.slice(0, SOURCE_FILE_LIMIT);
  const files: RepositorySourceSnapshot["files"] = [];
  let cursor = 0;
  let totalBytes = 0;
  let budgetTruncated = false;
  const workers = Array.from({ length: Math.min(SOURCE_CONCURRENCY, selected.length) }, async () => {
    while (cursor < selected.length) {
      const entry = selected[cursor++];
      const size = Number(entry.size ?? 0);
      if (totalBytes + size > SOURCE_TOTAL_BYTES) { budgetTruncated = true; continue; }
      totalBytes += size; // reserve before awaiting so concurrent workers share one hard budget
      const blob: any = await githubRequest(token, `${repoPath}/git/blobs/${encodeURIComponent(String(entry.sha))}`);
      if (blob?.encoding !== "base64" || typeof blob?.content !== "string") { budgetTruncated = true; continue; }
      const content = Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8");
      files.push({ path: String(entry.path), content, size: Buffer.byteLength(content) });
      await onProgress?.(files.length, selected.length);
    }
  });
  await Promise.all(workers);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ref,
    commitSha,
    files,
    totalFiles: candidates.length,
    truncated: !!tree?.truncated || oversized || candidates.length > SOURCE_FILE_LIMIT || budgetTruncated,
  };
}

export interface RepositoryFile { exists: boolean; path: string; sha: string | null; content: string; htmlUrl: string | null; }

export async function readRepositoryFile(token: string, config: RepoConfig, filePath: string, ref = config.baseBranch): Promise<RepositoryFile> {
  const c = validateRepositoryInput(config as unknown as Record<string, unknown>);
  const path = joinContentPath(c.contentRoot, filePath);
  try {
    const body: any = await githubRequest(token,
      `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${pathPart(path)}?ref=${encodeURIComponent(ref)}`,
      {}, [200]);
    if (body?.type !== "file" || typeof body?.content !== "string") throw new GitHubError("Target path is not a file", 400, "github_not_file");
    return {
      exists: true, path, sha: String(body.sha ?? "") || null,
      content: Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8"),
      htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
    };
  } catch (error) {
    if (error instanceof GitHubError && error.code === "github_404") return { exists: false, path, sha: null, content: "", htmlUrl: null };
    throw error;
  }
}

export async function previewRepositoryChange(token: string, config: RepoConfig, filePath: string, nextContent: string) {
  const current = await readRepositoryFile(token, config, filePath);
  return {
    file: current,
    diff: createLineDiff(current.content, nextContent),
    preflight: runContentPreflight(nextContent, current.exists ? current.content : ""),
  };
}

export interface CreatePrInput {
  operationId: string;
  title: string;
  body: string;
  filePath: string;
  content: string;
  commitMessage: string;
}

export async function createContentPullRequest(token: string, config: RepoConfig, input: CreatePrInput) {
  const c = validateRepositoryInput(config as unknown as Record<string, unknown>);
  const suffix = input.operationId.replace(/[^A-Za-z0-9]/g, "").slice(-10) || Date.now().toString(36);
  const slug = input.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 38) || "content";
  const branch = `opengsc/${slug}-${suffix}`;
  const repoPath = `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;

  const base: any = await githubRequest(token, `${repoPath}/git/ref/heads/${pathPart(c.baseBranch)}`);
  const baseSha = String(base?.object?.sha ?? "");
  if (!baseSha) throw new GitHubError("Base branch has no commit", 400, "github_empty_branch");

  try {
    await githubRequest(token, `${repoPath}/git/refs`, {
      method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    }, [201]);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.code !== "github_422") throw error;
    await githubRequest(token, `${repoPath}/git/ref/heads/${pathPart(branch)}`); // idempotent retry only
  }

  const file = await readRepositoryFile(token, c, input.filePath, branch);
  const commit: any = await githubRequest(token, `${repoPath}/contents/${pathPart(file.path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: input.commitMessage.slice(0, 200),
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch,
      ...(file.sha ? { sha: file.sha } : {}),
    }),
  }, [200, 201]);

  let pr: any;
  try {
    pr = await githubRequest(token, `${repoPath}/pulls`, {
      method: "POST", body: JSON.stringify({ title: input.title.slice(0, 240), body: input.body.slice(0, 20_000), head: branch, base: c.baseBranch }),
    }, [201]);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.code !== "github_422") throw error;
    const existing: any[] = await githubRequest(token, `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${c.owner}:${branch}`)}`);
    if (!existing[0]) throw error;
    pr = existing[0];
  }
  return {
    branch, number: Number(pr.number), url: String(pr.html_url),
    commitSha: String(commit?.commit?.sha ?? ""),
  };
}

export async function readPullRequest(token: string, config: RepoConfig, number: number) {
  const c = validateRepositoryInput(config as unknown as Record<string, unknown>);
  const pr: any = await githubRequest(token, `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/pulls/${number}`);
  return {
    state: String(pr.state ?? ""), merged: !!pr.merged, mergedAt: pr.merged_at ? String(pr.merged_at) : null,
    url: String(pr.html_url ?? ""), mergeCommitSha: pr.merge_commit_sha ? String(pr.merge_commit_sha) : null,
  };
}
