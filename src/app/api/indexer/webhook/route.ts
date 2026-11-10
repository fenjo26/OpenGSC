import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rawExec } from "@/lib/db/raw";
import { parseWebhookBody } from "@/lib/indexer/webhookInput";

// Valid bot types the doorway may report directly (kept in sync with the doorway script).
const VALID_BOT_TYPES = ["google", "bing", "yandex", "mailru", "ai", "other"];

// Helper to determine bot type from user agent.
// IMPORTANT: this list must stay in sync with the doorway script's detection (indexer/settings),
// otherwise crawls served by the doorway get mislabeled here (e.g. Google-InspectionTool → "redirect").
function getBotType(ua: string): string {
  const l = ua.toLowerCase();
  // Google crawler family (all variants the doorway treats as Google)
  if (
    l.includes("googlebot") || l.includes("google-inspectiontool") || l.includes("googleother") ||
    l.includes("storebot-google") || l.includes("google-site-verification") || l.includes("google-co")
  ) return "google";
  if (l.includes("bingbot") || l.includes("bingpreview") || l.includes("msnbot")) return "bing";
  if (l.includes("yandex")) return "yandex";
  if (l.includes("mail.ru") || l.includes("mailru")) return "mailru";
  // AI crawlers & LLM training/answer bots — checked before the generic "bot" catch-all
  // since many of these contain the substring "bot" (ClaudeBot, GPTBot, Applebot-Extended…).
  if (
    l.includes("gptbot") || l.includes("oai-searchbot") || l.includes("chatgpt-user") ||
    l.includes("claudebot") || l.includes("claude-user") || l.includes("anthropic-ai") ||
    l.includes("perplexitybot") || l.includes("perplexity-user") ||
    l.includes("deepseekbot") || l.includes("deepseek") ||
    l.includes("bytespider") || l.includes("google-extended") ||
    l.includes("applebot-extended") || l.includes("ccbot") ||
    l.includes("meta-externalagent") || l.includes("meta-externalfetcher") ||
    l.includes("cohere-ai") || l.includes("cohere-training") ||
    l.includes("amazonbot") || l.includes("youbot") || l.includes("diffbot") ||
    l.includes("imagesift") || l.includes("timpibot") || l.includes("omgili")
  ) return "ai";
  if (l.includes("bot") || l.includes("crawler") || l.includes("spider")) return "other";
  return "redirect"; // Human user redirected
}

export async function POST(req: Request) {
  try {
    // Every field is type- and length-checked before it reaches a query: see webhookInput.ts for
    // why a non-string apiKey must never get as far as `findFirst`.
    const parsed = parseWebhookBody(await req.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const { apiKey, url, ip, userAgent, statusCode: code, referer, isRedirect, botType: reported } = parsed.value;

    // Find domain associated with this API key
    const domain = await prisma.indexerDomain.findFirst({
      where: { apiKey },
    });

    if (!domain) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    // Prefer the bot type the doorway already computed (newer scripts send it); else parse the UA.
    const botType = isRedirect
      ? "redirect"
      : (VALID_BOT_TYPES.includes(reported) ? reported : getBotType(userAgent));
    const dateStr = new Date().toISOString().split("T")[0];

    // 1. Increment pre-aggregated daily stat (fast O(1) upsert)
    const statId = `stat_${domain.id}_${dateStr}_${botType}_${code}`;
    await rawExec(
      `INSERT INTO "IndexerDailyStat" ("id", "domainId", "date", "botType", "statusCode", "count")
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT("domainId", "date", "botType", "statusCode")
       DO UPDATE SET "count" = "count" + 1`,
      statId,
      domain.id,
      dateStr,
      botType,
      code
    );

    // 2. Create raw log entry (for 7-day live inspection window)
    await prisma.indexerLog.create({
      data: {
        domainId: domain.id,
        url,
        ip,
        userAgent,
        botType,
        statusCode: code,
        referer,
      },
    });

    // 3. Periodic log retention purge (~1% of requests) to keep raw logs clean (capped at 5,000 rows)
    if (Math.random() < 0.01) {
      rawExec(`DELETE FROM "IndexerLog" WHERE "id" NOT IN (SELECT "id" FROM "IndexerLog" ORDER BY "timestamp" DESC LIMIT 5000)`).catch(() => {});
    }

    // Update pages and subdomains counts on the domain dynamically
    // A page is logged, let's simulate the page counts growth
    const isNewPage = Math.random() > 0.7; // Simulate page growth
    const isNewSubdomain = url.includes(".") && Math.random() > 0.85;

    await prisma.indexerDomain.update({
      where: { id: domain.id },
      data: {
        pagesCount: { increment: isNewPage ? 1 : 0 },
        subdomainsCount: { increment: isNewSubdomain ? 1 : 0 },
      },
    });

    // ─── Feed money-site URLs from the crawl queue back to the doorway ───
    // The doorway injects these as links into the page it serves the crawler, so queued
    // money-site pages actually get discovered/indexed. Only for real 200 bot serves —
    // a 304/403/redirect renders no HTML, so there is nothing to inject into.
    let links: string[] = [];
    const isServedBot = !isRedirect && botType !== "redirect" && code === 200;

    if (isServedBot) {
      // Rotate fairly: never-served (crawledAt NULL) first, then least-recently-served,
      // so every queued URL keeps getting link exposure across crawls.
      const queued = await prisma.indexerQueue.findMany({
        where: { domainId: domain.id },
        orderBy: [{ crawledAt: "asc" }, { createdAt: "asc" }],
        take: 5,
        select: { id: true, url: true },
      });

      links = queued.map(q => q.url);

      if (queued.length > 0) {
        await prisma.indexerQueue.updateMany({
          where: { id: { in: queued.map(q => q.id) } },
          data: { status: "crawled", crawledAt: new Date() },
        });
      }
    }

    return NextResponse.json({ success: true, links });
  } catch (e) {
    console.error("[Indexer Webhook Error]", e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
