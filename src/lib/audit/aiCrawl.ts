// AI Crawlability check — a site-wide companion to the page-level audit.
//
// The crawler answers "what is wrong with these pages". This answers a different question the
// GEO Audit and AEO Tracker can only *observe* (you're not cited) but never *explain*: WHY is an
// AI engine not crawling or citing the site. The two levers a site owner controls are robots.txt
// (can the bot read the site at all) and /llms.txt (an emerging, voluntary hint file describing the
// site for LLMs). A `Disallow: /` against GPTBot silently takes the site out of ChatGPT's answers
// with no error anywhere, and the only visible symptom — "ChatGPT never cites us" — points nowhere
// near robots.txt. This check names that lever.
//
// Scope is deliberately narrow and stated in the comments below: we detect ROOT-level blocks
// (`Disallow: /`), which is the dominant real-world pattern for blocking an AI bot wholesale. We do
// not do path-granular rule resolution (the full robots spec, with longest-match / pattern
// expansion / order-specificity) — that is a different problem, almost never how AI bots are gated,
// and pretending to solve it would report false confidence on edge cases we can't actually resolve.

import { safeFetch } from "@/lib/security/safeFetch";

const UA = "Mozilla/5.0 (compatible; OpenGSC-AiCheck/1.0; +https://opengsc.org)";
const FETCH_TIMEOUT_MS = 10_000;

// The AI crawlers worth naming. Each maps a robots.txt `User-agent:` token to the engine it feeds,
// so the UI can show "ChatGPT / OpenAI" rather than the opaque token. Tokens are the exact strings
// the engines announce in their own docs; the matcher is case-insensitive (the spec requires it).
export interface AiBot {
  token: string;
  engine: string; // proper noun — hardcoded like "ChatGPT" elsewhere in the codebase
}
export const AI_BOTS: AiBot[] = [
  { token: "GPTBot",       engine: "ChatGPT / OpenAI" },
  { token: "OAI-SearchBot", engine: "ChatGPT Search" },
  { token: "PerplexityBot", engine: "Perplexity" },
  { token: "ClaudeBot",    engine: "Claude / Anthropic" },
  { token: "Google-Extended", engine: "Google Gemini / AI Overviews" },
  { token: "CCBot",        engine: "Common Crawl" },
  { token: "Bytespider",   engine: "ByteDance" },
];

export type BotStatus = "allowed" | "blocked" | "unknown";

export interface AiCrawlReport {
  robots: { status: "ok" | "missing" | "failed"; present: boolean };
  llmsTxt: { status: "ok" | "missing" | "failed"; present: boolean; chars: number | null };
  bots: { token: string; engine: string; status: BotStatus }[];
  blockedCount: number;
  total: number;
}

// ─── robots.txt fetch ─────────────────────────────────────────────────────────

async function fetchRobots(root: URL): Promise<{ status: "ok" | "missing" | "failed"; text: string | null }> {
  try {
    const res = await safeFetch(new URL("/robots.txt", root), {
      headers: { "User-Agent": UA, Accept: "text/plain" },
      redirect: "follow",
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: 256_000,
    });
    // Per the robots spec, a 404/410 means "no restrictions" — everything is allowed. That is a
    // clean verdict, not a failure, so we surface it as "missing" (all bots allowed) rather than
    // "failed" (we couldn't tell). Only a network/timeout error is genuinely "unknown".
    if (res.status === 404 || res.status === 410) return { status: "missing", text: null };
    if (!res.ok) return { status: "failed", text: null };
    const text = await res.text();
    return { status: "ok", text: text.slice(0, 200_000) }; // cap pathological files
  } catch {
    return { status: "failed", text: null };
  }
}

// ─── robots.txt parsing ───────────────────────────────────────────────────────
//
// Groups are sequences of `User-agent:` lines followed by `Allow:`/`Disallow:` lines. We collect
// each rule under every agent named in the preceding header block, so a rule under
// "User-agent: *\nUser-agent: GPTBot" applies to both. Tokens are matched case-insensitively
// (RFC 9309 requires it). Patterns are kept verbatim — only `/` (root) and a couple of root-shaped
// prefixes are interpreted, which is all this check needs.

interface RobotGroup { allows: string[]; disallows: string[] }

export function parseRobotsGroups(text: string): Map<string, RobotGroup> {
  const groups = new Map<string, RobotGroup>();
  let currentAgents: string[] = [];
  let started = false; // have we seen any rule for the current group? (distinguishes a header from EOF)

  const flush = () => {
    // Ensure every named agent has an entry, even with empty rules, so "this bot is mentioned but
    // not restricted" still resolves correctly rather than falling through to `*`.
    for (const a of currentAgents) if (!groups.has(a)) groups.set(a, { allows: [], disallows: [] });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip comments and whitespace. A `#` can appear mid-line per spec.
    const hash = rawLine.indexOf("#");
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines extend the current group's agent list. A rule line in between
      // starts a new record, so reset on the first agent seen after any rule.
      if (started) { flush(); currentAgents = []; started = false; }
      if (value) currentAgents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (currentAgents.length === 0) continue; // rule with no preceding agent — orphan, ignore
      started = true;
      for (const a of currentAgents) {
        const g = groups.get(a) ?? { allows: [], disallows: [] };
        (field === "allow" ? g.allows : g.disallows).push(value);
        groups.set(a, g);
      }
    }
    // Unknown fields (Crawl-delay, Sitemap:, etc.) are irrelevant to a block verdict — skip.
  }
  flush();
  return groups;
}

// ─── verdict per bot ──────────────────────────────────────────────────────────
//
// A bot is blocked when its own group (or the `*` group as fallback) carries a root-level disallow
// that is not overridden by a root-level allow. Root-shaped means the pattern is `/`, empty, or
// `/*` — anything that matches the whole site. Narrower patterns (`/admin`) are out of scope: they
// gate specific paths, not the bot's access to the site, and resolving them needs the full
// longest-match spec this check intentionally avoids.

const isRootPattern = (p: string) => p === "/" || p === "" || p === "/*";

export function botStatus(groups: Map<string, RobotGroup>, token: string): BotStatus {
  const key = token.toLowerCase();
  // Prefer the bot's own group; fall back to the universal group. If neither names the bot, the
  // spec default is "allowed" — but we only know that once we've actually seen the file, so the
  // caller distinguishes "allowed by absence of a group" from "we never got the file".
  const group = groups.get(key) ?? groups.get("*");
  if (!group) return "allowed";
  const rootDisallowed = group.disallows.some(isRootPattern);
  const rootAllowed = group.allows.some(isRootPattern);
  // An explicit Allow: / is the standard override for a Disallow: / within the same group.
  if (rootDisallowed && !rootAllowed) return "blocked";
  return "allowed";
}

// ─── /llms.txt fetch ──────────────────────────────────────────────────────────
//
// /llms.txt is a proposed convention (llmstxt.org) analogous to robots.txt but aimed at LLMs: a
// human/-machine-readable summary of the site. Presence is a positive signal of AI-discoverability
// intent; absence is the norm today and not an error, so "missing" stays neutral, not red.

async function fetchLlmsTxt(root: URL): Promise<{ status: "ok" | "missing" | "failed"; chars: number | null }> {
  try {
    const res = await safeFetch(new URL("/llms.txt", root), {
      headers: { "User-Agent": UA, Accept: "text/plain" },
      redirect: "follow",
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: 512_000,
    });
    if (res.status === 404 || res.status === 410) return { status: "missing", chars: null };
    if (!res.ok) return { status: "failed", chars: null };
    const text = await res.text();
    return { status: "ok", chars: text.length };
  } catch {
    return { status: "failed", chars: null };
  }
}

// ─── orchestrator ─────────────────────────────────────────────────────────────

export async function checkAiCrawlability(root: URL): Promise<AiCrawlReport> {
  const [robots, llmsTxt] = await Promise.all([fetchRobots(root), fetchLlmsTxt(root)]);

  // If we never got the file (network error, 5xx), every bot is "unknown" rather than "allowed":
  // "we couldn't read robots.txt" must not be reported as "every bot is welcome", because the
  // owner might have a block in place we simply failed to see.
  const groups = robots.status === "ok" && robots.text != null ? parseRobotsGroups(robots.text) : new Map<string, RobotGroup>();

  const bots = AI_BOTS.map(({ token, engine }) => ({
    token,
    engine,
    status: robots.status === "failed" ? "unknown" as BotStatus : botStatus(groups, token),
  }));

  const blockedCount = bots.filter(b => b.status === "blocked").length;

  return {
    robots: { status: robots.status, present: robots.status === "ok" },
    llmsTxt: { status: llmsTxt.status, present: llmsTxt.status === "ok", chars: llmsTxt.chars },
    bots,
    blockedCount,
    total: bots.length,
  };
}
