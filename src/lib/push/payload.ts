// N10 — pure payload building for web push (docs/tasks/wave-nov/N10-pwa-push.md).
// No Prisma, no network: everything here is directly covered by node:test.

import type { NotifyEvent } from "@/lib/notify/types";
import { NOTIFY_EVENTS } from "@/lib/notify/types";

/** What goes over the wire as JSON and reaches sw.js's `push` handler. */
export interface PushPayload {
  title: string;
  body: string;   // ≤ 240 chars, no markdown
  url: string;    // screen to open on click
}

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 240;

/**
 * Flatten the markdown-ish text the notify stack produces (bold from notifyI18n, links
 * from digests) into notification plain text: `**x**`→x, `[t](u)`→t, `` `x` ``→x,
 * `#`/`##` headers stripped of their hashes, `* `/`- ` bullets kept as "- ".
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^(\s*)[*•]\s+/gm, "$1- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Cut on a character boundary so the string fits a byte budget (Cyrillic = 2 bytes/char). */
export function buildPushPayload(input: {
  title: string;
  text: string;
  event: NotifyEvent;
  /** Explicit target screen; without it the event decides (urlForEvent). */
  url?: string;
}): PushPayload {
  const title = cut(stripMarkdown(input.title || input.text.split("\n")[0] || ""), MAX_TITLE_CHARS);
  const flat = stripMarkdown(input.text);
  // When the title came from the text's first line, do not repeat it in the body.
  const withoutTitle = flat === title || flat.startsWith(`${title}\n`) ? flat.slice(title.length).trim() : flat;
  const body = withoutTitle || flat;
  return { title, body: cut(body, MAX_BODY_CHARS), url: input.url || urlForEvent(input.event) };
}

/**
 * The brief's URL map: a site alert opens that site's page, a lead opens /leads, everything
 * else the dashboard. The alert case needs a site id the notify text does not carry —
 * matchSiteDomain() finds it from the workspace's sites.
 */
export function urlForEvent(event: NotifyEvent): string {
  if (event === "lead") return "/leads";
  return "/";
}

/**
 * First workspace site whose domain is mentioned in the text (longest domain wins, so
 * "blog.example.com" is not stolen by "example.com"). Returns the site id for /site/<id>,
 * or null when no site matches — the caller then falls back to urlForEvent.
 */
export function matchSiteDomain(text: string, sites: { id: string; domain: string }[]): string | null {
  const haystack = text.toLowerCase();
  let best: { id: string; len: number } | null = null;
  for (const s of sites) {
    const domain = s.domain.toLowerCase().replace(/^www\./, "");
    if (!domain) continue;
    if (haystack.includes(domain) && (!best || domain.length > best.len)) best = { id: s.id, len: domain.length };
  }
  return best?.id ?? null;
}

/** Hostname of a URL-ish string ("https://a.b/x", "a.b/x", "sc-domain:a.b" → "a.b"), "" when unparseable. */
export function hostnameOf(raw: string): string {
  const cleaned = raw.trim().replace(/^sc-domain:/i, "").replace(/^([a-z]+:)?\/\//i, "");
  const host = cleaned.split("/")[0]?.split("?")[0]?.split(":")[0] ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host.toLowerCase() : "";
}

/** Validate a subscription's event filter string ("alert,uptime" → subset check against NOTIFY_EVENTS). */
export function parseEventsFilter(csv: string): string[] {
  const wanted = csv.split(",").map(s => s.trim()).filter(Boolean);
  return NOTIFY_EVENTS.filter(e => wanted.includes(e));
}
