import { workspaceUserId } from "@/lib/team/workspace";
import { listCandidates, parseCandidateFilter, schemaMissing, type CandidateSortField } from "@/lib/drops/store";

export const dynamic = "force-dynamic";

const SORT_FIELDS: CandidateSortField[] = ["score", "createdAt", "domain", "dr", "refdomains", "snapshots", "checkedAt", "tf"];

/**
 * The catalogue as a CSV, under the same filter the table is showing.
 *
 * Server-side and paged rather than "serialise what the browser has": the point of the export is
 * the whole selection, and the table only ever holds one page of it. Capped so a runaway filter
 * cannot build a 50 000-row string in memory and time the request out — the cap is reported in
 * the file itself rather than silently truncating.
 */
const PAGE = 500;
const MAX_ROWS = 20_000;

/** RFC 4180: quote when the value could otherwise break the row, and double the quotes inside. */
function cell(value: unknown): string {
  if (value == null) return "";
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS: [header: string, pick: (r: Record<string, unknown>) => unknown][] = [
  ["domain", r => r.domain],
  ["stage", r => r.stage],
  ["corroborated", r => (r.stage === "available" ? (r.corroborated ? "yes" : "no") : "")],
  ["dr", r => r.dr],
  ["refdomains", r => r.refdomainsDofollow ?? r.refdomains],
  ["majestic_tf", r => r.majesticTf],
  ["majestic_cf", r => r.majesticCf],
  ["wayback_snapshots", r => r.waybackSnapshots],
  ["wayback_gap_days", r => r.waybackGapDays],
  ["score", r => r.score],
  ["group", r => r.groupName],
  ["tld", r => r.tld],
  ["checked_at", r => r.lastCheckedAt],
];

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const p = new URL(req.url).searchParams;
    const orderBy = p.get("orderBy");
    const filter = parseCandidateFilter(Object.fromEntries(p.entries()));

    // `format=list` is the shape an external checker eats: one domain per line, nothing else.
    // The same filter as the CSV, so "export what the table is showing" means one thing.
    const asList = p.get("format") === "list";
    const lines = asList ? [] : [COLUMNS.map(c => c[0]).join(",")];
    let offset = 0;
    let truncated = false;
    for (;;) {
      const page = await listCandidates(userId, {
        ...filter,
        limit: PAGE,
        offset,
        orderBy: SORT_FIELDS.includes(orderBy as CandidateSortField) ? (orderBy as CandidateSortField) : "score",
        orderDir: p.get("order") === "asc" ? "asc" : "desc",
      });
      const rows = (page.rows ?? []) as Record<string, unknown>[];
      for (const r of rows) lines.push(asList ? String(r.domain) : COLUMNS.map(c => cell(c[1](r))).join(","));
      offset += rows.length;
      if (rows.length < PAGE || offset >= Math.min(page.total ?? 0, MAX_ROWS)) {
        truncated = (page.total ?? 0) > MAX_ROWS;
        break;
      }
    }
    // Said in the file, not swallowed: an export that quietly stops at 20 000 rows is a wrong
    // answer that looks like a right one.
    if (truncated) lines.push(`# truncated at ${MAX_ROWS} rows — narrow the filter for the rest`);

    const stamp = new Date().toISOString().slice(0, 10);
    // No BOM on the plain list: it is machine input, and a stray U+FEFF becomes part of the
    // first domain in every parser that does not strip it.
    const body = asList ? `${lines.join("\r\n")}\r\n` : `﻿${lines.join("\r\n")}\r\n`;
    return new Response(body, {
      headers: {
        "content-type": asList ? "text/plain; charset=utf-8" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="drops-${stamp}.${asList ? "txt" : "csv"}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (schemaMissing(e)) return new Response("drops_not_migrated", { status: 503 });
    return new Response("Internal Server Error", { status: 500 });
  }
}
