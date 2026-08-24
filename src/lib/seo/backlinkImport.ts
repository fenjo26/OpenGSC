// Import and list-query logic for the Backlinks tab, shared by two callers that must never
// diverge: the import dialog's live preview (client) and POST /api/backlinks (server, apply).
// Pure on purpose — no Prisma, no fetch, no "use client"/server-only imports. The acceptance
// criterion "paste import and CSV import give the same result" is audited by construction:
// both sides run these exact functions on the same text.

import { parseTable, toNumber } from "./metricsCsv";

// ─── URL normalization ─────────────────────────────────────────────────────────
//
// The five steps below are not a design choice — they replicate the SQL normalization in
// T0's migration (20260825120000_add_site_backlinks) step for step. `urlFromNorm` is the
// dedup key behind the unique constraint, so a TypeScript import that normalized one step
// differently would duplicate every migrated row instead of matching it.

export function normalizeBacklinkUrl(input: string): string {
  let u = input.trim().toLowerCase();
  if (!u) return "";
  const hash = u.indexOf("#");
  if (hash > -1) u = u.slice(0, hash);
  u = u.replace(/^https?:\/\//, "");
  u = u.replace(/^www\./, "");
  if (u.length > 1 && u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

/** Donor host from the normalized form — identical to what T0's migration derives for
 *  `domainFrom` (normalized URL up to the first "/"), so imported rows land in the
 *  donor-domain filter together with migrated ones. */
export function donorHostOf(url: string): string {
  const norm = normalizeBacklinkUrl(url);
  if (!norm) return "";
  return norm.split("/")[0] ?? norm;
}

/** http(s) URLs with a real host. Everything else is "мусор" and gets counted, not saved. */
export function isHttpUrl(s: string): boolean {
  const v = s.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const host = new URL(v).hostname;
    return host.includes(".");
  } catch {
    return false;
  }
}

// ─── Column recognition ────────────────────────────────────────────────────────
//
// Reuses metricsCsv's norm() approach (case/punctuation-insensitive header matching) via
// parseTable; aliases live here because these columns exist nowhere else in the app.

const headerNorm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const IMPORT_COLUMNS = {
  url:       ["url", "url_from", "urlfrom", "donor", "donorurl", "donorpage", "page", "link"],
  targetUrl: ["target_url", "targeturl", "target", "url_to", "urlto", "ourpage", "our_url"],
  anchor:    ["anchor", "anchor_text", "anchortext", "text"],
  rel:       ["rel", "linktype", "link_type", "nofollow"],
  dr:        ["dr", "domain_rating", "domainrating", "domain_rating_source"],
  price:     ["price", "cost", "цена", "стоимость"],
  note:      ["note", "notes", "comment", "комментарий", "примечание"],
} as const;

type ImportColumn = keyof typeof IMPORT_COLUMNS;

/** Positional order for headerless rows, e.g. "url, anchor, target, dofollow" — the order
 *  the dialog tells the user about. Drives list-mode-with-fields and headerless CSV. */
export const POSITIONAL_COLUMNS: ImportColumn[] = ["url", "anchor", "targetUrl", "rel", "dr", "price", "note"];

const CANONICAL_LABEL: Record<ImportColumn, string> = {
  url: "url", targetUrl: "target_url", anchor: "anchor", rel: "rel",
  dr: "dr", price: "price", note: "note",
};

function matchHeader(h: string): ImportColumn | null {
  const n = headerNorm(h);
  for (const col of Object.keys(IMPORT_COLUMNS) as ImportColumn[]) {
    if ((IMPORT_COLUMNS[col] as readonly string[]).includes(n)) return col;
  }
  return null;
}

// ─── Parsed rows ───────────────────────────────────────────────────────────────

export interface ImportRow {
  /** donor page exactly as typed — the row identity the user recognizes */
  url: string;
  urlNorm: string;
  domain: string;
  /** "" when the import doesn't say — never guessed */
  targetUrl: string;
  anchor: string;
  rel: string;
  dr: number | null;
  price: string;
  note: string;
}

export interface ImportParseResult {
  mode: "list" | "table";
  rows: ImportRow[];
  /** canonical names of columns that were recognized and read */
  columns: string[];
  /** header names that matched nothing — shown in the preview, dropped silently */
  ignoredColumns: string[];
  /** lines that had a url field but failed isHttpUrl */
  skippedRows: number;
  /** repeated url+target inside one import — merged, not double-created */
  duplicates: number;
}

function makeRow(url: string, fields: Partial<Record<ImportColumn, string>>): ImportRow {
  return {
    url,
    urlNorm: normalizeBacklinkUrl(url),
    domain: donorHostOf(url),
    targetUrl: (fields.targetUrl ?? "").trim(),
    anchor: (fields.anchor ?? "").trim(),
    rel: (fields.rel ?? "").trim(),
    dr: fields.dr != null && fields.dr !== "" ? toNumber(fields.dr) : null,
    price: (fields.price ?? "").trim(),
    note: (fields.note ?? "").trim(),
  };
}

/**
 * Accepts, in one function:
 *  - a bare list — one URL per line, `#` starts a comment;
 *  - a table with a header (CSV / TSV / pasted export) — columns matched by alias;
 *  - headerless delimited rows — positional columns in the documented order, detected by the
 *    first field being an http(s) URL while the text has no recognizable header.
 */
export function parseBacklinkImport(text: string): ImportParseResult {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const bodyLines = lines.filter(l => l !== "" && !l.startsWith("#"));
  const result: ImportParseResult = { mode: "list", rows: [], columns: [], ignoredColumns: [], skippedRows: 0, duplicates: 0 };
  if (bodyLines.length === 0) return result;

  // Table mode: metricsCsv already handles quoted fields, delimiter detection and BOM-less
  // UTF-16 mojibake is not a concern here because the dialog decodes files via decodeExport.
  const table = parseTable(bodyLines.join("\n"));
  const headerMap = table.headers.map(h => ({ header: h, col: matchHeader(h) }));
  const hasUrlColumn = headerMap.some(m => m.col === "url");

  const seen = new Map<string, number>(); // urlNorm + "\u0000" + targetNorm → index in rows

  const pushRow = (row: ImportRow) => {
    const key = row.urlNorm + "\u0000" + normalizeBacklinkUrl(row.targetUrl);
    const prev = seen.get(key);
    if (prev != null) {
      // Same placement twice in one import: keep the first, fill its empty optional fields.
      result.duplicates += 1;
      const keep = result.rows[prev];
      keep.targetUrl = keep.targetUrl || row.targetUrl;
      keep.anchor = keep.anchor || row.anchor;
      keep.rel = keep.rel || row.rel;
      keep.dr = keep.dr ?? row.dr;
      keep.price = keep.price || row.price;
      keep.note = keep.note || row.note;
      return;
    }
    seen.set(key, result.rows.length);
    result.rows.push(row);
  };

  if (hasUrlColumn) {
    result.mode = "table";
    const recognized = new Set<ImportColumn>();
    for (const { col } of headerMap) if (col) recognized.add(col);
    result.columns = POSITIONAL_COLUMNS.filter(c => recognized.has(c)).map(c => CANONICAL_LABEL[c]);
    result.ignoredColumns = headerMap.filter(m => !m.col).map(m => m.header);

    let fields: Partial<Record<ImportColumn, string>> = {};
    for (const row of table.rows) {
      fields = {};
      headerMap.forEach(({ header, col }) => {
        if (col) fields[col] = row[header] ?? "";
      });
      const url = (fields.url ?? "").trim();
      if (!url) continue; // blank cells, not broken URLs — not counted as skipped
      if (!isHttpUrl(url)) { result.skippedRows += 1; continue; }
      pushRow(makeRow(url, fields));
    }
    return result;
  }

  // List / headerless: a line with a delimiter after a valid URL is a positional row.
  const firstUrl = bodyLines.find(isHttpUrl);
  const positional = firstUrl != null && bodyLines.some(l => {
    const parts = l.split(/[,\t;]/);
    return parts.length > 1 && isHttpUrl(parts[0]);
  });

  for (const line of bodyLines) {
    const fields = line.split(/[,\t;]/).map(p => p.trim());
    if (positional && fields.length > 1 && isHttpUrl(fields[0])) {
      const map: Partial<Record<ImportColumn, string>> = {};
      POSITIONAL_COLUMNS.forEach((col, i) => {
        if (i > 0 && fields[i]) map[col] = fields[i];
      });
      pushRow(makeRow(fields[0], map));
      continue;
    }
    if (isHttpUrl(line)) {
      pushRow(makeRow(line, {}));
      continue;
    }
    // A bare word ("donor.ru") is not a valid donor entry — counted so the preview can say why.
    result.skippedRows += 1;
  }

  if (positional) {
    const width = Math.min(
      POSITIONAL_COLUMNS.length,
      Math.max(...bodyLines.filter(l => l.split(/[,\t;]/).length > 1 && isHttpUrl(l.split(/[,\t;]/)[0])).map(l => l.split(/[,\t;]/).length)),
    );
    result.columns = POSITIONAL_COLUMNS.slice(0, width).map(c => CANONICAL_LABEL[c]);
  } else {
    result.columns = ["url"];
  }
  return result;
}

// ─── Import plan against existing rows ─────────────────────────────────────────
//
// Enforces the write rule from CONTRACT §1 with types, not discipline: the plan's update
// payload can only carry operator-group fields (urlTo/sources/note/priceNote), so the
// route physically cannot clobber api*/check* results the user already paid for.

export interface ExistingBacklinkRow {
  id: string;
  urlNorm: string;
  urlTo: string;
  sources: string[];
  note: string;
  priceNote: string;
}

export interface ImportCreate {
  urlFrom: string;
  urlFromNorm: string;
  urlTo: string;
  domainFrom: string;
  source: "csv" | "manual";
  sources: string;
  note: string;
  priceNote: string;
}

export interface ImportUpdate {
  id: string;
  sources?: string;
  urlTo?: string;
  note?: string;
  priceNote?: string;
}

export interface ImportPlan {
  creates: ImportCreate[];
  updates: ImportUpdate[];
}

/**
 * Matching rule (T5 spec): a row that already exists is not created again — its `sources`
 * gains the import origin, and `urlTo` is filled only where it was empty. Optional operator
 * fields (note, priceNote) follow the same fill-if-empty rule: a re-import of the same file
 * is a no-op, never an overwrite of what the operator wrote by hand.
 *
 * When several existing rows share the donor page (same urlFromNorm, different targets —
 * Ahrefs can legitimately report two), the import attaches to the row whose urlTo matches;
 * failing that, to the one with no target yet; failing that, to the first. It never merges
 * two existing rows into one.
 */
export function buildImportPlan(
  parsed: ImportParseResult,
  existing: ExistingBacklinkRow[],
  origin: "csv" | "manual",
): ImportPlan {
  const byNorm = new Map<string, ExistingBacklinkRow[]>();
  for (const row of existing) {
    const list = byNorm.get(row.urlNorm);
    if (list) list.push(row);
    else byNorm.set(row.urlNorm, [row]);
  }

  const plan: ImportPlan = { creates: [], updates: [] };
  const touched = new Set<string>();

  for (const row of parsed.rows) {
    const candidates = byNorm.get(row.urlNorm) ?? [];
    if (candidates.length === 0) {
      plan.creates.push({
        urlFrom: row.url,
        urlFromNorm: row.urlNorm,
        urlTo: row.targetUrl,
        domainFrom: row.domain,
        source: origin,
        sources: origin,
        note: row.note,
        priceNote: row.price,
      });
      continue;
    }

    const targetNorm = normalizeBacklinkUrl(row.targetUrl);
    const match =
      (targetNorm && candidates.find(c => normalizeBacklinkUrl(c.urlTo) === targetNorm)) ||
      candidates.find(c => !c.urlTo) ||
      candidates[0];
    if (touched.has(match.id)) continue; // two import rows hit one existing row — first wins

    const sources = match.sources.includes(origin)
      ? undefined
      : [...match.sources, origin].join(",");
    const urlTo = !match.urlTo && row.targetUrl ? row.targetUrl : undefined;
    const note = !match.note && row.note ? row.note : undefined;
    const priceNote = !match.priceNote && row.price ? row.price : undefined;
    if (sources || urlTo || note || priceNote) {
      plan.updates.push({ id: match.id, ...(sources && { sources }), ...(urlTo && { urlTo }), ...(note && { note }), ...(priceNote && { priceNote }) });
    }
    touched.add(match.id);
  }

  return plan;
}

// ─── List-query building (GET / DELETE share the filter object) ────────────────

export interface BacklinkQueryFilters {
  status?: string;   // unchecked | found | missing | blocked | error
  rel?: string;      // dofollow | nofollow
  source?: string;   // api | csv | manual
  domain?: string;
  drMin?: number;
  drMax?: number;
  favorite?: boolean;
  lost?: boolean;
}

const PLACEMENT_STATUSES = ["unchecked", "found", "missing", "blocked", "error"];
const BACKLINK_SOURCES = ["api", "csv", "manual"];

/** rel is authoritative from our own check when it found the link; otherwise Ahrefs' flags
 *  are the only opinion that exists. One rule, used by the filter, the stats and the cell
 *  rendering, so the three can never disagree. The api side reads the same fields the wire
 *  type exposes (apiDofollow/apiSponsored/apiUgc) — apiNofollow is admitted too because it
 *  costs one clause and defends against a writer that sets only it. */
const nofollowCondition = {
  OR: [
    { AND: [{ checkStatus: "found" }, { OR: [{ checkNofollow: true }, { checkSponsored: true }, { checkUgc: true }] }] },
    { AND: [{ checkStatus: { not: "found" } }, { OR: [{ apiNofollow: true }, { apiDofollow: false }, { apiSponsored: true }, { apiUgc: true }] }] },
  ],
};

export function parseBacklinkFilters(sp: URLSearchParams): BacklinkQueryFilters & { ok: true } | { ok: false; error: string } {
  const f: BacklinkQueryFilters = {};
  const status = sp.get("status");
  if (status && !PLACEMENT_STATUSES.includes(status)) return { ok: false, error: `unknown status: ${status}` };
  if (status) f.status = status;

  const rel = sp.get("rel");
  if (rel && rel !== "dofollow" && rel !== "nofollow") return { ok: false, error: `unknown rel: ${rel}` };
  if (rel) f.rel = rel;

  const source = sp.get("source");
  if (source && !BACKLINK_SOURCES.includes(source)) return { ok: false, error: `unknown source: ${source}` };
  if (source) f.source = source;

  const domain = (sp.get("domain") ?? "").trim().toLowerCase();
  if (domain) f.domain = domain;

  for (const [key, dest] of [["drMin", "drMin"], ["drMax", "drMax"]] as const) {
    const raw = sp.get(key);
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
    f[dest] = n;
  }

  f.favorite = sp.get("favorite") === "1" || sp.get("favorite") === "true";
  f.lost = sp.get("lost") === "1" || sp.get("lost") === "true";
  return { ok: true, ...f };
}

export function buildBacklinkWhere(siteId: string, f: BacklinkQueryFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { siteId };
  if (f.status) where.checkStatus = f.status;
  if (f.source) where.sources = { contains: f.source };
  if (f.domain) where.domainFrom = { contains: f.domain };
  if (f.drMin != null || f.drMax != null) {
    where.apiDr = {
      ...(f.drMin != null && { gte: f.drMin }),
      ...(f.drMax != null && { lte: f.drMax }),
    };
  }
  if (f.favorite) where.favorite = true;
  if (f.lost) where.apiLost = true;
  if (f.rel === "nofollow") return { AND: [where, nofollowCondition] };
  if (f.rel === "dofollow") return { AND: [where, { NOT: nofollowCondition }] };
  return where;
}

/** Same condition as the rel filter, so the stats' nofollow count matches what the filter
 *  selects — exposed separately because stats need it as a count, not as a filter. */
export const nofollowFilterCondition = nofollowCondition;

const SORTS: Record<string, Record<string, "asc" | "desc">[]> = {
  dr_desc: [{ apiDr: "desc" }],
  dr_asc: [{ apiDr: "asc" }],
  first_seen_desc: [{ apiFirstSeen: "desc" }],
  first_seen_asc: [{ apiFirstSeen: "asc" }],
  last_seen_desc: [{ apiLastSeen: "desc" }],
  last_seen_asc: [{ apiLastSeen: "asc" }],
  checked_desc: [{ checkedAt: "desc" }],
  checked_asc: [{ checkedAt: "asc" }],
  added_desc: [{ addedAt: "desc" }],
  added_asc: [{ addedAt: "asc" }],
  domain_asc: [{ domainFrom: "asc" }],
  domain_desc: [{ domainFrom: "desc" }],
};

export function parseBacklinkSort(sp: URLSearchParams): Record<string, "asc" | "desc">[] {
  // `apiDr` is nullable and SQL NULLs sort as smallest: on DESC they land last (right), on
  // ASC they land first — the UI therefore only offers _desc for DR.
  // `apiFirstSeen`/`apiLastSeen` are "YYYY-MM-DD" strings, which sort chronologically as
  // bytes; "" sorts below every date, so undated rows sink in DESC.
  const key = sp.get("sort") ?? "added_desc";
  const order = SORTS[key] ?? SORTS.added_desc;
  return [...order, { id: "desc" }]; // stable page boundaries whatever the tiebreak
}
