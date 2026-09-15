// SERP Monitor — storm alerts. finalizeRun (collector, T3) calls serpmonRunAlerts once per done
// run; a run whose median volatility rose far above the project's own baseline (robust z ≥ 3,
// see volatility.ts) turns into one Telegram/Slack message. Same delivery and dedupe shape as
// the hourly rules in alertScheduler.ts: the text is stored as an AlertEvent row first (unique
// dedupeKey = a re-run of the same event is a silent no-op), then delivered, then marked sent.
//
// There is no instance base URL to link to: the existing alerts (alertScheduler, drops watch)
// also send plain text without links, and no APP_URL-style setting exists to build one from.

import { prisma } from "@/lib/prisma";
import { getAlertSettings } from "@/lib/alertScheduler";
import { notifyUser, getTelegramCreds, getSlackWebhook } from "@/lib/notify";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import type { RunSummary } from "./types";

/** The storm score as text: one decimal is the whole precision the verdict has. */
const scoreLabel = (score: number | null): string => (score != null && isFinite(score) ? score.toFixed(1) : "—");
/** shareHigh is 0..1; alerts speak percents. */
const shareLabel = (share: number | null): string => (share != null && isFinite(share) ? `${Math.round(share * 100)}%` : "—");

/** Pure: the message text. */
export function stormAlertText(lang: string, input: { project: string; run: RunSummary; topKeywords: string[]; topHosts: { host: string; enters: number; exits: number }[] }): string {
  const L = NOTIFY_L[normalizeLang(lang)];
  const lines = [
    L.serpmonStormTitle(input.project),
    "",
    L.serpmonStormScore(scoreLabel(input.run.stormScore), shareLabel(input.run.shareHigh)),
  ];
  // The caller caps both lists at 5; the slice is repeated here so the pure function keeps that
  // guarantee on its own (a notification that lists fifty hosts is not a notification).
  if (input.topKeywords.length) {
    lines.push("", L.serpmonStormKeywords(input.topKeywords.slice(0, 5).join(", ")));
  }
  if (input.topHosts.length) {
    lines.push("", L.serpmonStormHosts(
      input.topHosts.slice(0, 5).map(h => `${h.host} (+${h.enters}/−${h.exits})`).join(", "),
    ));
  }
  return lines.join("\n");
}

/** Up to 5 keywords of this run with the highest volatility. */
async function topKeywordsOfRun(runId: string): Promise<string[]> {
  const snaps = await prisma.serpSnapshot.findMany({
    where: { runId, volatility: { not: null } },
    select: { volatility: true, keyword: { select: { keyword: true } } },
  });
  return snaps
    .sort((a, b) => (b.volatility ?? 0) - (a.volatility ?? 0))
    .slice(0, 5)
    .map(s => s.keyword.keyword);
}

/** Up to 5 hosts with the most enters+exits among the run's visible (non-hidden) changes. */
async function topHostsOfRun(projectId: string, runId: string): Promise<{ host: string; enters: number; exits: number }[]> {
  const changes = await prisma.serpChange.findMany({
    where: { projectId, hidden: false, kind: { in: ["enter", "exit"] }, snapshot: { runId } },
    select: { kind: true, hostId: true },
  });
  const counts = new Map<number, { enters: number; exits: number }>();
  for (const c of changes) {
    const acc = counts.get(c.hostId) ?? { enters: 0, exits: 0 };
    if (c.kind === "enter") acc.enters++; else acc.exits++;
    counts.set(c.hostId, acc);
  }
  const ids = [...counts.entries()]
    .sort((a, b) => (b[1].enters + b[1].exits) - (a[1].enters + a[1].exits))
    .slice(0, 5)
    .map(([id]) => id);
  if (!ids.length) return [];
  const hosts = await prisma.serpHost.findMany({ where: { id: { in: ids } }, select: { id: true, host: true } });
  const nameOf = new Map(hosts.map(h => [h.id, h.host]));
  return ids.map(id => ({ host: nameOf.get(id) ?? `#${id}`, ...counts.get(id)! }));
}

/** Called by finalizeRun once per done run. Never throws: logs and returns. */
export async function serpmonRunAlerts(userId: string, project: { id: string; name: string; alertStorm: boolean }, run: RunSummary): Promise<void> {
  try {
    if (!project.alertStorm || !run.storm) return;
    const settings = await getAlertSettings(userId);
    if (!settings.serpmonStorm.enabled) return;

    const [topKeywords, topHosts] = await Promise.all([
      topKeywordsOfRun(run.id),
      topHostsOfRun(project.id, run.id),
    ]);
    const text = stormAlertText(settings.lang, { project: project.name, run, topKeywords, topHosts });
    // Split back into title/message for the AlertEvent row — get_alerts (MCP) and the alerts
    // panel read them as separate fields, and delivery joins them exactly back into `text`.
    const nl = text.indexOf("\n");
    const title = nl < 0 ? text : text.slice(0, nl);
    const message = nl < 0 ? "" : text.slice(nl + 1).trimStart();

    const dedupeKey = `serp_storm:${run.id}`;
    try {
      await prisma.alertEvent.create({ data: { userId, type: "serp_storm", title, message, dedupeKey } });
    } catch {
      return; // duplicate — this run already alerted
    }
    const ok = await notifyUser(userId, text);
    if (ok) await prisma.alertEvent.updateMany({ where: { userId, dedupeKey }, data: { sent: true } });
  } catch (e) {
    // A dead channel or a half-migrated table must never fail the run that just finished.
    console.warn("[serpmon-alert] failed:", e);
  }
}

export async function sendSerpmonTestAlert(userId: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
  // The same channel test notifyUser itself applies — say "no channel" before fabricating anything.
  const [creds, slackUrl] = await Promise.all([getTelegramCreds(userId), getSlackWebhook(userId)]);
  if (!creds && !slackUrl) return { ok: false, error: "no_channel" };

  const project = await prisma.serpProject.findFirst({ where: { id: projectId, userId }, select: { name: true } }).catch(() => null);
  if (!project) return { ok: false, error: "not_found" };

  const settings = await getAlertSettings(userId);
  const now = new Date().toISOString();
  const run: RunSummary = {
    id: "test", trigger: "manual", status: "done", startedAt: now, finishedAt: now,
    planned: 40, ok: 40, partial: 0, failed: 0, compared: 38,
    volatility: 0.34, volTop10: 0.22, shareHigh: 0.55,
    stormScore: 4.2, storm: true, calibrating: false, error: null,
  };
  const text = `${NOTIFY_L[normalizeLang(settings.lang)].serpmonTestPrefix}\n\n${stormAlertText(settings.lang, {
    project: project.name,
    run,
    // Sample keywords/hosts are deliberately generic — the test prefix above already says the
    // numbers are fabricated, and real ones will come from the project's own keyword set.
    topKeywords: ["casino online", "online casino bonus", "slot machines", "free spins", "no deposit bonus"],
    topHosts: [
      { host: "casino-ejemplo.com", enters: 4, exits: 1 },
      { host: "noticias-ejemplo.com", enters: 2, exits: 2 },
    ],
  })}`;
  // No AlertEvent: a test is not an occurrence anyone needs deduped or archived.
  const ok = await notifyUser(userId, text);
  return ok ? { ok: true } : { ok: false, error: "send_failed" };
}
