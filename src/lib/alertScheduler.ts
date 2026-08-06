// Alert engine — in-process scheduler (same pattern as rank-cron/clarity-cron, started
// from instrumentation.ts). Every hour it evaluates each user's enabled alert rules over
// data the app already has, records fired alerts as AlertEvent rows (unique dedupeKey =
// no repeats), and delivers new ones to the user's Telegram bot.
//
// Rules (all thresholds user-configurable in Settings → Notifications):
//   rank_drop     — a tracked keyword fell N+ positions between its last two checks
//   traffic_drop  — a site's clicks over the last 7 days fell X%+ vs the previous 7 days
//   ssl_expiry    — a site's SSL certificate expires within N days (from Site Health data)
//   audit_score   — a completed site audit came back with health score below N
//   lost_link     — referring domains above a DR threshold disappeared from the stored profile

import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang, type NotifyLang } from "@/lib/notifyI18n";
import { lostSince } from "@/lib/seo/backlinkStore";
import { rawQuery } from "@/lib/db/raw";

const TICK_MS = 60 * 60 * 1000; // hourly

export interface AlertSettings {
  rankDrop: { on: boolean; threshold: number };
  trafficDrop: { on: boolean; percent: number };
  ssl: { on: boolean; days: number };
  audit: { on: boolean; minScore: number };
  lostLink: { on: boolean; minDr: number };
  lang: NotifyLang; // language of delivered alerts (saved from the UI language)
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  rankDrop: { on: true, threshold: 5 },
  trafficDrop: { on: true, percent: 30 },
  ssl: { on: true, days: 14 },
  audit: { on: true, minScore: 50 },
  // Off by default: it can only fire once a backlink profile has been loaded, and turning it
  // on for users who never will would be a setting that does nothing.
  lostLink: { on: false, minDr: 50 },
  lang: "en",
};

export async function getAlertSettings(userId: string): Promise<AlertSettings> {
  try {
    const rows: any[] = await rawQuery(`SELECT alertSettings FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.alertSettings;
    if (!raw) return DEFAULT_ALERT_SETTINGS;
    const s = JSON.parse(raw);
    return {
      rankDrop: { ...DEFAULT_ALERT_SETTINGS.rankDrop, ...(s.rankDrop ?? {}) },
      trafficDrop: { ...DEFAULT_ALERT_SETTINGS.trafficDrop, ...(s.trafficDrop ?? {}) },
      ssl: { ...DEFAULT_ALERT_SETTINGS.ssl, ...(s.ssl ?? {}) },
      audit: { ...DEFAULT_ALERT_SETTINGS.audit, ...(s.audit ?? {}) },
      lostLink: { ...DEFAULT_ALERT_SETTINGS.lostLink, ...(s.lostLink ?? {}) },
      lang: normalizeLang(s.lang),
    };
  } catch {
    return DEFAULT_ALERT_SETTINGS;
  }
}

type Pending = { type: string; siteId?: string; title: string; message: string; dedupeKey: string };

const isoDay = () => new Date().toISOString().slice(0, 10);
const isoWeek = () => {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return `${d.getFullYear()}w${Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + jan1.getDay() + 1) / 7)}`;
};

async function checkUser(userId: string, s: AlertSettings): Promise<Pending[]> {
  const L = NOTIFY_L[normalizeLang(s.lang)];
  const out: Pending[] = [];
  // Archived properties are excluded: a removed domain's traffic goes to zero by definition,
  // which would fire a traffic-drop alert every single run.
  const sites = await prisma.site.findMany({ where: { userId, archivedAt: null }, select: { id: true, url: true } });
  const siteName = new Map(sites.map(x => [x.id, x.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")]));
  const siteIds = sites.map(x => x.id);
  if (!siteIds.length) return out;

  // ── rank_drop: last check happened within the last day and fell threshold+ positions
  if (s.rankDrop.on) {
    const since = new Date(Date.now() - 26 * 3600_000);
    const kws = await prisma.trackedKeyword.findMany({
      where: { siteId: { in: siteIds }, lastCheckedAt: { gte: since }, lastPosition: { not: null }, prevPosition: { not: null } },
    });
    for (const k of kws) {
      const drop = (k.lastPosition ?? 0) - (k.prevPosition ?? 0); // positive = worse
      if (drop >= s.rankDrop.threshold) {
        out.push({
          type: "rank_drop", siteId: k.siteId,
          title: L.rankDropTitle(k.keyword),
          message: L.rankDropMsg(String(siteName.get(k.siteId)), k.keyword, k.country, drop, k.prevPosition, k.lastPosition),
          dedupeKey: `rank_drop:${k.id}:${isoDay()}`,
        });
      }
    }
  }

  // ── traffic_drop: clicks last 7d vs previous 7d, per site (weekly dedupe)
  if (s.trafficDrop.on) {
    const now = new Date();
    const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
    const d14 = new Date(now); d14.setDate(d14.getDate() - 14);
    for (const site of sites) {
      const [cur, prev] = await Promise.all([
        prisma.dailyMetric.aggregate({ where: { siteId: site.id, date: { gte: d7 } }, _sum: { clicks: true } }),
        prisma.dailyMetric.aggregate({ where: { siteId: site.id, date: { gte: d14, lt: d7 } }, _sum: { clicks: true } }),
      ]);
      const c = cur._sum.clicks ?? 0, p = prev._sum.clicks ?? 0;
      if (p >= 50 && c < p * (1 - s.trafficDrop.percent / 100)) {
        const pct = Math.round((1 - c / p) * 100);
        out.push({
          type: "traffic_drop", siteId: site.id,
          title: L.trafficDropTitle(String(siteName.get(site.id))),
          message: L.trafficDropMsg(String(siteName.get(site.id)), pct, p, c),
          dedupeKey: `traffic_drop:${site.id}:${isoWeek()}`,
        });
      }
    }
  }

  // ── ssl_expiry: from cached SiteHealth (weekly dedupe per site)
  if (s.ssl.on) {
    const health = await prisma.siteHealth.findMany({ where: { siteId: { in: siteIds } } });
    for (const h of health) {
      try {
        const ssl = h.sslData ? JSON.parse(h.sslData) : null;
        const daysLeft = Number(ssl?.daysLeft);
        if (isFinite(daysLeft) && daysLeft <= s.ssl.days) {
          out.push({
            type: "ssl_expiry", siteId: h.siteId,
            title: L.sslTitle(String(siteName.get(h.siteId))),
            message: L.sslMsg(String(siteName.get(h.siteId)), daysLeft),
            dedupeKey: `ssl_expiry:${h.siteId}:${isoWeek()}`,
          });
        }
      } catch { /* malformed health JSON */ }
    }
  }

  // ── audit_score: latest completed audit per site below threshold (dedupe per audit id)
  if (s.audit.on) {
    for (const site of sites) {
      const audit = await prisma.siteAudit.findFirst({
        where: { siteId: site.id, status: "completed" },
        orderBy: { startedAt: "desc" },
      });
      if (!audit?.summary) continue;
      try {
        const sum = JSON.parse(audit.summary);
        if (Number(sum?.healthScore) < s.audit.minScore) {
          out.push({
            type: "audit_score", siteId: site.id,
            title: L.auditTitle(String(siteName.get(site.id))),
            message: L.auditMsg(String(siteName.get(site.id)), Number(sum.healthScore), Number(sum.pagesWithIssues), Number(sum.pages)),
            dedupeKey: `audit_score:${audit.id}`,
          });
        }
      } catch { /* malformed summary */ }
    }
  }

  // ── lost_link: referring domains above the DR threshold that went away in the last day.
  // Reads only what a profile refresh already stored — this rule never calls a provider and
  // therefore never spends anything on its own.
  if (s.lostLink.on) {
    const since = new Date(Date.now() - 26 * 3600_000).toISOString().slice(0, 10);
    for (const site of sites) {
      const target = site.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];
      const lost = await lostSince(target, since, s.lostLink.minDr);
      if (!lost.length) continue;
      out.push({
        type: "lost_link", siteId: site.id,
        title: L.lostLinkTitle(String(siteName.get(site.id))),
        message: L.lostLinkMsg(
          String(siteName.get(site.id)), lost.length,
          lost.slice(0, 5).map(l => `${l.refDomain} (DR ${Math.round(l.dr)})`).join(", "),
          s.lostLink.minDr,
        ),
        // Per day, not per domain: five links lost at once is one piece of news, not five.
        dedupeKey: `lost_link:${site.id}:${isoDay()}`,
      });
    }
  }

  return out;
}

export async function runAlertsOnce(userId?: string): Promise<number> {
  // Users worth checking = users with a connected Telegram or Slack Webhook (alerts go nowhere otherwise).
  let userIds: string[] = [];
  try {
    const rows: any[] = userId
      ? [{ id: userId }]
      : await rawQuery(`SELECT id FROM "User" WHERE (telegramBotToken IS NOT NULL AND telegramChatId IS NOT NULL) OR slackWebhook IS NOT NULL`);
    userIds = rows.map(r => r.id);
  } catch {
    return 0; // columns not migrated yet
  }

  let fired = 0;
  for (const uid of userIds) {
    try {
      const settings = await getAlertSettings(uid);
      const pending = await checkUser(uid, settings);
      for (const p of pending) {
        // Unique dedupeKey — a second tick with the same event is a silent no-op.
        try {
          await prisma.alertEvent.create({
            data: { userId: uid, type: p.type, siteId: p.siteId, title: p.title, message: p.message, dedupeKey: p.dedupeKey },
          });
        } catch { continue; } // duplicate — already alerted
        const ok = await notifyUser(uid, `${p.title}\n\n${p.message}`);
        if (ok) await prisma.alertEvent.updateMany({ where: { userId: uid, dedupeKey: p.dedupeKey }, data: { sent: true } });
        fired++;
      }
    } catch (e) {
      console.warn(`[alert-cron] user ${uid} failed:`, e);
    }
  }
  return fired;
}

let started = false;
let running = false;

export function startAlertScheduler() {
  if (started) return;
  started = true;
  console.log("[alert-cron] scheduler started");
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await runAlertsOnce();
      if (n) console.log(`[alert-cron] fired ${n} alert(s)`);
    } catch (e) {
      console.warn("[alert-cron] tick failed:", e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 90_000); // first pass shortly after boot
  setInterval(tick, TICK_MS);
}
