import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { prisma } from "@/lib/prisma";
import { buildDigestData, renderDigestMarkdown, aiSummary, getDigestSettings, saveDigestSettings, DEFAULT_DIGEST_SETTINGS } from "@/lib/digest";
import { buildEngineRows, configuredEngines } from "@/lib/digestEngines";
import { notifyUser } from "@/lib/notify";
import { normalizeLang } from "@/lib/notifyI18n";
import { rawQuery } from "@/lib/db/raw";

const hasTag = (tagsField: string | null, tag: string): boolean => {
  if (!tagsField) return false;
  try { const arr = JSON.parse(tagsField); if (Array.isArray(arr)) return arr.map(String).map(s => s.toLowerCase()).includes(tag.toLowerCase()); } catch { /* csv */ }
  return tagsField.toLowerCase().split(",").map(s => s.trim()).includes(tag.toLowerCase());
};

// Digest tab API.
// GET                 → { digests (history), settings, tags (all site tags for the picker) }
// POST { action }     → "preview" {tag,days,ai} — build without sending
//                     → "send"    {tag,days,ai} — build + deliver to Telegram + save
//                     → "settings" {settings}   — save the schedule

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

export async function GET() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let digests: any[] = [];
  try {
    digests = await prisma.digest.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 });
  } catch { /* not migrated */ }

  const settings = await getDigestSettings(userId);

  // Distinct tags across the user's sites — for the tag picker.
  const sites = await prisma.site.findMany({ where: { userId }, select: { tags: true } });
  const tags = new Set<string>();
  for (const s of sites) {
    if (!s.tags) continue;
    try {
      const arr = JSON.parse(s.tags);
      if (Array.isArray(arr)) { arr.forEach((t: any) => tags.add(String(t))); continue; }
    } catch { /* comma fallback */ }
    s.tags.split(",").map(x => x.trim()).filter(Boolean).forEach(t => tags.add(t));
  }

  // Telegram connected? (drives UI hints)
  // "telegram" flag historically gates the Send button — true when ANY channel works.
  let telegram = false;
  try {
    const rows: any[] = await rawQuery(
      `SELECT telegramBotToken, telegramChatId, slackWebhook FROM "User" WHERE id = ?`, userId);
    telegram = !!((rows?.[0]?.telegramBotToken && rows?.[0]?.telegramChatId) || rows?.[0]?.slackWebhook);
  } catch { /* not migrated */ }

  const engines = await configuredEngines(userId).catch(() => ({ bing: false, yandex: false }));

  return NextResponse.json({ digests, settings, tags: [...tags].sort(), telegram, engines });
}

export async function POST(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const action = String(b.action ?? "");
  const tag = String(b.tag ?? "");
  const rawDays = parseInt(String(b.days ?? 7), 10) || 7;
  const days = rawDays === 0 ? 0 : Math.min(3650, Math.max(1, rawDays));
  const ai = !!b.ai;
  const lang = normalizeLang(b.lang);

  // Live per-engine rows for the page's Bing/Yandex tabs (lazy-loaded on tab click).
  if (action === "engine") {
    const engine = b.engine === "yandex" ? "yandex" : "bing";
    const allSites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true, tags: true } });
    const sites = tag ? allSites.filter(s => hasTag(s.tags, tag)) : allSites;
    const rows = await buildEngineRows(userId, engine, sites, days || 28, 120).catch(() => []);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0), impr = rows.reduce((s, r) => s + r.impr, 0);
    return NextResponse.json({ engine, rows, totals: { clicks, impr, sites: rows.length } });
  }

  if (action === "preview" || action === "send") {
    // Preview: Google-only for speed (engine tabs load lazily). Send: include engines in the
    // Telegram text (bounded cap) so the delivered summary still mentions Bing/Yandex.
    const data = await buildDigestData(userId, tag, days, lang, { engineCap: action === "send" ? 25 : 0 });
    const content = renderDigestMarkdown(data);
    let full = content;
    let aiText: string | null = null;
    if (ai) {
      aiText = await aiSummary(userId, content, lang);
      if (aiText) full = `${content}\n\n${aiText}`;
    }
    let sent = false;
    if (action === "send") {
      sent = await notifyUser(userId, full);
      try {
        await prisma.digest.create({ data: { userId, tag, days, content: full, sentTo: sent ? "telegram" : null } });
      } catch { /* not migrated */ }
      if (!sent) return NextResponse.json({ content: full, data, ai: aiText, sent, error: "telegram_not_connected" });
    }
    return NextResponse.json({ content: full, data, ai: aiText, sent });
  }

  if (action === "settings") {
    const s = { ...DEFAULT_DIGEST_SETTINGS, ...(b.settings ?? {}) };
    s.hourUtc = Math.min(23, Math.max(0, parseInt(String(s.hourUtc), 10) || 8));
    s.days = s.days === 0 ? 0 : Math.min(3650, Math.max(1, parseInt(String(s.days), 10) || 7));
    s.frequency = s.frequency === "daily" ? "daily" : "weekly";
    try {
      await saveDigestSettings(userId, s);
      return NextResponse.json({ ok: true, settings: s });
    } catch {
      return NextResponse.json({ error: "not_migrated" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "no_id" }, { status: 400 });
  try {
    await prisma.digest.deleteMany({ where: { id, userId } });
  } catch { /* not migrated */ }
  return NextResponse.json({ ok: true });
}
