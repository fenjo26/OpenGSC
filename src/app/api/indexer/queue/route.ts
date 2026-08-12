import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { safeFetch } from "@/lib/security/safeFetch";

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Server-side pagination — the queue can hold thousands of URLs, so never ship them all.
    const sp = new URL(req.url).searchParams;
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(sp.get("pageSize") || "15", 10) || 15));
    const where = { domain: { userId } };

    const [items, total, crawled] = await Promise.all([
      prisma.indexerQueue.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { domain: { select: { domain: true } } },
      }),
      prisma.indexerQueue.count({ where }),
      prisma.indexerQueue.count({ where: { ...where, status: "crawled" } }),
    ]);

    return NextResponse.json({ items, total, crawled, page, pageSize });
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// ── Helper: fetch and parse sitemap.xml, returning all <loc> URLs ──
async function parseSitemapUrls(sitemapUrl: string, depth = 0, seen = new Set<string>()): Promise<string[]> {
  if (depth > 3 || seen.has(sitemapUrl) || seen.size >= 200) return [];
  seen.add(sitemapUrl);
  try {
    const res = await safeFetch(sitemapUrl, {
      headers: { "User-Agent": "OpenGSC-Indexer/1.0" },
      timeoutMs: 15_000,
      maxBytes: 10 * 1024 * 1024,
    });
    if (!res.ok) return [];
    const xml = await res.text();

    const urls: string[] = [];
    // Extract all <loc>...</loc> entries
    const locMatches = xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi);
    for (const m of locMatches) {
      const loc = m[1].trim();
      if (!loc) continue;
      // If it's a nested sitemap (sitemap index), recursively parse it
      if (loc.endsWith(".xml") || loc.includes("sitemap")) {
        const nested = await parseSitemapUrls(loc, depth + 1, seen);
        urls.push(...nested);
        if (urls.length >= 20_000) break;
      } else {
        urls.push(loc);
      }
    }
    return urls.slice(0, 20_000);
  } catch {
    return [];
  }
}

// ── Helper: check if a URL looks like a sitemap ──
function isSitemapUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".xml") || lower.includes("sitemap");
}

// ── Helper: push URLs to IndexNow (Bing, Yandex, Seznam…) ──
// Independent of the doorway network: this submits the money-site URLs directly to the
// engines. Grouped per host because IndexNow accepts one host per request.
async function submitToIndexNow(
  urls: string[],
  key: string,
): Promise<{ submitted: number; hosts: number; errors: string[] }> {
  const byHost = new Map<string, string[]>();
  for (const u of urls) {
    try {
      const host = new URL(u).host;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host)!.push(u);
    } catch { /* skip malformed URLs */ }
  }

  let submitted = 0;
  const errors: string[] = [];

  for (const [host, hostUrls] of byHost) {
    // IndexNow caps a single submission at 10 000 URLs
    for (let i = 0; i < hostUrls.length; i += 10000) {
      const batch = hostUrls.slice(i, i + 10000);
      try {
        const res = await fetch("https://api.indexnow.org/indexnow", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            host,
            key,
            keyLocation: `https://${host}/${key}.txt`,
            urlList: batch,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 200 || res.status === 202) {
          submitted += batch.length;
        } else {
          errors.push(`${host}: HTTP ${res.status}`);
        }
      } catch (e: any) {
        errors.push(`${host}: ${e?.message ?? "request failed"}`);
      }
    }
  }

  return { submitted, hosts: byHost.size, errors };
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("spend");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { domainId, urls, indexNowKey } = body; // urls is a string or array

    if (!urls) {
      return NextResponse.json({ error: "URLs are required" }, { status: 400 });
    }

    // Build the list of target doorway domains
    let targetDomains: { id: string }[];

    if (domainId === "all" || !domainId) {
      // Auto-distribute: get ALL user's doorway domains
      targetDomains = await prisma.indexerDomain.findMany({
        where: { userId },
        select: { id: true },
      });
      if (targetDomains.length === 0) {
        return NextResponse.json({ error: "No doorway domains found. Add domains first." }, { status: 400 });
      }
    } else {
      // Specific domain selected — verify ownership
      const domain = await prisma.indexerDomain.findFirst({
        where: { id: domainId, userId },
      });
      if (!domain) {
        return NextResponse.json({ error: "Domain not found" }, { status: 404 });
      }
      targetDomains = [{ id: domain.id }];
    }

    // Parse input URLs
    let rawUrlList = Array.isArray(urls) 
      ? urls 
      : urls.split("\n").map((u: string) => u.trim()).filter((u: string) => u.length > 0);

    if (rawUrlList.length === 0) {
      return NextResponse.json({ error: "No URLs provided" }, { status: 400 });
    }

    // Expand sitemap URLs into individual page URLs
    const expandedUrls: string[] = [];
    for (const rawUrl of rawUrlList) {
      let normalizedUrl = rawUrl;
      if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
        normalizedUrl = `https://${normalizedUrl}`;
      }

      if (isSitemapUrl(normalizedUrl)) {
        const sitemapUrls = await parseSitemapUrls(normalizedUrl);
        expandedUrls.push(...sitemapUrls);
      } else {
        expandedUrls.push(normalizedUrl);
      }
    }

    if (expandedUrls.length === 0) {
      return NextResponse.json({ error: "No URLs found (sitemap may be empty or unreachable)" }, { status: 400 });
    }

    // Distribute URLs across target domains (round-robin)
    let created = 0;
    for (let i = 0; i < expandedUrls.length; i++) {
      const url = expandedUrls[i];
      const targetDomain = targetDomains[i % targetDomains.length];

      try {
        await prisma.indexerQueue.create({
          data: {
            domainId: targetDomain.id,
            url,
            status: "pending",
          },
        });
        created++;
      } catch {
        // Ignore duplicates (@@unique constraint)
      }
    }

    // Push the same URLs straight to IndexNow (Bing/Yandex) — instant, engine-official
    // indexation that does not depend on a crawler finding the doorway network.
    let indexNow: { submitted: number; hosts: number; errors: string[] } | null = null;
    if (typeof indexNowKey === "string" && indexNowKey.trim().length > 0) {
      indexNow = await submitToIndexNow(expandedUrls, indexNowKey.trim());
    }

    return NextResponse.json({
      success: true,
      count: created,
      totalUrls: expandedUrls.length,
      domainsUsed: targetDomains.length,
      indexNow,
    });
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Clear the queue for the user's domains.
    // ?status=crawled removes only URLs already shown to crawlers, keeping pending ones.
    const status = new URL(req.url).searchParams.get("status");

    const domains = await prisma.indexerDomain.findMany({
      where: { userId },
      select: { id: true },
    });

    const domainIds = domains.map(d => d.id);

    const result = await prisma.indexerQueue.deleteMany({
      where: {
        domainId: { in: domainIds },
        ...(status ? { status: status.toLowerCase() } : {}),
      },
    });

    return NextResponse.json({ success: true, deleted: result.count });
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
