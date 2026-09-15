import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { deleteProject, getProject, updateProject, type ProjectInput } from "@/lib/serpmon/store";
import { readJson, serpmonError, unauthorized } from "../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/serp-monitor/projects/[id] — the project with groups and run history digest. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    const { id } = await params;
    const project = await getProject(userId, id);
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (e) {
    return serpmonError(e, { project: null });
  }
}

/** PATCH /api/serp-monitor/projects/[id] — edit settings. `keywords` is not a patch field. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return unauthorized();
    const { id } = await params;
    const body = await readJson(req);
    if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    delete body.keywords;

    const patch: Partial<ProjectInput> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.country !== undefined) patch.country = String(body.country);
    if (body.lang !== undefined) patch.lang = String(body.lang);
    if (body.depth !== undefined) patch.depth = Number(body.depth);
    if (body.intervalHours !== undefined) patch.intervalHours = Number(body.intervalHours);
    if (body.ownDomains !== undefined) patch.ownDomains = String(body.ownDomains);
    if (body.ignoreHosts !== undefined) patch.ignoreHosts = String(body.ignoreHosts);
    if (body.retentionDays !== undefined) patch.retentionDays = Number(body.retentionDays);
    if (body.alertStorm !== undefined) patch.alertStorm = Boolean(body.alertStorm);
    if (body.paused !== undefined) patch.paused = Boolean(body.paused);

    const project = await updateProject(userId, id, patch);
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (e) {
    return serpmonError(e);
  }
}

/** DELETE /api/serp-monitor/projects/[id] — the project and, by cascade, all its snapshots. */
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return unauthorized();
    const { id } = await params;
    const ok = await deleteProject(userId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serpmonError(e);
  }
}
