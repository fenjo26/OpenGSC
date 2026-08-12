import "server-only";
import { prisma } from "@/lib/prisma";
import { GitHubError, readRepositorySource } from "@/lib/contentOps/github";
import { openSecret } from "@/lib/contentOps/secretBox";
import { analyzeSource } from "./rules";

const activeRuns = new Set<string>();
const STALE_MS = 10 * 60_000;
const SAFE_ERROR_CODES = new Set(["content_ops_secret_missing", "github_token_decrypt_failed", "invalid_source_ref"]);

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function sourceAuditDto(run: any) {
  return {
    id: run.id,
    repositoryId: run.repositoryId,
    ref: run.ref,
    commitSha: run.commitSha,
    framework: run.framework,
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    attempt: run.attempt,
    heartbeatAt: run.heartbeatAt,
    filesScanned: run.filesScanned,
    totalFiles: run.totalFiles,
    truncated: run.truncated,
    score: run.score,
    summary: parseJson(run.summary),
    findings: parseJson(run.findings) ?? [],
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    repository: run.repository ? {
      id: run.repository.id,
      name: run.repository.name,
      owner: run.repository.owner,
      repo: run.repository.repo,
      baseBranch: run.repository.baseBranch,
    } : null,
  };
}

export async function markStaleSourceAudits(userId: string): Promise<number> {
  const result = await prisma.sourceAuditRun.updateMany({
    where: {
      userId,
      status: "running",
      OR: [{ heartbeatAt: { lt: new Date(Date.now() - STALE_MS) } }, { heartbeatAt: null, startedAt: { lt: new Date(Date.now() - STALE_MS) } }],
    },
    data: { status: "interrupted", stage: "interrupted", finishedAt: new Date(), error: "source_audit_interrupted" },
  });
  return result.count;
}

export async function runSourceAudit(runId: string): Promise<void> {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  try {
    const run = await prisma.sourceAuditRun.findUnique({ where: { id: runId }, include: { repository: true } });
    if (!run || run.status !== "running") return;
    const token = openSecret(run.repository.tokenCipher);
    await prisma.sourceAuditRun.update({
      where: { id: runId },
      data: { stage: "tree", progress: 3, heartbeatAt: new Date(), error: null },
    });
    let lastProgress = 0;
    const snapshot = await readRepositorySource(token, run.repository, run.ref, async (completed, total) => {
      const progress = Math.min(84, 10 + Math.round((completed / Math.max(1, total)) * 74));
      if (progress - lastProgress < 7 && completed < total) return;
      lastProgress = progress;
      await prisma.sourceAuditRun.update({
        where: { id: runId },
        data: { stage: "fetch", progress, filesScanned: completed, totalFiles: total, heartbeatAt: new Date() },
      }).catch(() => {});
    });
    await prisma.sourceAuditRun.update({
      where: { id: runId },
      data: {
        stage: "analyze", progress: 90, filesScanned: snapshot.files.length,
        totalFiles: snapshot.totalFiles, truncated: snapshot.truncated, commitSha: snapshot.commitSha,
        heartbeatAt: new Date(),
      },
    });
    const report = analyzeSource(snapshot.files);
    await prisma.sourceAuditRun.update({
      where: { id: runId },
      data: {
        framework: report.framework,
        status: "completed",
        stage: "completed",
        progress: 100,
        heartbeatAt: new Date(),
        finishedAt: new Date(),
        score: report.score,
        summary: JSON.stringify(report.summary),
        findings: JSON.stringify(report.findings),
      },
    });
  } catch (error) {
    const code = error instanceof GitHubError
      ? error.code
      : error instanceof Error && SAFE_ERROR_CODES.has(error.message)
        ? error.message
        : "source_audit_failed";
    await prisma.sourceAuditRun.update({
      where: { id: runId },
      data: { status: "error", stage: "error", finishedAt: new Date(), heartbeatAt: new Date(), error: String(code).slice(0, 200) },
    }).catch(() => {});
  } finally {
    activeRuns.delete(runId);
  }
}
