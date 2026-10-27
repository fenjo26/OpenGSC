/**
 * One access-log line → its fields. Nginx/Apache "combined" and "common", with or without a
 * leading virtual host ("vhost_combined": `host:port ip - - [...]`). Liberal by design: a line
 * that does not parse returns null and is counted as skipped by the caller — a log import never
 * fails on a bad line.
 *
 * Pure. The timestamp parser is shared with the drops crawl-log contour.
 */
import { parseCrawlTimestamp } from "@/lib/drops/crawlLog";

export interface AccessLine {
  ip: string;
  time: Date;
  method: string;
  /** Request target as logged: path + query, never a full URL (a full URL is reduced to it). */
  path: string;
  status: number;
  /** Combined format only; null in common format. */
  ua: string | null;
  /** vhost_combined only. */
  host: string | null;
}

// A quoted field with nginx's two escape styles (`\"` and `\x22`) tolerated inside.
const QUOTED_RE = /"((?:[^"\\]|\\.)*)"/g;
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]+)$/i;

export function parseAccessLine(raw: string): AccessLine | null {
  const line = raw.trim();
  if (!line) return null;
  const bracket = /\[([^\]]*)\]/.exec(line);
  if (!bracket || bracket.index === undefined) return null;
  const time = parseCrawlTimestamp(bracket[1]);
  if (!time) return null;

  const prefix = line.slice(0, bracket.index).trim().split(/\s+/);
  let host: string | null = null;
  let ip = prefix[0] ?? "";
  if (!IP_RE.test(ip) && prefix[1] && IP_RE.test(prefix[1])) {
    host = ip.replace(/:\d+$/, "").toLowerCase();
    ip = prefix[1];
  }
  if (!IP_RE.test(ip)) return null;

  const after = line.slice(bracket.index + bracket[0].length);
  const quotes = [...after.matchAll(QUOTED_RE)].map(q => ({ start: q.index ?? 0, end: (q.index ?? 0) + q[0].length, value: q[1] }));
  if (!quotes.length) return null;
  const request = quotes[0].value.split(" ");
  if (request.length < 2) return null;
  const method = request[0].toUpperCase();
  let path = request[1];
  if (/^https?:\/\//i.test(path)) {
    try { const u = new URL(path); path = u.pathname + u.search; } catch { return null; }
  }
  if (!path.startsWith("/")) return null;
  const statusMatch = /^\s+(\d{3})\b/.exec(after.slice(quotes[0].end));
  if (!statusMatch) return null;
  const status = +statusMatch[1];
  // Combined: "request" status bytes "referer" "ua" — the user agent is the last quoted field.
  const ua = quotes.length >= 3 ? quotes[quotes.length - 1].value : null;
  return { ip, time, method, path, status, ua, host };
}
