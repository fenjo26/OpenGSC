import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { verifyAuthOrShare } from '@/lib/authShare';
import { fetchLLM } from '@/lib/llm';

// This route used to carry its own copy of the multi-provider LLM client — one of four in the
// codebase. The copies aged apart: this one was still asking for `gpt-4o-mini`,
// `gemini-1.5-flash`, `claude-3.5-haiku` and `glm-4.5-air` long after lib/llm.ts had moved on,
// and nothing failed, because stale model ids keep resolving. It also knew four providers where
// the shared client knows nine, and had no retry, so a routine 429 silently became "no brand
// terms found". Deleting it in favour of `fetchLLM` fixes all of that at once.

// GET /api/gsc/branded?siteId=  — returns saved keywords (+ AI suggest if ?suggest=1&aiProvider=&aiApiKey=)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const siteId   = searchParams.get('siteId') ?? '';
  const suggest  = searchParams.get('suggest') === '1';
  const provider = searchParams.get('aiProvider') ?? 'anthropic';
  const apiKey   = searchParams.get('aiApiKey') ?? '';
  // Chosen by the caller from the `utility` task (lib/seo/aiTasks.ts). Absent = provider default.
  const model    = searchParams.get('aiModel') ?? '';
  const baseUrl  = searchParams.get('aiBaseUrl') ?? '';

  const auth = await verifyAuthOrShare(req, siteId, false);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { userId, site } = auth;

  // Return saved keywords if not asking for suggestions
  if (!suggest) {
    const saved = site.brandedKeywords ? JSON.parse(site.brandedKeywords) as string[] : [];
    return NextResponse.json({ branded: saved, saved: true });
  }

  // AI suggestion mode
  const domainBrand = site.siteId
    .replace(/^https?:\/\//, '')
    .replace(/^sc-domain:/, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('.')[0]
    .toLowerCase();

  // Use AI if key provided
  if (apiKey) {
    // Get top queries from last 90 days from GSC accounts
    const accounts = await prisma.account.findMany({
      where: { userId, provider: 'google' },
      select: { id: true, access_token: true, refresh_token: true, expires_at: true },
    });

    const { google } = await import('googleapis');
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const end = new Date(); end.setDate(end.getDate() - 2);
    const startStr = since.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    let queryRows: any[] = [];
    for (const account of accounts) {
      try {
        const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        oauth2.setCredentials({ access_token: account.access_token, refresh_token: account.refresh_token });
        const wm = google.webmasters({ version: 'v3', auth: oauth2 });
        const res = await wm.searchanalytics.query({
          siteUrl: site.siteId,
          requestBody: { startDate: startStr, endDate: endStr, dimensions: ['query'], rowLimit: 100, dataState: 'all' },
        });
        queryRows = res.data.rows ?? [];
        break;
      } catch { continue; }
    }

    const queries = queryRows.map(r => r.keys?.[0] ?? '').filter(Boolean);

    if (queries.length > 0) {
      const prompt = `You are an SEO expert. The website domain is "${domainBrand}".

Identify brand terms from these search queries (brand name, company name, branded product names):

${queries.slice(0, 80).map(q => `"${q}"`).join('\n')}

Return ONLY a JSON array of brand terms (lowercase, max 10), no explanation:
["brand1", "brand2"]

If no clear brand terms found, return: ["${domainBrand}"]`;

      const text = await fetchLLM(prompt, provider, apiKey, 512, model || undefined, baseUrl || undefined);
      if (text) {
        const match = text.match(/\[[\s\S]*?\]/);
        if (match) {
          try {
            const branded = JSON.parse(match[0]) as string[];
            const unique = [...new Set([domainBrand, ...branded.map((b: string) => b.toLowerCase())])].slice(0, 15);
            return NextResponse.json({ branded: unique, aiGenerated: true });
          } catch {}
        }
      }
    }
  }

  return NextResponse.json({ branded: [domainBrand], aiGenerated: false });
}

// POST /api/gsc/branded — save branded keywords for a site
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { siteId, keywords } = body as { siteId: string; keywords: string[] };

  const site = await prisma.site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.site.update({
    where: { id: siteId },
    data: { brandedKeywords: JSON.stringify(keywords) },
  });

  return NextResponse.json({ ok: true });
}
