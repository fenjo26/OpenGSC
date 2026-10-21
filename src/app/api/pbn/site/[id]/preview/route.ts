import { workspaceUserId } from "@/lib/team/workspace";
import { getSite, listLinks } from "@/lib/pbn/store";
import { renderPage, type RenderLink } from "@/lib/pbn/restore";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/** GET ?path=/ — noindex-превью с ссылками, запечёнными ПРИ ОТДАЧЕ (файл на диске чистый). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("write");
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const site = await getSite(userId, id);
  if (!site?.diskPath) return new Response("not found", { status: 404 });

  const rel = (new URL(req.url).searchParams.get("path") || "/").split("?")[0];
  const root = path.resolve(site.diskPath);
  let p = rel.replace(/^\/+/, "");
  if (!p || rel.endsWith("/")) p = path.join(p, "index.html");
  else if (!/\.[a-z0-9]{1,6}$/i.test(p)) p = path.join(p, "index.html");
  const file = path.resolve(root, p);
  if (file !== root && !file.startsWith(root + path.sep)) return new Response("bad path", { status: 400 });

  try {
    const pristine = await fs.readFile(file, "utf8");
    const links = (await listLinks(id)) as unknown as RenderLink[];
    const forPage = links.filter(l => l.status === "placed" && (l.pagePath === rel || l.pagePath === "*" || (rel === "/" && l.pagePath === "/")));
    const html = renderPage(pristine, forPage);
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow, noarchive", "cache-control": "no-store" } });
  } catch {
    return new Response("page not found", { status: 404 });
  }
}
