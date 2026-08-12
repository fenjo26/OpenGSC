import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';
import { fetchLLM } from '@/lib/llm';

const LANG = new Set(['el','de','fr','ru','en','es','it','pl','nl','pt','tr','ar','zh','bg','ro','cs','sk','hr','sr','uk','hu']);

function humanizeSlug(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function makeOAuth2(account: { id: string; access_token: string | null; refresh_token: string | null; expires_at: number | null }) {
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });
  return oauth2;
}

async function queryGSC(
  accounts: { id: string; access_token: string | null; refresh_token: string | null; expires_at: number | null }[],
  siteUrl: string, startDate: string, endDate: string, dimension: string, rowLimit = 500
) {
  for (const account of accounts) {
    try {
      const oauth2 = makeOAuth2(account);
      const wm = google.webmasters({ version: 'v3', auth: oauth2 });
      const res = await wm.searchanalytics.query({
        siteUrl,
        requestBody: { startDate, endDate, dimensions: [dimension], rowLimit, dataState: 'all' },
      });
      return res.data.rows ?? [];
    } catch { continue; }
  }
  return [];
}

// ─── AI clustering via LLMs ───────────────────────────────────────────────
//
// This route used to carry its own copy of the multi-provider LLM client. It had drifted to
// `gpt-4o-mini`, `gemini-1.5-flash`, `claude-3.5-haiku` and `glm-4.5-air` — ids that still
// resolve, so nothing ever failed loudly — and it knew four providers where lib/llm.ts knows
// nine, with no retry: a routine 429 turned into "AI clustering unavailable, using the
// algorithmic fallback", silently and on the user's paid key.
//
// `askJson` is what is actually specific to this route: an env-key fallback for unattended
// setup, and pulling the first JSON object out of the reply.
type AiCreds = { provider?: string; apiKey?: string; model?: string; baseUrl?: string };

async function askJson(prompt: string, ai: AiCreds, maxTokens = 2048): Promise<any> {
  const provider = ai.provider || 'anthropic';
  // One-Click Setup can run before any key is stored in the browser, so a server-side env key is
  // still an accepted source here — unlike the SEO tools, which are strictly bring-your-own.
  const apiKey = ai.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) { console.log('[Setup/LLM] No API key — using algorithmic fallback'); return null; }

  const text = await fetchLLM(prompt, provider, apiKey, maxTokens, ai.model || undefined, ai.baseUrl || undefined);
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function aiClusterQueries(queries: { label: string; impr: number }[], ai: AiCreds) {
  if (queries.length === 0) return null;

  // Take top 200 by impressions for the prompt
  const top = queries.sort((a, b) => b.impr - a.impr).slice(0, 200);
  const queryList = top.map(q => `"${q.label}" [${q.impr} impr]`).join('\n');

  const prompt = `You are an SEO expert. Group these search queries into thematic topic clusters for SEO analysis.

Queries:
${queryList}

Return ONLY valid JSON, no explanation:
{
  "clusters": [
    {
      "name": "Cluster Name (English, max 5 words, descriptive)",
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}

Rules:
- Create 6-14 clusters based on actual themes in the data
- Each cluster name should clearly describe the topic
- "keywords" should be the most representative 2-4 word phrases for that cluster (used for matching)
- Cover all major query groups, merge very small ones
- Respond with JSON only`;

  const parsed = await askJson(prompt, ai);
  if (!parsed) return null;

  return (parsed.clusters ?? []).map((c: any) => ({
    name: c.name,
    values: c.keywords ?? [],
    count: queries.filter(q => (c.keywords ?? []).some((kw: string) => q.label.toLowerCase().includes(kw.toLowerCase()))).length,
  }));
}

async function aiGroupPages(pages: { label: string; impr: number }[], domain: string, ai: AiCreds) {
  if (pages.length === 0) return null;

  const top = pages.sort((a, b) => b.impr - a.impr).slice(0, 150);
  const pageList = top.map(p => p.label).join('\n');

  const prompt = `You are an SEO expert. Group these URLs into content groups for a website (${domain}).

URLs:
${pageList}

Return ONLY valid JSON, no explanation:
{
  "groups": [
    {
      "name": "Group Name (English, max 4 words)",
      "pattern": "/path-fragment",
      "type": "contains"
    }
  ]
}

Rules:
- Create 5-12 groups based on URL structure and content type
- Homepage: use type "equals" with the full URL
- Other groups: use type "contains" with a URL fragment that uniquely identifies the group
- "pattern" should be a short URL fragment (e.g. "/blog", "/airport-to-chalkidiki", "/prices")
- Group by service type, destination, content category etc.
- Respond with JSON only`;

  const parsed = await askJson(prompt, ai);
  if (!parsed) return null;

  return (parsed.groups ?? []).map((g: any) => ({
    name: g.name,
    values: [g.pattern],
    isEquals: g.type === 'equals',
    count: pages.filter(p => g.type === 'equals' ? p.label === g.pattern : p.label.includes(g.pattern)).length,
  }));
}

// ─── Algorithmic fallback ─────────────────────────────────────────────────────
const STOP = new Set(['the','a','an','to','from','in','at','for','with','how','what','where','when','near','me','my','on','of','by','is','are','and','or','but','not','no','best','top','cheap','good','great','new','old','get','all','this','that','its','i','you','we','they','he','she','it','can','do','did','does','will','was','were','be','been','being','have','has','had','vs','per']);

function algorithmicCluster(rows: { label: string; impr: number }[]) {
  const queries = rows.map(r => ({
    ...r,
    words: r.label.toLowerCase().split(/[\s,.()/]+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 3 && !STOP.has(w)),
  }));
  const wordImpr = new Map<string, number>();
  for (const q of queries) for (const w of q.words) wordImpr.set(w, (wordImpr.get(w) ?? 0) + q.impr);
  const seeds = [...wordImpr.entries()].filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).slice(0,14).map(([w]) => w);
  const clusters: { name: string; values: string[]; count: number }[] = [];
  const assigned = new Set<number>();
  for (const seed of seeds) {
    const matching = queries.map((q,i) => ({q,i})).filter(({q,i}) => !assigned.has(i) && q.words.includes(seed));
    if (matching.length < 2) continue;
    matching.forEach(({i}) => assigned.add(i));
    clusters.push({ name: humanizeSlug(seed), values: matching.sort((a,b) => b.q.impr-a.q.impr).slice(0,30).map(({q}) => q.label), count: matching.length });
  }
  const others = queries.filter((_,i) => !assigned.has(i));
  if (others.length >= 3) clusters.push({ name: 'Other Queries', values: others.slice(0,20).map(q=>q.label), count: others.length });
  return clusters.slice(0, 15);
}

function algorithmicGroupPages(rows: { label: string; impr: number }[], domain: string) {
  const pages = rows.map(r => {
    const path = r.label.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').replace(/\/$/, '') || '/';
    const segs = path.split('/').filter(Boolean);
    const meaningful = segs.filter(s => !LANG.has(s.toLowerCase()));
    const seg = meaningful[0] || segs[0] || '';
    return { ...r, seg: seg.toLowerCase() };
  });
  const home = pages.filter(p => p.seg === '');
  const rest = pages.filter(p => p.seg !== '');
  const segMap = new Map<string, typeof rest>();
  for (const p of rest) { if (!segMap.has(p.seg)) segMap.set(p.seg, []); segMap.get(p.seg)!.push(p); }
  const groups: { name: string; values: string[]; count: number; isEquals?: boolean }[] = [];
  if (home.length > 0) groups.push({ name: 'Homepage', values: home.map(p => p.label), count: home.length, isEquals: true });
  [...segMap.entries()].map(([seg,ps]) => ({ seg, ps, impr: ps.reduce((s,p) => s+p.impr,0) }))
    .sort((a,b) => b.impr-a.impr).slice(0,14)
    .forEach(({ seg, ps }) => groups.push({ name: humanizeSlug(seg), values: [`/${seg}`], count: ps.length }));
  return groups;
}

// ─── POST /api/gsc/setup ──────────────────────────────────────────────────────
export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const dbSiteId: string = body.siteId;

  const site = await prisma.site.findFirst({ where: { id: dbSiteId, userId } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const accounts = await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });

  const end = new Date(); end.setDate(end.getDate() - 2);
  const start = new Date(end); start.setDate(end.getDate() - 89);
  const endStr   = end.toISOString().split('T')[0];
  const startStr = start.toISOString().split('T')[0];

  const [queryRows, pageRows] = await Promise.all([
    queryGSC(accounts, site.siteId, startStr, endStr, 'query', 500),
    queryGSC(accounts, site.siteId, startStr, endStr, 'page',  500),
  ]);

  const queries = queryRows.map(r => ({ label: r.keys?.[0] ?? '', impr: r.impressions ?? 0 }));
  const pages   = pageRows.map(r =>  ({ label: r.keys?.[0] ?? '', impr: r.impressions ?? 0 }));

  // Try AI first, fall back to algorithmic
  // model/baseUrl come from the caller's `utility` task setting (lib/seo/aiTasks.ts); absent
  // means "provider default", which lib/providerDefaults.ts answers in one place.
  const ai = {
    provider: body.aiProvider as string | undefined,
    apiKey: body.aiApiKey as string | undefined,
    model: body.aiModel as string | undefined,
    baseUrl: body.aiBaseUrl as string | undefined,
  };
  const hasApiKey = !!ai.apiKey || !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY;

  const [aiClusters, aiGroups] = await Promise.all([
    aiClusterQueries(queries, ai),
    aiGroupPages(pages, site.url, ai),
  ]);

  const clusterDefs = aiClusters ?? algorithmicCluster(queries);
  const groupDefs   = aiGroups   ?? algorithmicGroupPages(pages, site.url);

  const clusters = clusterDefs.map((c: any) => ({
    name:  c.name,
    rules: JSON.stringify([{ type: 'contains', values: c.values }]),
    count: c.count,
    aiGenerated: !!aiClusters,
  }));

  const groups = groupDefs.map((g: any) => ({
    name:  g.name,
    rules: JSON.stringify([{ type: (g as any).isEquals ? 'equals' : 'contains', values: (g as any).values }]),
    count: g.count,
    aiGenerated: !!aiGroups,
  }));

  return NextResponse.json({ clusters, groups, hasApiKey });
}
