import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { createRun, listRuns, schemaMissing } from "@/lib/drops/store";
import type { DropSource } from "@/lib/drops/types";

const SOURCES: DropSource[] = ["csv", "ahrefs_refdomains", "ahrefs_broken", "crawler", "zone_diff"];

/**
 * A pasted list is not small. 8 MB of text is roughly 400 000 domain rows, which is more than
 * anyone imports in one go and still far below what would exhaust the process; a larger body is
 * refused with a message rather than parsed into an out-of-memory crash.
 */
const MAX_RAW_BYTES = 8 * 1024 * 1024;

export async function GET() {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json(await listRuns(userId));
  } catch (e) {
    // An instance that pulled the code but has not restarted has no tables yet. The page shows a
    // "run prisma db push" notice for this; a 500 would read as a bug in the module.
    if (schemaMissing(e)) return NextResponse.json({ runs: [], notMigrated: true });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }

    const raw = typeof body.raw === "string" ? body.raw : "";
    if (!raw.trim()) return NextResponse.json({ error: "Nothing to import" }, { status: 400 });
    if (Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES) {
      return NextResponse.json({ error: "List too large — split it into several imports" }, { status: 413 });
    }

    const source: DropSource = SOURCES.includes(body.source) ? body.source : "csv";

    const result = await createRun(userId, {
      label: typeof body.label === "string" ? body.label : null,
      source,
      sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : null,
      raw,
    });

    // Everything the import summary needs, including WHY rows were dropped. A bare count invites
    // the user to assume the tool lost them.
    return NextResponse.json(result);
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
