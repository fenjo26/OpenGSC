import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { createProject, listProjects, type ProjectInput } from "@/lib/serpmon/store";
import { assertAparserPresetExists } from "@/lib/serpmon/presetCheck";
import { MAX_IMPORT_BYTES, readJson, serpmonError, tooLarge, unauthorized } from "../shared";

/** GET /api/serp-monitor/projects — every project of the workspace with its list summary. */
export async function GET() {
  try {
    const userId = await workspaceUserId();
    if (!userId) return unauthorized();
    return NextResponse.json({ projects: await listProjects(userId) });
  } catch (e) {
    return serpmonError(e, { projects: [] });
  }
}

/** POST /api/serp-monitor/projects — create a project, importing the pasted keyword list. */
export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return unauthorized();
    const body = await readJson(req);
    if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    const raw = typeof body.keywords === "string" ? body.keywords : "";
    if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) return tooLarge();

    const input: ProjectInput = {
      name: String(body.name ?? ""),
      country: String(body.country ?? ""),
      lang: String(body.lang ?? ""),
      depth: Number(body.depth),
      intervalHours: Number(body.intervalHours),
      ...(raw ? { keywords: raw } : {}),
      ...(typeof body.ownDomains === "string" ? { ownDomains: body.ownDomains } : {}),
      ...(typeof body.ignoreHosts === "string" ? { ignoreHosts: body.ignoreHosts } : {}),
      ...(body.retentionDays !== undefined ? { retentionDays: Number(body.retentionDays) } : {}),
      ...(body.alertStorm !== undefined ? { alertStorm: Boolean(body.alertStorm) } : {}),
      ...(body.paused !== undefined ? { paused: Boolean(body.paused) } : {}),
      ...(body.aparserPreset !== undefined ? { aparserPreset: String(body.aparserPreset ?? "") } : {}),
    };
    if (input.aparserPreset !== undefined) await assertAparserPresetExists(userId, input.aparserPreset);

    return NextResponse.json(await createProject(userId, input));
  } catch (e) {
    return serpmonError(e);
  }
}
