// Normalised text similarity — the measuring stick for cloaking detection.
//
// Why this module exists: comparing two fetches of the same page with a plain hash answers the
// wrong question. Real pages differ between any two requests — rotating banners, CSRF tokens,
// counters, timestamps, Cloudflare's email obfuscation. A hash says "different" for all of them
// and gives no way to tell a one-token drift from a swapped doorway page.
//
// So we do two things:
//   1) normalise away the *known* per-request noise (§ NOISE PATTERNS below), and
//   2) return a graded 0..1 similarity, so the caller can compare a bot-vs-user delta against the
//      page's own measured variance (see the sampling matrix in googlebot.ts) instead of a
//      hard-coded threshold.
//
// No dependencies — same convention as the rest of src/lib/seo.

const MAX_TOKENS = 20_000; // perf guard; pages are capped at 40k chars of text upstream anyway
const SHINGLE_K = 3;

// ─── NOISE PATTERNS ──────────────────────────────────────────────────────────
// Everything here is content that legitimately differs between two requests to the same URL, or
// between a bot request and a browser request, without any cloaking being involved. Each rule
// collapses both variants to the same placeholder so the diff sees them as equal.
export function normalizeForDiff(input: string): string {
  if (!input) return "";
  return input
    // Cloudflare email obfuscation. CF rewrites mailto links for browsers but serves the plain
    // address to crawlers, so the SAME page yields "[email protected]" to one side and the real
    // address to the other. This single rule is the most common false positive in the wild.
    .replace(/\[email\s*(?:&#160;|&nbsp;|\s)*protected\]/gi, " «email» ")
    .replace(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, " «email» ")
    .replace(/__cf_email__|data-cfemail|cfemail/gi, " ")
    .replace(/\/cdn-cgi\/[^\s"'<>]*/gi, " ")
    // UUIDs, then long hex/base64 blobs: nonces, integrity hashes, build ids, cfemail payloads.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " «id» ")
    .replace(/\b[0-9a-f]{20,}\b/gi, " «hash» ")
    // Named secrets: csrf / nonce / session / request ids.
    .replace(/\b(?:nonce|csrf|xsrf|_token|sessionid|session_id|requestid|request_id|sid)\b[\s:="']*[a-z0-9_\-]{8,}/gi, " «token» ")
    // Cache-busting query strings on assets.
    .replace(/[?&](?:v|ver|version|cb|rev|_|t|ts)=[a-z0-9._-]+/gi, " ")
    // Timestamps: ISO datetimes, epoch seconds/millis, clock times.
    .replace(/\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}(?::\d{2})?/gi, " «ts» ")
    .replace(/\b\d{10,13}\b/g, " «ts» ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " «time» ")
    .toLowerCase()
    // Drop punctuation so markup/formatting churn doesn't register as content change.
    .replace(/[^\p{L}\p{N}\s«»]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(normalized: string): string[] {
  if (!normalized) return [];
  const t = normalized.split(" ").filter(Boolean);
  return t.length > MAX_TOKENS ? t.slice(0, MAX_TOKENS) : t;
}

// k-token shingles. Word-level shingling (rather than character-level) means a single inserted
// element shifts only k shingles instead of misaligning the whole document — the failure mode that
// makes naive chunked diffs report an entire page as "changed" after one added <span>.
export function shingleSet(tokens: string[], k = SHINGLE_K): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < k) {
    for (const t of tokens) out.add(t);
    return out;
  }
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

// 0 = nothing in common, 1 = identical after normalisation.
export function textSimilarity(a: string, b: string): number {
  const na = normalizeForDiff(a);
  const nb = normalizeForDiff(b);
  if (na === nb) return 1;
  return jaccard(shingleSet(tokenize(na)), shingleSet(tokenize(nb)));
}

// Content present in one side and not the other, as whole normalised lines. Used for the forensic
// "served to Googlebot / served to users" split. Lines shorter than minWords are dropped: single
// words and UI chrome generate noise, not evidence.
export function exclusiveLines(
  aText: string,
  bText: string,
  opts?: { minWords?: number; limit?: number },
): { onlyA: string[]; onlyB: string[] } {
  const minWords = opts?.minWords ?? 3;
  const limit = opts?.limit ?? 50;
  const split = (s: string) =>
    s.split(/\n+/).map(l => l.trim()).filter(l => l.split(/\s+/).filter(Boolean).length >= minWords);

  const index = (lines: string[]) => {
    const m = new Map<string, { count: number; display: string }>();
    for (const l of lines) {
      const key = normalizeForDiff(l);
      if (!key) continue;
      const e = m.get(key);
      if (e) e.count++;
      else m.set(key, { count: 1, display: l });
    }
    return m;
  };

  const A = index(split(aText));
  const B = index(split(bText));
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [k, e] of A) for (let i = 0; i < e.count - (B.get(k)?.count ?? 0); i++) onlyA.push(e.display);
  for (const [k, e] of B) for (let i = 0; i < e.count - (A.get(k)?.count ?? 0); i++) onlyB.push(e.display);
  return { onlyA: onlyA.slice(0, limit), onlyB: onlyB.slice(0, limit) };
}
