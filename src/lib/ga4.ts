import { google } from 'googleapis';
import { prisma } from '@/lib/prisma';

export type GoogleAccount = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
};

// Build an authenticated OAuth2 client for a linked Google account.
// Mirrors the pattern used by the GSC routes, including auto-saving
// refreshed tokens back to the DB.
export function makeOAuth2(account: GoogleAccount) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });
  oauth2.on('tokens', async (tokens) => {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokens.access_token ?? account.access_token,
        refresh_token: tokens.refresh_token ?? account.refresh_token,
        expires_at: tokens.expiry_date
          ? Math.floor(tokens.expiry_date / 1000)
          : account.expires_at,
      },
    });
  });
  return oauth2;
}

// GA4 metrics we surface in the dashboard, in API order.
export const GA4_API_METRICS = [
  'sessions',
  'engagementRate',
  'keyEvents',
  'totalRevenue',
] as const;

// Number of days a period key represents. Kept in sync with the GSC routes.
export function periodToDays(period: string): number {
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

export function ymd(d: Date): string {
  return d.toISOString().split('T')[0];
}

// Build current + previous date windows for a period. `daysOverride` carries a custom GSC
// window in (the site page forwards its manually-picked range as ?days=N) — GA4 only needs
// the length, not the exact dates.
export function dateWindows(period: string, daysOverride?: number | null) {
  const days = daysOverride && daysOverride >= 1 ? daysOverride : periodToDays(period);
  const end = new Date();
  // GA4 includes today, but the current day is always partial — end yesterday
  // so deltas compare like-for-like complete days.
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(end.getDate() - days + 1);

  const prevEnd = new Date(start);
  prevEnd.setDate(start.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevEnd.getDate() - days + 1);

  return {
    days,
    start: ymd(start),
    end: ymd(end),
    prevStart: ymd(prevStart),
    prevEnd: ymd(prevEnd),
  };
}

export function pct(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}
