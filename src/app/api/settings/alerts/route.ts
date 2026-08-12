import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { prisma } from "@/lib/prisma";
import { getAlertSettings, DEFAULT_ALERT_SETTINGS, runAlertsOnce } from "@/lib/alertScheduler";
import { normalizeLang } from "@/lib/notifyI18n";
import { rawExec } from "@/lib/db/raw";

// Alert rules (Settings → Notifications).
// GET  → { settings, recent (last 20 fired alerts) }
// POST → { settings } save;  { action: "run" } evaluate rules right now (for testing)

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

export async function GET() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = await getAlertSettings(userId);
  let recent: any[] = [];
  try {
    recent = await prisma.alertEvent.findMany({
      where: { userId }, orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, type: true, title: true, message: true, sent: true, createdAt: true },
    });
  } catch { /* not migrated */ }
  return NextResponse.json({ settings, recent });
}

export async function POST(req: Request) {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));

  if (b.action === "run") {
    const fired = await runAlertsOnce(userId);
    return NextResponse.json({ ok: true, fired });
  }

  const cur = await getAlertSettings(userId);
  const s = {
    rankDrop: { ...cur.rankDrop, ...(b.settings?.rankDrop ?? {}) },
    trafficDrop: { ...cur.trafficDrop, ...(b.settings?.trafficDrop ?? {}) },
    ssl: { ...cur.ssl, ...(b.settings?.ssl ?? {}) },
    audit: { ...cur.audit, ...(b.settings?.audit ?? {}) },
    lostLink: { ...cur.lostLink, ...(b.settings?.lostLink ?? {}) },
    lang: (b.settings?.lang ? normalizeLang(b.settings.lang) : cur.lang ?? "en"),
  };
  s.rankDrop.threshold = Math.min(50, Math.max(1, Number(s.rankDrop.threshold) || DEFAULT_ALERT_SETTINGS.rankDrop.threshold));
  s.trafficDrop.percent = Math.min(95, Math.max(5, Number(s.trafficDrop.percent) || DEFAULT_ALERT_SETTINGS.trafficDrop.percent));
  s.ssl.days = Math.min(60, Math.max(1, Number(s.ssl.days) || DEFAULT_ALERT_SETTINGS.ssl.days));
  s.audit.minScore = Math.min(100, Math.max(0, Number(s.audit.minScore) || DEFAULT_ALERT_SETTINGS.audit.minScore));
  // 0 is a legitimate value here ("alert on any lost domain"), so the `|| default` idiom used
  // above would be wrong — it would silently rewrite a deliberate 0 into 50.
  {
    const raw = Number(s.lostLink.minDr);
    s.lostLink.minDr = Number.isFinite(raw) ? Math.min(90, Math.max(0, raw)) : DEFAULT_ALERT_SETTINGS.lostLink.minDr;
  }
  try {
    await rawExec(`UPDATE "User" SET alertSettings = ? WHERE id = ?`, JSON.stringify(s), userId);
    return NextResponse.json({ ok: true, settings: s });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}
