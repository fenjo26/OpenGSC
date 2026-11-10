import { NextResponse } from "next/server";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { workspaceUserId } from "@/lib/team/workspace";
import { buildZip, type ZipEntry } from "@/lib/pbn/zip";

// GET /api/ext/download — the browser extension as a .zip, built on the fly from this
// instance's own `extension/` folder, so the download always matches the server version the
// extension will talk to. Session-guarded (Settings → Browser extension card): /api/ext/** is
// exempt from the proxy auth gate because the extension itself authenticates with a Bearer
// token, so this route checks the session on its own.

const ROOT_IN_ZIP = "opengsc-extension";
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;

async function collect(dir: string, rel: string, out: ZipEntry[], budget: { bytes: number }): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .DS_Store, editor droppings
    const abs = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await collect(abs, relPath, out, budget);
    } else if (e.isFile()) {
      if (out.length >= MAX_FILES) throw new Error("too_many_files");
      const size = (await stat(abs)).size;
      budget.bytes += size;
      if (budget.bytes > MAX_BYTES) throw new Error("too_large");
      out.push({ path: `${ROOT_IN_ZIP}/${relPath}`, data: await readFile(abs) });
    }
  }
}

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dir = path.join(process.cwd(), "extension");
  let version = "";
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { version?: string };
    version = String(manifest.version ?? "");
  } catch {
    // no extension folder in this deployment (e.g. a trimmed image) — the card links to GitHub
    return NextResponse.json({ error: "extension_not_found" }, { status: 404 });
  }

  const entries: ZipEntry[] = [];
  try {
    await collect(dir, "", entries, { bytes: 0 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "read_failed" }, { status: 500 });
  }

  const zip = buildZip(entries);
  const name = `opengsc-extension${version ? "-" + version.replace(/[^0-9.]/g, "") : ""}.zip`;
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
