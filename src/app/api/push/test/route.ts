import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getAlertSettings } from "@/lib/alertScheduler";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import { sendWorkspacePush } from "@/lib/push";

// POST /api/push/test (CONTRACT.md §4, act) — one test push to every device of the caller's
// workspace. The message speaks the language the user picked for alerts, exactly like the
// other channels' "Send test" in testChannel().
export async function POST() {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const lang = normalizeLang((await getAlertSettings(userId)).lang);
    const text = NOTIFY_L[lang].notifyTestMsg("Web Push");
    const report = await sendWorkspacePush(userId, text.split("\n")[0] ?? text, text, "test", { url: "/" });
    return NextResponse.json({
      ok: report.ok > 0,
      sent: report.sent,
      delivered: report.ok,
      dropped: report.dropped,
      ...(report.sent === 0 ? { error: "not_configured" } : {}),
      ...(report.error ? { error: report.error } : {}),
    });
  } catch {
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
