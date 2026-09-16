// SERP Monitor — run collector: fetches the SERP for each pending keyword of a run, classifies
// the answer, diffs it against the keyword's last good snapshot and stores everything through
// store.writeSnapshot (one transaction per keyword). A run is resumable: keywords that already
// have a snapshot for this runId are skipped, so a restart or the scheduler's tick budget can
// interrupt and continue it without double work — the [runId, keywordId] unique key is the backstop.
//
// Every provider call here happens inside the scheduler's withCallContext, so the provider log
// attributes each A-Parser request to the project owner without threading a userId through runSerp.
import { prisma } from "@/lib/prisma";
import { runSerp, type SerpOptions, type SerpResponse } from "@/lib/seo/serp";
import { credsTag, getAparserServerCreds, type ServerAparserCreds } from "@/lib/seo/aparserServerCreds";

import { hostOfUrl, ignorePredicate, parseHostList } from "./hosts";
import { classifySnapshot } from "./noise";
import { pickRetryWave, RETRY_MAX_ATTEMPTS, trackRetry } from "./retry";
import { median, shareAboveOwnP90, stormVerdict } from "./volatility";
import {
  expandRowsJson, failedSnapshotsOfRun, loadUrlHostMaps, pruneProjectSnapshots, releaseFailedSnapshot,
  toRunSummary, urlIdsFromRows, writeSnapshot,
} from "./store";
import {
  KEYWORD_P90_WINDOW, SERPMON_MANUAL_COOLDOWN_MS, STORM_BASELINE_RUNS, STORM_MIN_BASELINE,
  type RunSummary, type SerpRow, type SnapshotProblem, type SnapshotStatus,
} from "./types";
import { kickSerpmonScheduler, kickSerpmonSchedulerIn } from "./scheduler";
import type { RunRowLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same untyped rows as the store
type DbRow = any;

/** Promises in flight per wave. A-Parser's own limiter throttles underneath; 16 keeps one tick
 * from opening half a thousand sockets on a deep project. */
const WAVE = 16;

const PROJECT_SELECT = {
  id: true, userId: true, country: true, lang: true, depth: true, ignoreHosts: true,
} as const;

// ─── startRun ────────────────────────────────────────────────────────────────

export async function startRun(
  userId: string, projectId: string, trigger: "schedule" | "manual", opts?: { force?: boolean },
): Promise<{ runId: string } | { error: "not_found" | "already_running" | "cooldown" | "no_creds" | "no_keywords" }> {
  const project = await db.serpProject.findFirst({
    where: { id: projectId, userId },
    select: { id: true, paused: true },
  }) as { id: string; paused: boolean } | null;
  if (!project || (project.paused && trigger === "schedule")) return { error: "not_found" };

  const running = await db.serpRun.findFirst({
    where: { projectId, status: "running" }, select: { id: true },
  }) as { id: string } | null;
  if (running) return { error: "already_running" };

  // Manual starts are throttled against the last run's start — a user mashing the button must
  // not burn their own proxy quota. `force` is the explicit override the UI confirms.
  if (trigger === "manual" && !opts?.force) {
    const last = await db.serpRun.findFirst({
      where: { projectId }, orderBy: { startedAt: "desc" }, select: { startedAt: true },
    }) as { startedAt: Date } | null;
    if (last && Date.now() - last.startedAt.getTime() < SERPMON_MANUAL_COOLDOWN_MS) {
      return { error: "cooldown" };
    }
  }

  const creds = await getAparserServerCreds(userId);
  if (!creds) return { error: "no_creds" };

  const planned = await db.serpKeyword.count({ where: { projectId, active: true } });
  if (!planned) return { error: "no_keywords" };

  const run = await db.serpRun.create({
    data: { projectId, trigger, status: "running", planned },
    select: { id: true },
  }) as { id: string };

  kickSerpmonScheduler();
  return { runId: run.id };
}

// ─── advanceRun ──────────────────────────────────────────────────────────────

interface ProjectLite {
  id: string; userId: string; country: string; lang: string; depth: number; ignoreHosts: string;
}

/** Raw error text worth showing to the user: the provider's own error string or the exception
 * message, password redacted, capped — `problem` alone ("provider_error") is not diagnosable. */
function sanitizeDetail(raw: string | null | undefined, password: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const safe = password ? text.split(password).join("***") : text;
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
}

/** "attempt 2/3 · " on retries, nothing on the first try. */
function attemptTag(attempt: number): string {
  return attempt > 1 ? `attempt ${attempt}/${RETRY_MAX_ATTEMPTS} · ` : "";
}

interface KeywordOutcome {
  status: SnapshotStatus;
  problem: SnapshotProblem | null;
  detail: string | null;
}

/** Fetch one keyword's SERP and store it. A throw here means provider/transport trouble — the
 * keyword is recorded as failed/provider_error and the run goes on. */
async function collectKeyword(
  keyword: { id: string; keyword: string; lastSnapshotId: string | null },
  project: ProjectLite,
  runId: string,
  creds: ServerAparserCreds,
  ignore: (host: string) => boolean,
  attempt = 1,
): Promise<KeywordOutcome> {
  let status: SnapshotStatus = "failed";
  let problem: SnapshotProblem | null = "provider_error";
  let detail: string | null = null;
  let rows: SerpRow[] = [];
  let totalCount = "";
  let features: string[] = [];

  try {
    // T1 extends SerpOptions/SerpResponse with configPreset/totalCount/features; the casts keep
    // this file compiling against the pre-T1 type surface byte-for-byte.
    const opts = {
      gl: project.country,
      hl: project.lang,
      num: project.depth,
      baseUrl: creds.baseUrl,
      ...(creds.configPreset ? { configPreset: creds.configPreset } : {}),
    } as SerpOptions;
    const resp: SerpResponse = await runSerp("aparser", creds.password, keyword.keyword, opts);
    const ext = resp as SerpResponse & { totalCount?: string; features?: string[] };
    totalCount = ext.totalCount ?? "";
    features = ext.features ?? [];
    detail = ext.error ? sanitizeDetail(attemptTag(attempt) + (ext.errorDetail || ext.error) + credsTag(creds), creds.password) : null;

    const seen = new Set<string>();
    rows = (ext.results ?? [])
      .map(r => ({ position: r.position, url: r.url, host: hostOfUrl(r.url), title: r.title ?? "" }))
      .filter((r): r is { position: number; url: string; host: string; title: string } => Boolean(r.host))
      .filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)))
      .sort((a, b) => a.position - b.position);

    const cls = classifySnapshot({
      rows, depth: project.depth, totalCount, providerError: ext.error ?? null,
    });
    status = cls.status;
    problem = cls.problem;
  } catch (e) {
    status = "failed";
    problem = "provider_error";
    detail = sanitizeDetail(attemptTag(attempt) + (e instanceof Error ? e.message : String(e)) + credsTag(creds), creds.password);
    rows = [];
  }

  const prev = keyword.lastSnapshotId ? await loadPrev(keyword.lastSnapshotId) : null;
  await writeSnapshot({
    runId,
    projectId: project.id,
    keywordId: keyword.id,
    status,
    problem,
    detail,
    depth: project.depth,
    totalCount,
    features,
    rows,
    prev,
    ignore,
    attempts: attempt,
  });
  return { status, problem, detail };
}

/** The keyword's last stored snapshot, expanded to rows — the comparison base. */
async function loadPrev(snapshotId: string): Promise<{ id: string; status: SnapshotStatus; got: number; rows: SerpRow[] } | null> {
  const prev = await db.serpSnapshot.findUnique({
    where: { id: snapshotId },
    select: { id: true, status: true, got: true, rows: true },
  }) as { id: string; status: string; got: number; rows: string } | null;
  if (!prev) return null;
  const maps = await loadUrlHostMaps(urlIdsFromRows(prev.rows));
  return {
    id: prev.id,
    status: prev.status as SnapshotStatus,
    got: prev.got,
    rows: expandRowsJson(prev.rows, maps),
  };
}

/**
 * Write the still-pending keywords of a run as failed/no_creds without calling the provider —
 * the credentials disappeared mid-run. Bulk creates (they carry no diffs), then the run finalizes.
 */
async function failRemainingNoCreds(runId: string, projectId: string, depth: number): Promise<number> {
  let failed = 0;
  for (;;) {
    const pending = await db.serpKeyword.findMany({
      where: { projectId, active: true, snapshots: { none: { runId } } },
      select: { id: true },
      take: 400,
    }) as { id: string }[];
    if (!pending.length) break;
    try {
      await db.serpSnapshot.createMany({
        data: pending.map(k => ({
          projectId, keywordId: k.id, runId, status: "failed", problem: "no_creds", depth, rows: "[]",
        })),
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e; // a parallel writer got there first
    }
    await db.serpKeyword.updateMany({
      where: { id: { in: pending.map(k => k.id) } },
      data: { lastStatus: "failed", lastProblem: "no_creds" },
    });
    failed += pending.length;
  }
  if (failed) {
    await db.serpRun.update({ where: { id: runId }, data: { failed: { increment: failed } } });
  }
  return failed;
}

/** Abort a run that never got off the ground: the whole first wave failed with one identical
 * error, so every later keyword would drown the same way. Keywords keep their previous state
 * (no 295 identical red rows — nothing is written for them), the schedule is pushed back one
 * interval so a dead A-Parser is not re-hammered every tick, and the raw error lands in
 * `SerpRun.error` where the UI and the server log both show it. */
async function abortRun(runId: string, projectId: string, first: KeywordOutcome): Promise<void> {
  const finishedAt = new Date();
  const error = first.detail ?? first.problem ?? "provider_error";
  await db.serpRun.update({
    where: { id: runId },
    data: { status: "aborted", finishedAt, error },
  });
  const projectRow = await db.serpProject.findUnique({
    where: { id: projectId }, select: { intervalHours: true },
  }) as { intervalHours: number } | null;
  const nextRunAt = projectRow && projectRow.intervalHours > 0
    ? new Date(finishedAt.getTime() + projectRow.intervalHours * 3_600_000)
    : null;
  await db.serpProject.update({
    where: { id: projectId },
    data: { lastRunAt: finishedAt, nextRunAt },
  });
  console.warn(`[serpmon-cron] run ${runId} aborted: every keyword of the first wave failed identically — ${error}`);
}

export async function advanceRun(runId: string, deadline: number): Promise<{ done: boolean; processed: number }> {
  const run = await db.serpRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, project: { select: PROJECT_SELECT } },
  }) as { id: string; status: string; project: ProjectLite } | null;
  if (!run || run.status !== "running") return { done: true, processed: 0 };
  const project = run.project;
  const ignore = ignorePredicate(parseHostList(project.ignoreHosts ?? ""));
  let processed = 0;
  // The mass-failure gate below only judges the run's genuine first wave — a run resumed by a
  // later tick already has snapshots and must run to its normal end.
  let firstWave = (await db.serpSnapshot.count({ where: { runId } })) === 0;

  for (;;) {
    const pending = await db.serpKeyword.findMany({
      where: { projectId: project.id, active: true, snapshots: { none: { runId } } },
      select: { id: true, keyword: true, lastSnapshotId: true },
      orderBy: { createdAt: "asc" },
      take: WAVE,
    }) as { id: string; keyword: string; lastSnapshotId: string | null }[];

    if (!pending.length) {
      // Every keyword has had its first try. Ask the transient failures again (see retry.ts);
      // the run stays open while any of them is still cooling down.
      const failedRows = await failedSnapshotsOfRun(runId);
      const wave = pickRetryWave(failedRows.filter(r => r.keyword.active), Date.now(), WAVE);
      if (!wave.due.length) {
        if (wave.waiting > 0) {
          if (wave.nextDueInMs !== null) kickSerpmonSchedulerIn(wave.nextDueInMs);
          return { done: false, processed };
        }
        await finalizeRun(runId);
        return { done: true, processed };
      }
      const retryCreds = await getAparserServerCreds(project.userId);
      if (!retryCreds) {
        await finalizeRun(runId);
        return { done: true, processed };
      }
      const byId = new Map(failedRows.map(r => [r.snapshotId, r]));
      await Promise.all(wave.due.map(async (c) => {
        const row = byId.get(c.snapshotId)!;
        await trackRetry(runId, async () => {
          if (!(await releaseFailedSnapshot(runId, c.snapshotId))) return;
          await collectKeyword(row.keyword, project, runId, retryCreds, ignore, c.attempts + 1);
        });
      }));
      processed += wave.due.length;
      if (Date.now() >= deadline) return { done: false, processed };
      continue;
    }

    // Credentials re-checked per wave: losing them mid-run must read as no_creds on the remaining
    // keywords, not as one giant provider_error.
    const creds = await getAparserServerCreds(project.userId);
    if (!creds) {
      processed += await failRemainingNoCreds(runId, project.id, project.depth);
      await finalizeRun(runId);
      return { done: true, processed };
    }

    const outcomes = await Promise.all(pending.map(kw => collectKeyword(kw, project, runId, creds, ignore)));
    processed += pending.length;

    const judgeFirstWave = firstWave;
    firstWave = false;
    if (judgeFirstWave && pending.length === WAVE) {
      const first = outcomes[0];
      const identical = first.status === "failed"
        && outcomes.every(o => o.status === "failed" && o.problem === first.problem && o.detail === first.detail);
      if (identical) {
        await abortRun(runId, project.id, first);
        return { done: true, processed };
      }
    }

    // A short wave means the first pass is over; the next iteration runs the retry pass (or
    // finalizes). Out of budget: the next tick resumes exactly here.
    if (Date.now() >= deadline) return { done: false, processed };
  }
}

// ─── finalizeRun ─────────────────────────────────────────────────────────────

export async function finalizeRun(runId: string): Promise<RunSummary> {
  const run = await db.serpRun.findUnique({
    where: { id: runId },
    select: {
      id: true, projectId: true, trigger: true, status: true, startedAt: true, finishedAt: true,
      planned: true, ok: true, partial: true, failed: true, compared: true,
      volatility: true, volTop10: true, shareHigh: true, stormScore: true, storm: true, error: true,
      project: {
        select: {
          id: true, userId: true, name: true, alertStorm: true,
          intervalHours: true, retentionDays: true, firstRunAt: true,
        },
      },
    },
  }) as Record<string, DbRow> | null;
  if (!run) throw new Error("serpmon: finalizeRun — run not found");
  if (run.status !== "running") {
    // Already finalized (a retried tick); report what is stored.
    const volBefore = await db.serpRun.count({
      where: { projectId: run.projectId, status: "done", volatility: { gt: 0 }, startedAt: { lt: run.startedAt } },
    });
    return toRunSummary(run as unknown as RunRowLike, volBefore < STORM_MIN_BASELINE);
  }

  const snapshots = await db.serpSnapshot.findMany({
    where: { runId },
    select: { keywordId: true, status: true, volatility: true, volTop10: true, prevId: true },
  }) as { keywordId: string; status: string; volatility: number | null; volTop10: number | null; prevId: string | null }[];

  const compared = snapshots.filter(s => s.prevId).length;
  const vols = snapshots.map(s => s.volatility).filter((v): v is number => typeof v === "number");
  const vols10 = snapshots.map(s => s.volTop10).filter((v): v is number => typeof v === "number");
  const allFailed = snapshots.length > 0 && snapshots.every(s => s.status === "failed");

  const volatility = allFailed || !vols.length ? null : median(vols);
  const volTop10 = allFailed || !vols10.length ? null : median(vols10);

  // shareHigh: for every compared keyword, whether this run's volatility beats its own recent
  // p90. History = the keyword's previous compared snapshots only, so failed runs never dilute it.
  let shareHigh: number | null = null;
  if (!allFailed && compared > 0) {
    const items: { current: number; history: number[] }[] = [];
    for (const s of snapshots) {
      if (typeof s.volatility !== "number") continue;
      const hist = await db.serpSnapshot.findMany({
        where: { keywordId: s.keywordId, runId: { not: runId }, volatility: { not: null } },
        orderBy: { takenAt: "desc" },
        take: KEYWORD_P90_WINDOW,
        select: { volatility: true },
      }) as { volatility: number | null }[];
      items.push({ current: s.volatility, history: hist.map(h => h.volatility as number) });
    }
    shareHigh = shareAboveOwnP90(items);
  }

  // The storm baseline is this project's own history: the last STORM_BASELINE_RUNS done runs
  // that actually measured a volatility, strictly before this run.
  const baselineRows = await db.serpRun.findMany({
    where: { projectId: run.projectId, status: "done", volatility: { gt: 0 }, startedAt: { lt: run.startedAt } },
    orderBy: { startedAt: "desc" },
    take: STORM_BASELINE_RUNS,
    select: { volatility: true },
  }) as { volatility: number | null }[];
  const baseline = baselineRows.map(r => r.volatility as number);
  const verdict = allFailed
    ? { calibrating: false, score: null as number | null, storm: false, baselineRuns: baseline.length }
    : stormVerdict({ current: volatility, baseline, compared, planned: run.planned, shareHigh });

  const finishedAt = new Date();
  const counts = {
    ok: snapshots.filter(s => s.status === "ok").length,
    partial: snapshots.filter(s => s.status === "partial").length,
    failed: snapshots.filter(s => s.status === "failed").length,
  };

  // One line per run, not per keyword: the raw provider error is only diagnosable here.
  if (counts.failed > 0) {
    try {
      const firstFail = await db.serpSnapshot.findFirst({
        where: { runId, status: "failed", detail: { not: null } },
        select: { detail: true, keyword: { select: { keyword: true } } },
        orderBy: { takenAt: "asc" },
      }) as { detail: string | null; keyword: { keyword: string } } | null;
      if (firstFail?.detail) {
        console.warn(`[serpmon-cron] run ${runId} (${run.project.name}): ${counts.failed}/${snapshots.length} keywords failed — first error on "${firstFail.keyword.keyword}": ${firstFail.detail}`);
      }
    } catch { /* the warn is best-effort; the run still finalizes */ }
  }
  const data = {
    status: "done",
    finishedAt,
    ...counts,
    compared,
    volatility,
    volTop10,
    shareHigh: allFailed ? null : shareHigh,
    stormScore: allFailed ? null : verdict.score,
    storm: allFailed ? false : verdict.storm,
    error: allFailed ? "all_failed" : null,
  };
  await db.serpRun.update({ where: { id: runId }, data });

  const nextRunAt = run.project.intervalHours > 0
    ? new Date(finishedAt.getTime() + run.project.intervalHours * 3_600_000)
    : null;
  await db.serpProject.update({
    where: { id: run.projectId },
    data: {
      firstRunAt: run.project.firstRunAt ?? finishedAt,
      lastRunAt: finishedAt,
      nextRunAt,
    },
  });

  const summary = toRunSummary({
    id: run.id,
    trigger: run.trigger,
    status: "done",
    startedAt: run.startedAt,
    finishedAt,
    planned: run.planned,
    ok: counts.ok, partial: counts.partial, failed: counts.failed,
    compared,
    volatility, volTop10,
    shareHigh: data.shareHigh,
    stormScore: data.stormScore,
    storm: data.storm,
    error: data.error,
  }, verdict.calibrating);

  // Side effects must never leave the run in `running` — each gets its own try/catch.
  try {
    const { rebuildProjectHosts } = await import("./domains");
    await rebuildProjectHosts(run.projectId, runId);
  } catch (e) {
    console.warn("[serpmon-cron] rebuildProjectHosts failed:", e);
  }
  try {
    const { serpmonRunAlerts } = await import("./alerts");
    await serpmonRunAlerts(
      run.project.userId,
      { id: run.project.id, name: run.project.name, alertStorm: Boolean(run.project.alertStorm) },
      summary,
    );
  } catch (e) {
    console.warn("[serpmon-cron] serpmonRunAlerts failed:", e);
  }
  try {
    await pruneProjectSnapshots(run.projectId, run.project.retentionDays);
  } catch (e) {
    console.warn("[serpmon-cron] retention pruning failed:", e);
  }

  return summary;
}
