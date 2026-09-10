// Turning whatever the user pasted into a clean, deduplicated domain list.
//
// This is the first stage of the funnel and the only one that can quietly poison every stage
// after it. The source post's author found 11 rows in his CSV that were IP addresses, not
// domains — they went through his whole pipeline and came out as "free", because no registry
// has a record for 192.0.2.1. Every rejection below is a row that would otherwise have become a
// confident wrong answer downstream.

import { apexOf } from "./registries";

export type SkipReason =
  | "empty"
  | "ip_address"
  | "no_dot"
  | "bad_characters"
  | "bad_label"
  | "too_long"
  | "not_registrable"
  | "duplicate";

export interface IngestResult {
  /** Normalised, deduplicated, in first-seen order. */
  domains: string[];
  skipped: { value: string; reason: SkipReason }[];
}

/**
 * 191, not the 253 the DNS spec allows — and since `apexOf` the stored value (suffix plus one
 * label) can never get near it anyway. The cap is the sanitation gate on a raw row: a list has
 * no business carrying a 200-character name, and rejecting it costs nothing real. (History:
 * `domain` is half of `DropCandidate`'s composite unique key, which MySQL maps to VARCHAR(191);
 * apex reduction removed the write-time hazard, the gate stays.)
 */
const MAX_DOMAIN_LENGTH = 191;
const MAX_LABEL_LENGTH = 63;

/** IPv4 in dotted form, and anything with a colon (IPv6, or host:port we already stripped). */
function looksLikeIp(host: string): boolean {
  if (host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * One row to a bare host, or `null` with a reason.
 *
 * Accepts what real lists contain: full URLs, `www.` prefixes and other hosts (each row is
 * reduced to its registrable apex — registries answer host-shaped questions with "no match",
 * which reads as free), trailing dots, ports, upper case, surrounding quotes and whitespace.
 * Punycode and Unicode both pass through unchanged — the checker canonicalises IDN later, and
 * converting here would make two spellings of one name look like two candidates.
 */
export function normaliseDomain(input: string): { domain: string } | { reason: SkipReason } {
  let value = (input ?? "").trim().replace(/^["'<]+|["'>,;]+$/g, "").trim();
  if (!value) return { reason: "empty" };

  // Strip a scheme and everything from the first path separator on.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  value = value.split(/[/?#\\]/)[0];
  // Credentials, then port.
  value = value.split("@").pop() as string;
  value = value.replace(/:\d+$/, "");
  value = value.trim().toLowerCase().replace(/\.$/, "");

  if (!value) return { reason: "empty" };
  if (looksLikeIp(value)) return { reason: "ip_address" };
  if (value.length > MAX_DOMAIN_LENGTH) return { reason: "too_long" };
  // Character check before the dot check, and the order matters for the report the user reads:
  // "not a domain at all" is bad_characters, not "a domain that forgot its dot".
  if (/[^a-z0-9.\-¡-￿]/.test(value)) return { reason: "bad_characters" };
  if (!value.includes(".")) return { reason: "no_dot" };

  const labels = value.split(".");
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH) return { reason: "bad_label" };
    if (label.startsWith("-") || label.endsWith("-")) return { reason: "bad_label" };
  }

  // A host row ("www.example.com", "blog.example.co.uk", a crawler outlink) is reduced to the
  // name a person could register. Kept as-is it is worse than noise: registries answer
  // host-shaped questions with "no match", which the funnel would corroborate into a false
  // "available" on a domain somebody owns. "co.uk" alone never forms an apex — rejected above.
  const apex = apexOf(value);
  if (!apex) return { reason: "not_registrable" };

  return { domain: apex };
}

/**
 * A pasted blob or CSV to a candidate list.
 *
 * CSV handling is deliberately dumb: split each line on the usual separators and take the first
 * field that normalises to a domain. Column headers vary by source and a fixed index would break
 * on the next export; "the field that looks like a domain" survives reordering.
 */
export function parseDomainList(raw: string): IngestResult {
  const domains: string[] = [];
  const skipped: IngestResult["skipped"] = [];
  const seen = new Set<string>();

  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A header row names columns and contains no domain; it falls out naturally below.
    const fields = trimmed.split(/[,;\t|]/).map(f => f.trim()).filter(Boolean);
    const candidates = fields.length ? fields : [trimmed];

    let accepted = false;
    let lastReason: SkipReason = "empty";
    for (const field of candidates) {
      const res = normaliseDomain(field);
      if ("reason" in res) { lastReason = res.reason; continue; }
      if (seen.has(res.domain)) { skipped.push({ value: res.domain, reason: "duplicate" }); accepted = true; break; }
      seen.add(res.domain);
      domains.push(res.domain);
      accepted = true;
      break;
    }
    if (!accepted) skipped.push({ value: trimmed, reason: lastReason });
  }

  return { domains, skipped };
}

/** Counts per reason, for the "54 rows dropped, here is why" line above the import. */
export function summariseSkips(skipped: IngestResult["skipped"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}

// ─── Табличные выгрузки: Ahrefs и всё, что на них похоже ─────────────────────
//
// `parseDomainList` выше берёт первое поле строки, похожее на домен. Для пасты «просто список»
// это правильно, а для выгрузки Ahrefs — катастрофа: в экспорте Outgoing links колонка-источник
// (`Referring page URL`) стоит РАНЬШЕ колонки-цели (`Target URL`), поэтому весь файл на 143 000
// строк схлопывается в один домен — саму площадку-донора. Плюс наивный split по разделителям
// рвёт строку на анкоре с запятой внутри кавычек, а DR, который в выгрузке уже есть, теряется —
// и потом покупается у Ahrefs заново по $0.00125 за домен.

/** Одна распознанная строка выгрузки. */
export interface ParsedRow {
  domain: string;
  /** Domain Rating из файла, 0–100. Переносится в кандидата и экономит платное обогащение. */
  dr?: number;
  refdomains?: number;
}

/** Какие колонки использованы. `null` — не нашлась. Индексы, чтобы UI мог их переопределить. */
export interface ColumnMap {
  header: string[];
  domain: number | null;
  dr: number | null;
  refdomains: number | null;
  /** false — заголовок не опознан, разбор откатился на «первое поле, похожее на домен». */
  detected: boolean;
  delimiter: string;
}

export interface RowsResult {
  rows: ParsedRow[];
  skipped: { value: string; reason: SkipReason }[];
  columns: ColumnMap;
}

/**
 * Заголовки, по которым узнаётся колонка с ИСКОМЫМ доменом, в порядке убывания приоритета.
 *
 * Порядок здесь — вся суть. `target url` обязан выиграть у `referring page url`, иначе в
 * каталог поедет донор вместо целей. Точное совпадение проверяется раньше вхождения по той же
 * причине: `referring page url` содержит `url`.
 */
const DOMAIN_HEADERS = [
  "target url", "target", "linked domain", "linked domains", "referring domain",
  "referring domains url", "domain", "website", "site", "url",
];
/** Заголовки, которые НИКОГДА не берутся под домен, даже если подходят по вхождению. */
const DOMAIN_HEADER_DENY = ["referring page url", "referring page title", "source url", "anchor"];
const DR_HEADERS = ["domain rating", "target dr", "dr of target", "dr", "domain rating (dr)"];
const REF_HEADERS = ["referring domains", "ref domains", "refdomains", "referring domains (dofollow)"];

/**
 * Разделитель по первой непустой строке: тот, что встречается вне кавычек чаще прочих.
 * Табуляция идёт первой в списке — Ahrefs по умолчанию отдаёт TSV, и запятая в анкоре не должна
 * его перевесить.
 */
export function detectDelimiter(raw: string): string {
  const line = (raw ?? "").split(/\r?\n/).find(l => l.trim()) ?? "";
  let best = "\t";
  let bestCount = -1;
  for (const d of ["\t", ",", ";", "|"]) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return bestCount > 0 ? best : "\t";
}

/**
 * Разбор с уважением к кавычкам (RFC 4180): `""` внутри поля — одна кавычка, перевод строки
 * внутри кавычек не заканчивает запись. Анкоры в выгрузках Ahrefs содержат и то и другое.
 */
export function parseDelimited(raw: string, delimiter: string): string[][] {
  const text = (raw ?? "").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let touched = false;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    endField();
    if (touched || row.some(f => f.trim())) rows.push(row);
    row = [];
    touched = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; touched = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { endRow(); continue; }
    field += ch;
  }
  if (field || row.length) endRow();
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");

/** Индекс колонки по списку синонимов: сначала точное совпадение, потом вхождение. */
function pickColumn(header: string[], wanted: string[], deny: string[] = []): number | null {
  const cells = header.map(norm);
  const blocked = (i: number) => deny.some(d => cells[i] === d || cells[i].includes(d));
  for (const w of wanted) {
    const exact = cells.findIndex((c, i) => c === w && !blocked(i));
    if (exact >= 0) return exact;
  }
  for (const w of wanted) {
    const partial = cells.findIndex((c, i) => c.includes(w) && !blocked(i));
    if (partial >= 0) return partial;
  }
  return null;
}

/** «31», «3.4», «1,5», «1 234» → число. Всё остальное → undefined. */
function parseNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  let v = value.trim().replace(/^["']|["']$/g, "").replace(/[\s ]/g, "");
  if (!v) return undefined;
  // Запятая как десятичный разделитель — только если точки нет и справа от неё не три цифры
  // (иначе это разделитель тысяч).
  if (!v.includes(".") && /^-?\d+,\d{1,2}$/.test(v)) v = v.replace(",", ".");
  v = v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const clampDr = (n: number | undefined) =>
  n == null ? undefined : Math.min(100, Math.max(0, n));

/**
 * Табличная выгрузка → строки с доменом и метриками.
 *
 * `override` приходит из UI, когда пользователь выбрал колонки руками: заголовки экспортов
 * меняются, и фиксированный список синонимов однажды промахнётся — тогда решает человек, а не
 * молчаливый откат.
 */
export function parseDomainRows(
  raw: string,
  override: { domain?: number; dr?: number; refdomains?: number } = {},
): RowsResult {
  const delimiter = detectDelimiter(raw);
  const table = parseDelimited(raw, delimiter);
  const skipped: RowsResult["skipped"] = [];
  const rows: ParsedRow[] = [];
  const byDomain = new Map<string, ParsedRow>();

  if (!table.length) {
    return {
      rows, skipped,
      columns: { header: [], domain: null, dr: null, refdomains: null, detected: false, delimiter },
    };
  }

  const first = table[0];
  const headerLooksLikeHeader = first.some(c => /[a-z]/i.test(c)) && !first.some(c => "domain" in normaliseDomain(c));
  const header = headerLooksLikeHeader ? first : [];

  const domainCol = override.domain ?? (header.length ? pickColumn(header, DOMAIN_HEADERS, DOMAIN_HEADER_DENY) : null);
  const drCol = override.dr ?? (header.length ? pickColumn(header, DR_HEADERS) : null);
  const refCol = override.refdomains ?? (header.length ? pickColumn(header, REF_HEADERS) : null);
  const detected = domainCol != null;

  const body = headerLooksLikeHeader ? table.slice(1) : table;

  for (const cells of body) {
    if (!cells.some(c => c.trim())) continue;

    // Колонка не опознана — прежнее поведение: первое поле, похожее на домен. Честно помечено
    // в `columns.detected`, чтобы UI мог предложить выбрать колонку руками.
    let value = domainCol != null ? cells[domainCol] : undefined;
    let res = value != null ? normaliseDomain(value) : ({ reason: "empty" } as const);
    if (domainCol == null) {
      let lastReason: SkipReason = "empty";
      let found: { domain: string } | null = null;
      for (const cell of cells) {
        const r = normaliseDomain(cell);
        if ("domain" in r) { found = r; break; }
        lastReason = r.reason;
      }
      res = found ?? { reason: lastReason };
      value = cells.find(c => c.trim()) ?? "";
    }

    if ("reason" in res) {
      skipped.push({ value: (value ?? "").trim().slice(0, 200), reason: res.reason });
      continue;
    }

    const dr = clampDr(drCol != null ? parseNumber(cells[drCol]) : undefined);
    const refdomains = refCol != null ? parseNumber(cells[refCol]) : undefined;

    const seen = byDomain.get(res.domain);
    if (seen) {
      // Один домен встречается в выгрузке многократно (много ссылок на него). Метрику держим
      // максимальную: пустая ячейка в одной из строк не должна затирать заполненную в другой.
      if (dr != null && (seen.dr == null || dr > seen.dr)) seen.dr = dr;
      if (refdomains != null && (seen.refdomains == null || refdomains > seen.refdomains)) {
        seen.refdomains = refdomains;
      }
      skipped.push({ value: res.domain, reason: "duplicate" });
      continue;
    }

    const row: ParsedRow = { domain: res.domain };
    if (dr != null) row.dr = dr;
    if (refdomains != null) row.refdomains = refdomains;
    byDomain.set(res.domain, row);
    rows.push(row);
  }

  return {
    rows, skipped,
    columns: { header, domain: domainCol, dr: drCol, refdomains: refCol, detected, delimiter },
  };
}
