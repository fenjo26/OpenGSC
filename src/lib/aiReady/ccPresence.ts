// T2 — presence in Common Crawl's monthly archives.
//
// Common Crawl is the corpus most LLM training sets start from, so "is this domain in it, and
// in how many of the recent months" is the closest free proxy for "has an AI ever had a chance
// to read this site". It is a weak signal — CC samples the web, a small site can be missing
// from a month with no block anywhere — which is why it carries the smallest weight in the
// score and is judged over twelve months, not one.
//
// Why not the CDX API (index.commoncrawl.org/<crawl>-index?url=…): it is one request, but the
// server is shared and routinely answers 504 (it did on the live check, 2026-11-15). The same
// data is published as static files on data.commoncrawl.org, behind a CDN, and can be read
// with HTTP range requests:
//
//   cluster.idx   one line per ~3000 index records, sorted by SURT key:
//                 "<surt-url> <timestamp>\t<cdx-file>\t<offset>\t<length>\t<seq>"
//                 ~104 MB — never downloaded; binary-searched in ~12 probes of a few KB.
//   cdx-NNNNN.gz  the records themselves, each ~3000-line block its own gzip member that the
//                 line above addresses by offset/length (~250 KB).
//
// All records of a domain and its subdomains are contiguous in SURT order
// ("com,example)/…" then "com,example,www)/…"), so presence is: find the block where that range
// starts, read it (and up to two more while the range continues), count matching lines.
//
// Past crawls never change. The caller caches each (domain, crawl) answer for good.

import { gunzipSync } from "node:zlib";
import { safeFetch } from "@/lib/security/safeFetch";
import type { PresenceMonth, PresencePart } from "./types";

export const CC_COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";
export const CC_DATA_BASE = "https://data.commoncrawl.org";
export const PRESENCE_MONTHS = 12;
/** Blocks read per crawl before the count is reported as "at least". */
export const MAX_BLOCKS = 3;

const PROBE_BYTES = 4096;      // one binary-search probe; must hold a line tail plus one full line
const PROBE_BYTES_WIDE = 32_768; // retry size when a probe lands inside a very long URL
const WINDOW_BYTES = 49_152;   // the search stops when the candidate range is this narrow
const WINDOW_SLACK = 65_536;   // read past the window so the following blocks' lines are in hand

export interface CcCrawl { id: string; month: string }

// ─── Pure half ────────────────────────────────────────────────────────────────

/** Newest-first crawl list from collinfo.json; `month` comes from the crawl's own start date. */
export function parseCollinfo(json: unknown, take = PRESENCE_MONTHS): CcCrawl[] {
  if (!Array.isArray(json)) return [];
  const out: CcCrawl[] = [];
  for (const row of json) {
    const id = String((row as { id?: unknown })?.id ?? "");
    const from = String((row as { from?: unknown })?.from ?? "");
    // Only the main crawls: the list also carries news/other collections on some mirrors.
    if (!/^CC-MAIN-\d{4}-\d{2}$/.test(id)) continue;
    const month = /^\d{4}-\d{2}/.test(from) ? from.slice(0, 7) : "";
    out.push({ id, month });
    if (out.length >= take) break;
  }
  return out;
}

/** "Blog.Example.co.uk" → "uk,co,example,blog". Leading www. is dropped (CC's SURT drops it too). */
export function surtDomain(domain: string): string {
  const host = domain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return host.split(".").filter(Boolean).reverse().join(",");
}

/**
 * The half-open key range holding a domain and all its subdomains. After the domain's labels a
 * key continues with ")" (the host itself) or "," (a subdomain); the next byte value after
 * both is "-", which is where "com,example-shop" — a different domain — begins.
 */
export function domainKeyRange(surt: string): { lo: string; hi: string } {
  return { lo: `${surt})`, hi: `${surt}-` };
}

export const isDomainKey = (key: string, surt: string) => key.startsWith(`${surt})`) || key.startsWith(`${surt},`);

export interface IdxLine { key: string; file: string; offset: number; length: number }

/** One cluster.idx line. The key is the SURT URL alone — the timestamp after the space is dropped. */
export function parseIdxLine(line: string): IdxLine | null {
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const space = parts[0].indexOf(" ");
  const key = space < 0 ? parts[0] : parts[0].slice(0, space);
  const offset = Number(parts[2]), length = Number(parts[3]);
  if (!key || !/^cdx-\d+\.gz$/.test(parts[1]) || !Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return null;
  return { key, file: parts[1], offset, length };
}

/**
 * From consecutive idx lines (the first one starting at a line boundary), pick the blocks that
 * can hold the domain: the last block starting before the range, then every block starting
 * inside it. `more` is true when the list was cut at `maxBlocks` while the range continued.
 */
export function pickBlocks(lines: IdxLine[], surt: string, maxBlocks = MAX_BLOCKS): { blocks: IdxLine[]; more: boolean } {
  const { lo, hi } = domainKeyRange(surt);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].key < lo) start = i; else break;
  }
  const blocks: IdxLine[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    if (i > start && lines[i].key >= hi) break;
    if (blocks.length >= maxBlocks) return { blocks, more: true };
    blocks.push(lines[i]);
  }
  return { blocks, more: false };
}

/** Records of the domain in one decompressed cdx block. A record line starts with its SURT key. */
export function countCaptures(blockText: string, surt: string): number {
  const a = `${surt})`, b = `${surt},`;
  let n = 0, pos = 0;
  while (pos < blockText.length) {
    if (blockText.startsWith(a, pos) || blockText.startsWith(b, pos)) n++;
    const nl = blockText.indexOf("\n", pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  return n;
}

// ─── Range reader ─────────────────────────────────────────────────────────────

/** Bytes [start, end] of a file, plus the file's total size when the server reported it. */
export type RangeReader = (url: string, start: number, end: number) => Promise<{ bytes: Uint8Array; total: number | null }>;

// latin1 keeps one char per byte, so JS string comparison equals the byte order the index is
// sorted in — a UTF-8 decode would reorder keys that carry non-ASCII bytes.
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

/** Key of the first complete line that starts after `text`'s first newline, and that line's offset in `text`. */
function firstFullLineKey(text: string): { key: string; at: number } | null {
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  const rest = text.slice(nl + 1);
  const space = rest.search(/[ \t]/);
  if (space <= 0) return null;
  return { key: rest.slice(0, space), at: nl + 1 };
}

/**
 * Binary search of cluster.idx for the blocks of one domain. Invariant: `lo` is always the
 * start of a line whose key is below the range (or 0), `hi` is past the line we are after.
 */
export async function findBlocks(read: RangeReader, crawlId: string, surt: string, maxBlocks = MAX_BLOCKS): Promise<{ blocks: IdxLine[]; more: boolean }> {
  const url = `${CC_DATA_BASE}/cc-index/collections/${crawlId}/indexes/cluster.idx`;
  const target = domainKeyRange(surt).lo;

  const head = await read(url, 0, PROBE_BYTES - 1);
  const size = head.total;
  if (!size || size <= 0) throw new Error("cluster.idx: size unknown");

  let lo = 0, hi = size;
  for (let guard = 0; hi - lo > WINDOW_BYTES && guard < 64; guard++) {
    const mid = Math.floor((lo + hi) / 2);
    let probe = firstFullLineKey(latin1((await read(url, mid, Math.min(size, mid + PROBE_BYTES) - 1)).bytes));
    if (!probe) probe = firstFullLineKey(latin1((await read(url, mid, Math.min(size, mid + PROBE_BYTES_WIDE) - 1)).bytes));
    if (!probe) { hi = mid; continue; } // no line boundary this close to the end — the answer is to the left
    if (probe.key < target) lo = mid + probe.at; else hi = mid + probe.at;
  }

  const win = latin1((await read(url, lo, Math.min(size, hi + WINDOW_SLACK) - 1)).bytes);
  const lines: IdxLine[] = [];
  const raw = win.split("\n");
  // The last piece may be cut mid-line unless the window reached the end of the file.
  const complete = hi + WINDOW_SLACK >= size ? raw : raw.slice(0, -1);
  for (const l of complete) {
    const parsed = parseIdxLine(l);
    if (parsed) lines.push(parsed);
  }
  if (!lines.length) throw new Error("cluster.idx: empty window");
  return pickBlocks(lines, surt, maxBlocks);
}

/** Presence of one domain in one crawl. Throws on any read failure — the caller records "unknown". */
export async function crawlPresence(read: RangeReader, crawl: CcCrawl, domain: string): Promise<PresenceMonth> {
  const surt = surtDomain(domain);
  const { blocks, more } = await findBlocks(read, crawl.id, surt);
  let captures = 0;
  for (const b of blocks) {
    const url = `${CC_DATA_BASE}/cc-index/collections/${crawl.id}/indexes/${b.file}`;
    const { bytes } = await read(url, b.offset, b.offset + b.length - 1);
    captures += countCaptures(gunzipSync(bytes).toString("latin1"), surt);
  }
  return { crawl: crawl.id, month: crawl.month, present: captures > 0, captures, capped: more && captures > 0 };
}

// ─── Twelve months, resumable ────────────────────────────────────────────────

/** Wall-clock budget of one presence call. The UI re-calls while `pending > 0`. */
export const PRESENCE_BUDGET_MS = 40_000;
const PRESENCE_CONCURRENCY = 3;

/**
 * Merge the current crawl list with what is already known. A month answered before (present
 * true/false) is final — past archives do not change — so only new and failed months are read.
 * Pure given `read`.
 */
export async function runPresence(
  domain: string,
  crawls: CcCrawl[],
  previous: PresenceMonth[] | undefined,
  read: RangeReader,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<PresencePart> {
  const clock = opts.now ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? PRESENCE_BUDGET_MS);
  const known = new Map((previous ?? []).filter(m => m.present !== null).map(m => [m.crawl, m]));
  const months: PresenceMonth[] = crawls.map(c => known.get(c.id) ?? { crawl: c.id, month: c.month, present: null, captures: 0, capped: false });

  const todo = months.map((m, i) => (m.present === null ? i : -1)).filter(i => i >= 0);
  let cursor = 0, throttled = false;
  const worker = async () => {
    while (cursor < todo.length && clock() < deadline && !throttled) {
      const i = todo[cursor++];
      try {
        months[i] = await crawlPresence(read, crawls[i], domain);
      } catch (e) {
        // Left as present:null — unread, not absent. It is retried on the next call.
        // A throttle answer is different from one failed month: the host is telling us to stop,
        // so nothing further is asked in this call (requests already in flight finish).
        if (e instanceof RangeThrottledError) { throttled = true; return; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PRESENCE_CONCURRENCY, todo.length) }, worker));

  // `pending` counts only months never attempted in this call (budget ran out). A month that
  // was tried and failed stays null but does not make the UI loop forever on a dead endpoint.
  // When throttled, `pending` is 0 on purpose: the months left are not asked again by the same
  // click — the next run (minutes later, by a person) picks them up.
  return { months, pending: throttled ? 0 : todo.length - cursor, ...(throttled ? { throttled: true } : {}), checkedAt: new Date(clock()).toISOString() };
}

// ─── Network half ─────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (compatible; OpenGSC-AiReady/1.0; +https://opengsc.org)";

/** The host asked us to slow down or refused us (429 / 403 / 503) — stop, do not retry in a loop. */
export class RangeThrottledError extends Error {
  constructor(public readonly status: number) { super(`range throttled ${status}`); this.name = "RangeThrottledError"; }
}

export const isThrottleStatus = (status: number) => status === 429 || status === 403 || status === 503;

/** How long to wait before the single retry: the server's Retry-After, bounded to 1–5 s. */
export function backoffMs(retryAfter: string | null): number {
  const sec = Number(retryAfter);
  return Math.min(5000, Math.max(1000, Number.isFinite(sec) && sec > 0 ? sec * 1000 : 2000));
}

export const httpRangeReader: RangeReader = async (url, start, end) => {
  const once = () => safeFetch(url, {
    headers: { "User-Agent": UA, Range: `bytes=${start}-${end}` },
    timeoutMs: 20_000,
    maxBytes: Math.max(1_048_576, (end - start + 1) * 2),
    allowPrivate: false,
  });
  let res = await once();
  if (isThrottleStatus(res.status)) {
    // One polite retry. A second refusal ends the whole presence run (see runPresence).
    await new Promise(r => setTimeout(r, backoffMs(res.headers.get("retry-after"))));
    res = await once();
    if (isThrottleStatus(res.status)) throw new RangeThrottledError(res.status);
  }
  // 206 is the only acceptable answer: a 200 would be the whole 104 MB file.
  if (res.status !== 206) throw new Error(`range ${res.status}`);
  const total = Number((res.headers.get("content-range") ?? "").split("/")[1]);
  return { bytes: new Uint8Array(await res.arrayBuffer()), total: Number.isFinite(total) && total > 0 ? total : null };
};

export async function fetchCrawlList(take = PRESENCE_MONTHS): Promise<CcCrawl[]> {
  const res = await safeFetch(CC_COLLINFO_URL, { headers: { "User-Agent": UA, Accept: "application/json" }, timeoutMs: 20_000, maxBytes: 1_048_576, allowPrivate: false });
  if (!res.ok) throw new Error(`collinfo ${res.status}`);
  return parseCollinfo(await res.json(), take);
}
