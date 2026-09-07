// The last enrichment layer: what the domain used to be about, and whether something shameful
// happened to it after it died.
//
// Three CDX timestamps (first, middle, last month of the archive), three archived pages, one
// small model call over their text. The verdict lands in `historyVerdict`, where it feeds both
// the score (clean +20, topic shift +5, spam −30) and the veto (a spam interlude is a hard
// "do not buy"). This is the pass the reference tool ran through deepseek; here it runs on
// whatever AI provider the owner has configured, on rows the user picked by hand — never on a
// whole list, because it is the only drops stage that spends LLM credits.

import { safeFetch } from "@/lib/security/safeFetch";
import { sanitiseForUrl } from "./availability";
import type { HistoryVerdict } from "./types";

/** Months from the collapsed CDX timeline, spread as first / middle / last. */
export function pickSnapshotTimestamps(timestamps: string[], count = 3): string[] {
  const unique = [...new Set(timestamps)].sort();
  if (unique.length <= count) return unique;
  const step = (unique.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => unique[Math.round(i * step)]);
}

/** Archived page (the `id_` form: the original document, no Wayback toolbar) to readable text. */
export function extractText(html: string, maxChars = 4000): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script/gi, " ")
    .replace(/<style[\s\S]*?<\/style/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

const VERDICTS: HistoryVerdict[] = ["clean", "topic_shift", "spam_period", "unknown"];

/**
 * The model's reply to a verdict. The reply may arrive fenced or with prose around the JSON —
 * models do that — so anything that does not parse into a known verdict becomes `unknown` with
 * the raw text kept as the note. An unreadable answer must not read as "clean" by default.
 */
export function parseHistoryVerdict(raw: string | null, domain: string): { verdict: HistoryVerdict; note: string } {
  if (!raw) return { verdict: "unknown", note: "AI pass returned no text" };
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { verdict?: unknown; note?: unknown };
      const verdict = String(parsed.verdict ?? "") as HistoryVerdict;
      if (VERDICTS.includes(verdict)) {
        const note = String(parsed.note ?? "").slice(0, 800);
        return { verdict, note: note || `${domain}: ${verdict}` };
      }
    } catch { /* fall through to unknown */ }
  }
  return { verdict: "unknown", note: `unparsed AI reply: ${raw.slice(0, 300)}` };
}

const PROMPT = (domain: string, snippets: { ts: string; text: string }[]) => [
  `You are vetting an expired domain (${domain}) for purchase. Below are text extracts of the site as archived by the Wayback Machine at three points in its life.`,
  "",
  ...snippets.map(s => `=== ${s.ts.slice(0, 4)} ===\n${s.text}`),
  "",
  "Decide:",
  `1. verdict — one of exactly: "clean" (one coherent topic for the whole life), "topic_shift" (the topic changed at some point, e.g. re-registered and repurposed), "spam_period" (pharma/casino-adult spam sheets, injected content, doorway pages — at any point in its life), "unknown" (the extracts carry too little text to judge).`,
  "2. note — one or two factual sentences: what the site was about, when it changed (if it did), and any spam signs. No recommendations, no hedging.",
  'Reply with JSON only: {"verdict": "...", "note": "..."}. Reply in English.',
].join("\n");

export interface HistoryAiCreds {
  aiProvider: string;
  aiApiKey: string;
  model?: string;
  aiBaseUrl?: string;
}

/** One domain: archived texts in, verdict + note out. Returns null when there is nothing to judge. */
export async function analyseDomainHistory(
  domain: string,
  timestamps: string[],
  creds: HistoryAiCreds,
  fetchLLM: (prompt: string, provider: string, apiKey: string, maxTokens: number, modelOverride?: string, baseUrl?: string) => Promise<string | null>,
): Promise<{ verdict: HistoryVerdict; note: string } | null> {
  const clean = sanitiseForUrl(domain);
  if (!clean) return null;
  const picks = pickSnapshotTimestamps(timestamps);
  const snippets: { ts: string; text: string }[] = [];
  for (const ts of picks) {
    const text = await fetchArchivedText(clean, ts);
    if (text.length > 120) snippets.push({ ts, text });
  }
  if (!snippets.length) return { verdict: "unknown", note: "no archived page text could be fetched" };

  const raw = await fetchLLM(PROMPT(domain, snippets), creds.aiProvider, creds.aiApiKey, 500, creds.model, creds.aiBaseUrl);
  return parseHistoryVerdict(raw, domain);
}

async function fetchArchivedText(domain: string, ts: string): Promise<string> {
  try {
    // `id_` returns the original captured document without the Wayback toolbar markup.
    const res = await safeFetch(`https://web.archive.org/web/${ts}id_/https://${domain}/`, {
      headers: { accept: "text/html" },
      timeoutMs: 15_000,
      maxBytes: 512 * 1024,
      allowPrivate: false,
    });
    if (!res.ok) return "";
    return extractText(await res.text());
  } catch {
    return "";
  }
}
