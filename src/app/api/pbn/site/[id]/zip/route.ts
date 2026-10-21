import { workspaceUserId } from "@/lib/team/workspace";
import { getSite } from "@/lib/pbn/store";
import { buildZip, type ZipEntry } from "@/lib/pbn/zip";
import { residualFootprints } from "@/lib/pbn/clean";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

async function walk(dir: string, root: string, out: ZipEntry[]): Promise<void> {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, root, out);
    else out.push({ path: path.relative(root, full).split(path.sep).join("/"), data: await fs.readFile(full) });
  }
}

/** GET — ZIP восстановленного сайта + robots.txt + .htaccess бот-щита. Гейт: нет чужих следов. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const site = await getSite(userId, id);
  if (!site?.diskPath) return new Response("not found", { status: 404 });

  const entries: ZipEntry[] = [];
  try { await walk(path.resolve(site.diskPath), path.resolve(site.diskPath), entries); }
  catch { return new Response("nothing to export", { status: 404 }); }
  if (!entries.length) return new Response("empty", { status: 404 });

  // Гейт футпринтов: ни один HTML не должен нести web.archive.org или чужие метки.
  for (const e of entries) {
    if (/\.html?$/i.test(e.path)) {
      const found = residualFootprints(e.data.toString("utf8"));
      if (found.length) return new Response(`footprint in ${e.path}: ${found.join(", ")}`, { status: 409 });
    }
  }
  // Бот-щит (блок SEO-пауков) + robots.
  entries.push({ path: ".htaccess", data: Buffer.from("RewriteEngine On\nRewriteCond %{HTTP_USER_AGENT} (AhrefsBot|SemrushBot|MJ12bot|DotBot|rogerbot|BLEXBot) [NC]\nRewriteRule .* - [F,L]\n", "utf8") });
  entries.push({ path: "robots.txt", data: Buffer.from("User-agent: AhrefsBot\nDisallow: /\nUser-agent: SemrushBot\nDisallow: /\nUser-agent: MJ12bot\nDisallow: /\n", "utf8") });

  const zip = buildZip(entries);
  return new Response(new Uint8Array(zip), { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${site.domain}.zip"` } });
}
