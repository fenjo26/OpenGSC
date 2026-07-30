// Parser for Ahrefs/Semrush exports, shared by two callers that look different but are not:
// a file the user downloaded from the browser UI, and an `output=csv` response from the API.
// Same columns, same order, so one parser serves both — and the free path is the one that gets
// exercised first, which is the point of building it before anything paid.
//
// The report type is detected from the header row rather than asked for. A user uploading a
// file has no reason to know whether they exported "Organic keywords" or "Keywords Explorer",
// and getting that question wrong silently writes volumes into the wrong table.

export type ReportKind = "keywords" | "domains" | "refdomains";

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

// ─── Decoding ──────────────────────────────────────────────────────────────────

/**
 * Ahrefs has historically exported UTF-16 LE with tab separators, while everything else in the
 * world sends UTF-8. Read as UTF-8 and a UTF-16 file becomes NUL-separated mojibake whose header
 * row matches nothing — the failure looks like "unrecognized report", which sends you looking in
 * entirely the wrong place. Sniffing the BOM costs two bytes and removes the whole class of bug.
 */
export function decodeExport(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── Delimited parsing ─────────────────────────────────────────────────────────

/** Picks whichever of tab/comma/semicolon appears most often outside quotes on the header line. */
function detectDelimiter(headerLine: string): string {
  const counts = ["\t", ",", ";"].map(d => {
    let inQuotes = false, n = 0;
    for (const ch of headerLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) n++;
    }
    return { d, n };
  });
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

/** RFC4180-ish: handles quoted fields, doubled quotes inside them, and newlines within quotes. */
function splitRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

export function parseTable(text: string): ParsedTable {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const delim = detectDelimiter(firstLine);
  const rows = splitRows(text, delim);
  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows[0].map(h => h.trim());
  return {
    headers,
    rows: rows.slice(1).map(cells =>
      Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])),
    ),
  };
}

// ─── Header matching ───────────────────────────────────────────────────────────

/** "Search Volume" / "search_volume" / "Volume " all collapse to the same token. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function pick(row: Record<string, string>, headers: string[], aliases: string[]): string | null {
  const wanted = aliases.map(norm);
  for (const h of headers) {
    if (wanted.includes(norm(h))) {
      const v = row[h];
      if (v != null && v !== "") return v;
    }
  }
  return null;
}

function hasColumn(headers: string[], aliases: string[]): boolean {
  const wanted = aliases.map(norm);
  return headers.some(h => wanted.includes(norm(h)));
}

const COL = {
  keyword: ["Keyword", "Keywords", "Query", "Phrase"],
  volume: ["Volume", "Search Volume", "Search volume", "Nq", "Volume (monthly)"],
  difficulty: ["KD", "Difficulty", "Keyword Difficulty", "KD%"],
  cpc: ["CPC", "CPC (USD)", "Cp"],
  globalVolume: ["Global volume", "Global Volume"],
  parentTopic: ["Parent Topic", "Parent topic"],
  domain: ["Domain", "Referring domain", "Target", "Referring Domains", "Dn"],
  dr: ["DR", "Domain rating", "Domain Rating", "Domain rating source"],
  refDomains: ["Ref domains", "Referring domains", "RD", "Ref. domains"],
  backlinks: ["Backlinks", "Total backlinks", "Links"],
  orgTraffic: ["Traffic", "Organic traffic", "Organic Traffic", "Ot"],
  orgKeywords: ["Organic keywords", "Keywords", "Or"],
  orgCost: ["Traffic value", "Organic Cost", "Value", "Oc"],
  linksToTarget: ["Links to target", "Links To Target", "Links to Target", "Backlinks to target"],
  dofollowLinks: ["Dofollow links", "Dofollow", "Dofollow backlinks"],
  firstSeen: ["First seen", "First Seen"],
};

/**
 * Detection is deliberately keyword-first: an Organic-keywords export carries *both* a keyword
 * column and a domain-ish "Traffic" column, and treating it as a domain report would write one
 * garbage domain row and drop hundreds of real keywords.
 */
export function detectReport(headers: string[]): ReportKind | null {
  if (hasColumn(headers, COL.keyword) && (hasColumn(headers, COL.volume) || hasColumn(headers, COL.difficulty))) {
    return "keywords";
  }
  // Checked before the generic domain report: a Referring domains export also carries Domain +
  // DR, and reading it as a domain-metrics file would file every referring site as if it were
  // one of the user's own properties.
  if (hasColumn(headers, COL.domain) && hasColumn(headers, COL.linksToTarget)) {
    return "refdomains";
  }
  if (hasColumn(headers, COL.domain) && (hasColumn(headers, COL.dr) || hasColumn(headers, COL.refDomains))) {
    return "domains";
  }
  return null;
}

// ─── Value coercion ────────────────────────────────────────────────────────────

/**
 * Exports carry display formatting, not raw numbers: "12,300", "1.2K", "45%", "$1.20", "n/a",
 * and non-breaking spaces as thousands separators in some locales. A naive Number() turns all of
 * those into NaN, and a NaN written as null looks exactly like "this keyword has no data".
 */
export function toNumber(v: string | null): number | null {
  if (v == null) return null;
  let s = v.trim().toLowerCase();
  if (!s || s === "-" || s === "n/a" || s === "na") return null;

  s = s.replace(/[\s  ]/g, "").replace(/[$€£₽]/g, "").replace(/%$/, "");

  let mult = 1;
  if (/[km]$/.test(s)) {
    mult = s.endsWith("k") ? 1_000 : 1_000_000;
    s = s.slice(0, -1);
  }
  // "1,234" is a thousands separator; "1,23" (comma decimal) is not — decide by group length.
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (/,\d{3}(\D|$)/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");

  const n = Number(s);
  return Number.isFinite(n) ? n * mult : null;
}

// ─── Row mapping ───────────────────────────────────────────────────────────────

export interface CsvKeywordRow {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  globalVolume: number | null;
  parentTopic: string | null;
}

export function mapKeywordRows(table: ParsedTable): CsvKeywordRow[] {
  const { headers, rows } = table;
  return rows.map(r => ({
    keyword: (pick(r, headers, COL.keyword) ?? "").trim(),
    volume: toNumber(pick(r, headers, COL.volume)),
    difficulty: toNumber(pick(r, headers, COL.difficulty)),
    cpc: toNumber(pick(r, headers, COL.cpc)),
    globalVolume: toNumber(pick(r, headers, COL.globalVolume)),
    parentTopic: pick(r, headers, COL.parentTopic),
  })).filter(r => r.keyword);
}

export interface CsvDomainRow {
  domain: string;
  dr: number | null;
  refDomains: number | null;
  backlinks: number | null;
  orgTraffic: number | null;
  orgKeywords: number | null;
  orgCost: number | null;
}

/** Accepts either a bare domain or a full URL in the domain column. */
function hostOf(v: string): string {
  const s = v.trim();
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).hostname.replace(/^www\./, "").toLowerCase();
  } catch { /* fall through to the literal value */ }
  return s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
}

export interface CsvRefDomainRow {
  refDomain: string;
  dr: number | null;
  linksToTarget: number | null;
  dofollow: boolean;
  firstSeen: string;
}

export function mapRefDomainRows(table: ParsedTable): CsvRefDomainRow[] {
  const { headers, rows } = table;
  return rows.map(r => {
    const dofollowLinks = toNumber(pick(r, headers, COL.dofollowLinks));
    return {
      refDomain: hostOf(pick(r, headers, COL.domain) ?? ""),
      dr: toNumber(pick(r, headers, COL.dr)),
      linksToTarget: toNumber(pick(r, headers, COL.linksToTarget)),
      // A column absent from the export is not evidence of nofollow; only an explicit zero is.
      dofollow: dofollowLinks == null ? true : dofollowLinks > 0,
      firstSeen: pick(r, headers, COL.firstSeen) ?? "",
    };
  }).filter(r => r.refDomain.includes("."));
}

export function mapDomainRows(table: ParsedTable): CsvDomainRow[] {
  const { headers, rows } = table;
  return rows.map(r => ({
    domain: hostOf(pick(r, headers, COL.domain) ?? ""),
    dr: toNumber(pick(r, headers, COL.dr)),
    refDomains: toNumber(pick(r, headers, COL.refDomains)),
    backlinks: toNumber(pick(r, headers, COL.backlinks)),
    orgTraffic: toNumber(pick(r, headers, COL.orgTraffic)),
    orgKeywords: toNumber(pick(r, headers, COL.orgKeywords)),
    orgCost: toNumber(pick(r, headers, COL.orgCost)),
  })).filter(r => r.domain.includes("."));
}
