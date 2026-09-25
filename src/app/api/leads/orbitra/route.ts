// N9 → Orbitra bridge: the tracker connection settings (instance-wide — one self-hosted
// workspace runs one tracker). GET never returns the key; PUT needs act; POST tests the
// connection with one read call.

import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { OrbitraError, readOrbitraConfig, saveOrbitraConfig, testOrbitra } from "@/lib/leads/orbitra";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cfg = await readOrbitraConfig();
  return NextResponse.json({ configured: !!cfg, url: cfg?.url ?? "" });
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { url?: unknown; key?: unknown };
  try {
    const cfg = await saveOrbitraConfig(String(body.url ?? ""), String(body.key ?? ""));
    return NextResponse.json({ ok: true, url: cfg.url });
  } catch (e) {
    if (e instanceof OrbitraError) return NextResponse.json({ error: e.code }, { status: 400 });
    console.warn("[leads/orbitra] save failed:", e);
    return NextResponse.json({ error: "save_failed" }, { status: 500 });
  }
}

export async function POST() {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cfg = await readOrbitraConfig();
  if (!cfg) return NextResponse.json({ error: "not_configured" }, { status: 400 });
  try {
    await testOrbitra(cfg);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof OrbitraError) return NextResponse.json({ error: e.code }, { status: 502 });
    console.warn("[leads/orbitra] test failed:", e);
    return NextResponse.json({ error: "test_failed" }, { status: 500 });
  }
}
