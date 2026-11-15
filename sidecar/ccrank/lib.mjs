// ccrank — pure helpers shared by the builder and the server. No dependencies, no I/O except
// the injected block reader, so everything here is unit-testable.
//
// Data layout produced by build.mjs (one directory per Common Crawl web-graph release):
//
//   ranks.tsv   one row per registered domain, sorted bytewise by domain (LC_ALL=C):
//               "<domain>\t<hcRank>\t<hcVal>\t<prRank>\t<prVal>\t<hosts>\n"
//   index.tsv   every STRIDE-th row of ranks.tsv: "<domain>\t<byte offset of that row>\n"
//   meta.json   { release, total, stride, builtAt, source }
//
// A lookup binary-searches the in-memory sparse index (≈ 58 k entries for 118 M rows), reads one
// stretch of ranks.tsv between two index entries (≈ 100 KB) and scans it. No database.

export const STRIDE = 2048;
export const MAX_QUERY_DOMAINS = 50;

/** "com.example" → "example.com"; the graph stores registered domains in reverse notation. */
export function unreverseDomain(rev) {
  return String(rev).trim().toLowerCase().split(".").filter(Boolean).reverse().join(".");
}

/**
 * Column positions from the ranks file's own header line, e.g.
 * "#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts". Read from the header
 * rather than assumed: the host-level and domain-level files differ, and releases have changed.
 */
export function parseHeader(line) {
  const cols = String(line).trim().split("\t").map(c => c.replace(/^#/, "").trim().toLowerCase());
  const at = name => cols.indexOf(name);
  const map = { hcRank: at("harmonicc_pos"), hcVal: at("harmonicc_val"), prRank: at("pr_pos"), prVal: at("pr_val"), domain: at("host_rev"), hosts: at("n_hosts") };
  if (map.hcRank < 0 || map.domain < 0) throw new Error(`unrecognised ranks header: ${line}`);
  return map;
}

// Printable ASCII hostname characters only. Domains in the graph are punycode; anything else is
// a malformed row, and keeping it would break the bytewise == JS string order assumption.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const isPlainDomain = d => d.length <= 253 && DOMAIN_RE.test(d);

/** One data line of the source file → one output row, or null to drop it. */
export function transformLine(line, cols) {
  if (!line || line[0] === "#") return null;
  const f = line.split("\t");
  const domain = unreverseDomain(f[cols.domain] ?? "");
  const hcRank = Number(f[cols.hcRank]);
  if (!isPlainDomain(domain) || !Number.isInteger(hcRank) || hcRank < 1) return null;
  const pick = i => (i >= 0 && f[i] !== undefined ? f[i].trim() : "");
  return `${domain}\t${hcRank}\t${pick(cols.hcVal)}\t${pick(cols.prRank)}\t${pick(cols.prVal)}\t${pick(cols.hosts)}`;
}

/** "https://WWW.Example.com/x" → "example.com"; null when it is not a usable host name. */
export function normalizeQuery(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  try { s = new URL(`http://${s}`).hostname; } catch { return null; } // punycodes IDNs
  s = s.replace(/^www\./, "");
  return isPlainDomain(s) ? s : null;
}

/**
 * Names to try for a query, most specific first: the host itself, then with left labels
 * removed down to two. The graph is keyed by registered domain, and without a public-suffix
 * list the registered domain of "blog.example.co.uk" is found by trying, not by parsing.
 */
export function candidates(domain) {
  const labels = domain.split(".");
  const out = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** index.tsv text → parallel arrays. */
export function parseIndex(text) {
  const keys = [], offsets = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    keys.push(line.slice(0, tab));
    offsets.push(Number(line.slice(tab + 1)));
  }
  return { keys, offsets };
}

/** Byte range of ranks.tsv that must contain `domain` if it exists, or null when it sorts before the first row. */
export function blockFor(index, domain, fileSize) {
  const { keys, offsets } = index;
  let lo = 0, hi = keys.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= domain) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit < 0) return null;
  return { start: offsets[hit], end: hit + 1 < offsets.length ? offsets[hit + 1] : fileSize };
}

const numOrNull = s => (s === "" || s === undefined ? null : Number.isFinite(Number(s)) ? Number(s) : null);

/** Find one domain's row inside a block of ranks.tsv text. */
export function findRow(blockText, domain) {
  const needle = `${domain}\t`;
  let pos = 0;
  while (pos < blockText.length) {
    if (blockText.startsWith(needle, pos)) {
      const nl = blockText.indexOf("\n", pos);
      const f = blockText.slice(pos, nl < 0 ? undefined : nl).split("\t");
      return { domain: f[0], hcRank: numOrNull(f[1]), hcVal: numOrNull(f[2]), prRank: numOrNull(f[3]), prVal: numOrNull(f[4]), hosts: numOrNull(f[5]) };
    }
    const nl = blockText.indexOf("\n", pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  return null;
}

/**
 * Resolve one query against a loaded dataset. `readBlock(start, end)` returns the text of
 * ranks.tsv in [start, end) — injected so tests run on a string.
 */
export async function lookup(dataset, rawQuery, readBlock) {
  const query = normalizeQuery(rawQuery);
  if (!query) return { query: String(rawQuery ?? "").slice(0, 253), found: false, error: "bad_domain" };
  for (const name of candidates(query)) {
    const block = blockFor(dataset.index, name, dataset.size);
    if (!block) continue;
    const row = findRow(await readBlock(block.start, block.end), name);
    if (row) return { query, found: true, ...row };
  }
  return { query, found: false };
}

/** Sliding-window rate limiter: `limit` hits per `windowMs` per key. Returns true when allowed. */
export function makeLimiter(limit, windowMs, now = Date.now) {
  const hits = new Map();
  return key => {
    const t = now();
    const list = (hits.get(key) ?? []).filter(x => t - x < windowMs);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
    return true;
  };
}
