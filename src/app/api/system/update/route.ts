import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";

// Self-update runner.
// POST /api/system/update        → owner-only. Spawns update.sh detached, streams to a log.
// GET  /api/system/update        → { running, done, failed, log } (poll for progress)
//
// Security: single-operator app — every authenticated session IS the instance owner
// (see lib/auth.ts, which links all Google accounts to the first user). Guests (share
// links) have no session and are rejected. We additionally verify the session's user is
// the owner row, so this can never be triggered anonymously.

const LOG_PATH = path.join(os.tmpdir(), "opengsc-update.log");
const START = "___OPENGSC_UPDATE_START___";
const DONE = "___OPENGSC_UPDATE_DONE___";
const FAIL = "___OPENGSC_UPDATE_FAIL___";

async function assertOwner(): Promise<boolean> {
  const userId = await workspaceUserId();
  if (!userId) return false;
  const owner = await prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  return !!owner && owner.id === userId;
}

function readLog(): string {
  try { return existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : ""; } catch { return ""; }
}

export async function GET() {
  if (!(await assertOwner())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const log = readLog();
  const done = log.includes(DONE);
  const failed = log.includes(FAIL);
  const started = log.includes(START);
  return NextResponse.json({
    running: started && !done && !failed,
    done,
    failed,
    log: log.slice(-8000), // last chunk is enough for the UI
  });
}

export async function POST() {
  if (!(await assertOwner())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scriptPath = path.join(process.cwd(), "update.sh");
  if (!existsSync(scriptPath)) {
    return NextResponse.json({ error: "update_script_missing", message: "update.sh not found — is this a git checkout?" }, { status: 400 });
  }
  if (!existsSync(path.join(process.cwd(), ".git"))) {
    return NextResponse.json({ error: "not_git", message: "This instance isn't a git checkout (e.g. Docker). Update via your normal deploy flow." }, { status: 400 });
  }

  // Don't start a second run if one is already in progress.
  const log = readLog();
  if (log.includes(START) && !log.includes(DONE) && !log.includes(FAIL)) {
    // If the log is stale (>15 min) allow a restart, else block.
    return NextResponse.json({ ok: true, alreadyRunning: true });
  }

  // Fresh log, then spawn detached so pm2 restart at the end doesn't kill the updater
  // along with this Node process. `bash -c '... > log 2>&1'` keeps it fully independent.
  try {
    const child = spawn(
      "bash",
      ["-c", `bash "${scriptPath}" > "${LOG_PATH}" 2>&1`],
      { detached: true, stdio: "ignore", cwd: process.cwd() },
    );
    child.unref();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: "spawn_failed", message: String(e?.message ?? e) }, { status: 500 });
  }
}
