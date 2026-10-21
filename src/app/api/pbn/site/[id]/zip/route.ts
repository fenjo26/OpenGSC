import { workspaceUserId } from "@/lib/team/workspace";
import { getSite, listLinks } from "@/lib/pbn/store";
import { renderPage, type RenderLink } from "@/lib/pbn/restore";
import { buildZip, type ZipEntry } from "@/lib/pbn/zip";
import { residualFootprints } from "@/lib/pbn/clean";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

async function walk(dir: string, root: string, out: { rel: string; full: string }[]): Promise<void> {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, root, out);
    else out.push({ rel: path.relative(root, full).split(path.sep).join("/"), full });
  }
}

/** GET — ZIP восстановленного сайта с запечёнными при экспорте ссылками + бот-щит + robots. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const site = await getSite(userId, id);
  if (!site?.diskPath) return new Response("not found", { status: 404 });

  const root = path.resolve(site.diskPath);
  const files: { rel: string; full: string }[] = [];
  try { await walk(root, root, files); } catch { return new Response("nothing to export", { status: 404 }); }
  if (!files.length) return new Response("empty", { status: 404 });

  const links = (await listLinks(id)) as unknown as RenderLink[];
  const entries: ZipEntry[] = [];
  for (const f of files) {
    let data = await fs.readFile(f.full);
    if (/\.html?$/i.test(f.rel)) {
      const pageRel = "/" + f.rel.replace(/index\.html$/i, "").replace(/\/$/, "");
      const forPage = links.filter(l => l.status === "placed" && (l.pagePath === pageRel || l.pagePath === "*" || (f.rel === "index.html" && l.pagePath === "/")));
      const rendered = renderPage(data.toString("utf8"), forPage);
      const found = residualFootprints(rendered);
      if (found.length) return new Response(`footprint in ${f.rel}: ${found.join(", ")}`, { status: 409 });
      data = Buffer.from(rendered, "utf8");
    }
    entries.push({ path: f.rel, data });
  }
  entries.push({ path: ".htaccess", data: Buffer.from("RewriteEngine On\nRewriteCond %{HTTP_USER_AGENT} (AhrefsBot|SemrushBot|MJ12bot|DotBot|rogerbot|BLEXBot) [NC]\nRewriteRule .* - [F,L]\n", "utf8") });
  entries.push({ path: "robots.txt", data: Buffer.from("User-agent: AhrefsBot\nDisallow: /\nUser-agent: SemrushBot\nDisallow: /\nUser-agent: MJ12bot\nDisallow: /\n", "utf8") });

  const zip = buildZip(entries);
  return new Response(new Uint8Array(zip), { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${site.domain}.zip"` } });
}
