import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteOutreachProspect, updateOutreachProspect } from "@/lib/outreach/service";

async function uid() {
  const session = await getServerSession(authOptions);
  return ((session?.user as any)?.id as string) || null;
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json({ prospect: await updateOutreachProspect(userId, id, body) });
  } catch (error: any) {
    const message = String(error?.message ?? "outreach_error");
    return NextResponse.json({ error: message }, { status: message.endsWith("_not_found") ? 404 : 400 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    await deleteOutreachProspect(userId, id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message ?? "outreach_error") }, { status: 404 });
  }
}
