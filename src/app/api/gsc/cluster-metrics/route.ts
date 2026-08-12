import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { google } from 'googleapis';
import { verifyAuthOrShare } from '@/lib/authShare';

function periodToDays(period: string): number {
  const today = new Date();
  const map: Record<string, number> = {
    yesterday: 1,
    '7d': 7, '14d': 14, '28d': 28,
    last_week: 7,
    this_month: today.getDate(),
    last_month: new Date(today.getFullYear(), today.getMonth(), 0).getDate(),
    this_quarter: 90, last_quarter: 90,
    ytd: Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 1).getTime()) / 86400000),
    '3m': 90, '6m': 180, '8m': 240, '12m': 365, '16m': 480, '2y': 730, '3y': 1095,
  };
  return map[period] ?? 28;
}

function pct(curr: number, prev: number) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

function makeOAuth2(account: { id: string; access_token: string | null; refresh_token: string | null; expires_at: number | null }) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
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

// ─── Match a string against a rule set ───────────────────────────────────────
type Rule = { type: 'contains' | 'equals' | 'startsWith'; values: string[] };

function matches(str: string, rules: Rule[]): boolean {
  const s = str.toLowerCase();
  return rules.some(rule =>
    rule.values.some(v => {
      const val = v.toLowerCase();
      if (rule.type === 'equals')     return s === val;
      if (rule.type === 'startsWith') return s.startsWith(val);
      return s.includes(val);          // contains
    })
  );
}

// ─── Aggregate GSC rows by cluster/group patterns ────────────────────────────
function aggregate(
  currRows: { label: string; clicks: number; impr: number; ctr: number; pos: number }[],
  prevRows: { label: string; clicks: number; impr: number; ctr: number; pos: number }[],
  defs: { id: string; name: string; rules: Rule[] }[]
) {
  return defs.map(def => {
    const curr = currRows.filter(r => matches(r.label, def.rules));
    const prev = prevRows.filter(r => matches(r.label, def.rules));

    const sumC = curr.reduce((a, r) => ({ clicks: a.clicks + r.clicks, impr: a.impr + r.impr, ctr: a.ctr + r.ctr, pos: a.pos + r.pos, n: a.n + 1 }), { clicks: 0, impr: 0, ctr: 0, pos: 0, n: 0 });
    const sumP = prev.reduce((a, r) => ({ clicks: a.clicks + r.clicks, impr: a.impr + r.impr, ctr: a.ctr + r.ctr, pos: a.pos + r.pos, n: a.n + 1 }), { clicks: 0, impr: 0, ctr: 0, pos: 0, n: 0 });

    const avgCtr = (s: typeof sumC) => s.n > 0 ? +((s.ctr / s.n) * 100).toFixed(1) : 0;
    const avgPos = (s: typeof sumC) => s.n > 0 ? +(s.pos / s.n).toFixed(1) : 0;

    return {
      id:          def.id,
      name:        def.name,
      clicks:      sumC.clicks,
      impressions: sumC.impr,
      ctr:         avgCtr(sumC),
      position:    avgPos(sumC),
      clicksChange:      pct(sumC.clicks, sumP.clicks),
      impressionsChange: pct(sumC.impr,   sumP.impr),
      ctrChange:         pct(avgCtr(sumC), avgCtr(sumP)),
      positionChange:    pct(avgPos(sumC), avgPos(sumP)),
    };
  });
}

// ─── GET /api/gsc/cluster-metrics?siteId=&period= ────────────────────────────
export async function GET(req: Request) {
 try {
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('siteId') || '';

  const auth = await verifyAuthOrShare(req, siteId, false);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { userId, site } = auth;
  const period = searchParams.get('period') ?? '28d';

  const [clusterDefs, groupDefs] = await Promise.all([
    (prisma as any).topicCluster.findMany({ where: { siteId }, orderBy: { createdAt: 'asc' } }),
    prisma.contentGroup.findMany({ where: { siteId }, orderBy: { createdAt: 'asc' } }),
  ]);

  if (clusterDefs.length === 0 && groupDefs.length === 0) {
    return NextResponse.json({ clusters: [], groups: [] });
  }

  // Date windows
  const days = periodToDays(period);
  const endDate = new Date(); endDate.setDate(endDate.getDate() - 2);
  const startDate = new Date(endDate); startDate.setDate(endDate.getDate() - days + 1);
  const prevEnd = new Date(startDate); prevEnd.setDate(startDate.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevEnd.getDate() - days + 1);

  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const accounts = await prisma.account.findMany({
    where: { userId, provider: 'google' },
    select: { id: true, access_token: true, refresh_token: true, expires_at: true },
  });

  // Fetch live GSC data for both periods
  const [currQ, prevQ, currP, prevP] = await Promise.all([
    clusterDefs.length > 0 ? queryGSC(accounts, site.siteId, fmt(startDate), fmt(endDate), 'query', 500) : Promise.resolve([]),
    clusterDefs.length > 0 ? queryGSC(accounts, site.siteId, fmt(prevStart), fmt(prevEnd),  'query', 500) : Promise.resolve([]),
    groupDefs.length   > 0 ? queryGSC(accounts, site.siteId, fmt(startDate), fmt(endDate), 'page',  500) : Promise.resolve([]),
    groupDefs.length   > 0 ? queryGSC(accounts, site.siteId, fmt(prevStart), fmt(prevEnd),  'page',  500) : Promise.resolve([]),
  ]);

  const toRow = (r: any) => ({
    label:  r.keys?.[0] ?? '',
    clicks: r.clicks ?? 0,
    impr:   r.impressions ?? 0,
    ctr:    r.ctr ?? 0,
    pos:    r.position ?? 0,
  });

  const parseRules = (def: { rules: string }): Rule[] => {
    try { return JSON.parse(def.rules); } catch { return []; }
  };

  type Def = { id: string; name: string; rules: string };

  const clusters = aggregate(
    currQ.map(toRow), prevQ.map(toRow),
    (clusterDefs as Def[]).map(d => ({ id: d.id, name: d.name, rules: parseRules(d) }))
  );

  const groups = aggregate(
    currP.map(toRow), prevP.map(toRow),
    (groupDefs as Def[]).map(d => ({ id: d.id, name: d.name, rules: parseRules(d) }))
  );

  return NextResponse.json({ clusters, groups });
 } catch (e) {
  // Never 500 the dashboard over clusters (e.g. topicCluster table not migrated yet).
  console.error('[cluster-metrics]', e);
  return NextResponse.json({ clusters: [], groups: [] });
 }
}
