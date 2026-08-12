import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { safeFetch } from "@/lib/security/safeFetch";
import { assessLastmodReliability, contentFingerprint, extractContentTitle } from "@/lib/sitemap/metadata";

const MAX_URLS = 50;
const CONCURRENCY = 3;

// POST { siteDbId, urls? } — explicit, bounded page metadata verification. No page content is kept.
export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteDbId = String(body.siteDbId ?? "").trim();
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const requested: string[] = Array.isArray(body.urls)
    ? [...new Set<string>((body.urls as unknown[]).map(value => String(value).trim()).filter(Boolean))].slice(0, MAX_URLS)
    : [];
  const rows = await prisma.sitemapUrl.findMany({
    where: {
      siteId: siteDbId,
      inventoryStatus: { not: "missing" },
      ...(requested.length ? { url: { in: requested } } : {}),
    },
    orderBy: [{ contentCheckedAt: "asc" }, { lastSeenAt: "desc" }],
    take: MAX_URLS,
    select: {
      id: true, url: true, lastmod: true, contentHash: true, contentLastmod: true,
      lastmodReliability: true,
    },
  });
  if (!rows.length) return NextResponse.json({ ok: true, checked: 0, errors: 0, suspicious: 0 });

  let cursor = 0;
  let checked = 0;
  let errors = 0;
  let suspicious = 0;
  const failureExamples: Array<{ url: string; error: string }> = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const response = await safeFetch(row.url, {
          timeoutMs: 20_000,
          maxBytes: 2 * 1024 * 1024,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; OpenGSC-Sitemap/1.0; +https://opengsc.org)",
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.5,*/*;q=0.1",
          },
        });
        if (!response.ok) {
          errors++;
          if (failureExamples.length < 10) failureExamples.push({ url: row.url, error: `HTTP ${response.status}` });
          await prisma.sitemapUrl.update({
            where: { id: row.id },
            data: { contentCheckedAt: new Date(), contentHttpStatus: response.status },
          });
          continue;
        }
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
        const content = await response.text();
        const hash = contentFingerprint(content, contentType);
        const reliability = assessLastmodReliability({
          previousHash: row.contentHash,
          currentHash: hash,
          previousLastmod: row.contentLastmod,
          currentLastmod: row.lastmod,
          previousReliability: row.lastmodReliability,
        });
        if (reliability === "suspicious") suspicious++;
        await prisma.sitemapUrl.update({
          where: { id: row.id },
          data: {
            contentHash: hash,
            contentType,
            contentHttpStatus: response.status,
            contentTitle: /html|xml/i.test(contentType) ? extractContentTitle(content) : null,
            contentCheckedAt: new Date(),
            contentLastmod: row.lastmod,
            lastmodReliability: reliability,
          },
        });
        checked++;
      } catch (error) {
        errors++;
        if (failureExamples.length < 10) {
          failureExamples.push({ url: row.url, error: String(error instanceof Error ? error.message : error).slice(0, 180) });
        }
        await prisma.sitemapUrl.update({
          where: { id: row.id },
          data: { contentCheckedAt: new Date(), contentHttpStatus: 0 },
        }).catch(() => {});
      }
    }
  });
  await Promise.all(workers);

  await prisma.indexingOperation.create({
    data: {
      siteId: siteDbId,
      type: "sitemap_metadata",
      result: errors ? (checked ? "partial" : "error") : "success",
      urlCount: checked,
      detail: JSON.stringify({ checked, errors, suspicious, failures: failureExamples }),
    },
  });
  return NextResponse.json({ ok: errors === 0, checked, errors, suspicious, failures: failureExamples });
}
