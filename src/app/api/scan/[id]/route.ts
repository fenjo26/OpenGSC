import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findRelated, scanDto } from "@/lib/scanner/service";
import { requireWorkspace } from "@/lib/team/workspace";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWorkspace("read");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const row = await (prisma as any).siteScan.findFirst({ where: { id, userId: guard.ws.ownerId } }).catch(() => null);
  if (!row) return NextResponse.json({ error: "scan_not_found" }, { status: 404 });
  const keys = row.fingerprints ? JSON.parse(row.fingerprints) : [];
  return NextResponse.json({ scan: scanDto(row, await findRelated(guard.ws.ownerId, row.id, keys)) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireWorkspace("write");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const row = await (prisma as any).siteScan.findFirst({ where: { id, userId: guard.ws.ownerId }, select: { id: true } }).catch(() => null);
  if (!row) return NextResponse.json({ error: "scan_not_found" }, { status: 404 });
  await (prisma as any).siteScan.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
