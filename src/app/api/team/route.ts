import { NextResponse } from "next/server";
import { capabilitiesOf } from "@/lib/team/roles";
import { listWorkspace } from "@/lib/team/service";
import { prisma } from "@/lib/prisma";
import { getWorkspace, unauthorized } from "@/lib/team/workspace";

// GET /api/team — the workspace, its members, and what the caller is allowed to do.
// Readable by every role: knowing who else is in the workspace is not a privilege, and the UI needs
// the capability list to decide which controls to render at all.
export async function GET() {
  const ws = await getWorkspace();
  if (!ws) return unauthorized();
  const data = await listWorkspace(ws);
  const account = await prisma.user.findUnique({ where: { id: ws.actorId }, select: { passwordHash: true } }).catch(() => null);
  return NextResponse.json({
    ...data,
    me: {
      id: ws.actorId,
      email: ws.actorEmail,
      role: ws.role,
      capabilities: capabilitiesOf(ws.role),
      mustChangePassword: ws.mustChangePassword,
      // Drives the "set a password" prompt: an owner still signing in with Google has none yet, and
      // Google remains a valid login only until they do.
      hasPassword: !!account?.passwordHash,
    },
  });
}
