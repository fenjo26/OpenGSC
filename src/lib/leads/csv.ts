// N9 — CSV export of the lead inbox.
//
// Cells can end up in a spreadsheet, and a lead's domain or e-mail field is attacker-
// controlled text, so every cell is defended against the CSV/formula injection family:
// a leading = + - @ (or tab/CR) turns the value into a formula in Excel and Google Sheets.
// The defence is the OWASP-recommended one — prefix the character with a single quote.

import type { LeadFull, LeadLang } from "./types";

const CSV_COLUMNS = ["date", "domain", "email", "name", "score", "status", "source", "origin", "top_issues"] as const;

/** One CSV cell: formula-guard first, then RFC 4180 quoting. */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  const raw = value instanceof Date ? value.toISOString().slice(0, 19).replace("T", " ") : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",;\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function leadsToCsv(leads: Array<Partial<LeadFull>>, lang: LeadLang = "en"): string {
  void lang; // column headers are stable English by design — CRM imports should not depend on the UI language
  const rows = [CSV_COLUMNS.join(",")];
  for (const lead of leads) {
    const top = Array.isArray(lead.top) ? lead.top.join("; ") : "";
    rows.push([
      csvCell(lead.createdAt ? new Date(lead.createdAt).toISOString().slice(0, 19).replace("T", " ") : ""),
      csvCell(lead.domain),
      csvCell(lead.email),
      csvCell(lead.name),
      csvCell(lead.score),
      csvCell(lead.status),
      csvCell(lead.source),
      csvCell(lead.origin),
      csvCell(top),
    ].join(","));
  }
  return rows.join("\r\n") + "\r\n";
}
