// Ручные вердикты: то, что проверено снаружи и приносится обратно в каталог.
//
// Нужно ровно там, где встроенная проверка бессильна: у зоны нет ни RDAP, ни живого публичного
// WHOIS (`.gr`), и единственный источник правды — панель регистратора или веб-форма реестра,
// которую пользователь гоняет своим инструментом (у Руслана это ZennoPoster). Приложение отдаёт
// список доменов, получает обратно вердикты и кладёт их в те же поля, что и обычная проверка.
//
// Один принцип отсюда не убирается: ручной вердикт НИКОГДА не помечается corroborated. Он
// приехал из одного источника, и весь модуль построен на том, что одного источника мало.

import { normaliseDomain } from "./ingest";

export type ManualVerdict = "available" | "registered";

export interface ManualRow {
  domain: string;
  verdict: ManualVerdict;
}

export interface ManualParseResult {
  rows: ManualRow[];
  /** Строки, которые не разобрались, с причиной — отчёт пользователю, а не тишина. */
  skipped: { value: string; reason: "no_domain" | "no_verdict" | "conflict" }[];
}

/**
 * Слова, которыми инструменты и люди обозначают «свободен» и «занят».
 *
 * Список нарочно широкий и на нескольких языках: файл приезжает из чужого шаблона, и заставлять
 * человека переименовывать колонку под нас — это лишний шаг, на котором он ошибётся. Чего здесь
 * нет намеренно: голых `1`/`0` и `yes`/`no` без слова рядом — они с равным успехом значат и то
 * и другое, и угадывать тут нельзя.
 */
const FREE = new Set([
  "available", "free", "unregistered", "not registered", "no match", "not found",
  "свободен", "свободно", "свободный", "доступен", "вільний", "вільно",
]);
const TAKEN = new Set([
  "registered", "taken", "busy", "unavailable", "occupied", "active",
  "занят", "занято", "занятый", "недоступен", "зайнятий", "зайнято",
]);

const norm = (s: string) => s.trim().toLowerCase().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");

/** Вердикт из ячейки, или `null` если это не вердикт. */
export function parseVerdictCell(cell: string): ManualVerdict | null {
  const v = norm(cell);
  if (!v) return null;
  if (FREE.has(v)) return "available";
  if (TAKEN.has(v)) return "registered";
  return null;
}

/**
 * Разбор возвращённого файла.
 *
 * Формат не навязывается: в строке ищется поле-домен и поле-вердикт, в любом порядке и с любым
 * из обычных разделителей. Строка без вердикта отбрасывается, а не считается «свободной» —
 * молчание инструмента это отсутствие ответа, и превращать его в «можно покупать» нельзя.
 */
export function parseManualVerdicts(raw: string): ManualParseResult {
  const rows: ManualRow[] = [];
  const skipped: ManualParseResult["skipped"] = [];
  const seen = new Map<string, ManualVerdict>();

  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const fields = trimmed.split(/[,;\t|]/).map(f => f.trim()).filter(Boolean);
    let domain: string | null = null;
    let verdict: ManualVerdict | null = null;
    for (const field of fields.length ? fields : [trimmed]) {
      if (!verdict) {
        const v = parseVerdictCell(field);
        if (v) { verdict = v; continue; }
      }
      if (!domain) {
        const d = normaliseDomain(field);
        if ("domain" in d) domain = d.domain;
      }
    }

    if (!domain) { skipped.push({ value: trimmed.slice(0, 120), reason: "no_domain" }); continue; }
    if (!verdict) { skipped.push({ value: domain, reason: "no_verdict" }); continue; }

    const already = seen.get(domain);
    if (already && already !== verdict) {
      // Один домен назван и свободным, и занятым. Взять любой из двух — значит выбрать наугад
      // в единственном месте, где ошибка стоит денег: строка выбрасывается целиком.
      skipped.push({ value: domain, reason: "conflict" });
      seen.set(domain, verdict);
      const at = rows.findIndex(r => r.domain === domain);
      if (at >= 0) rows.splice(at, 1);
      continue;
    }
    if (already) continue;
    seen.set(domain, verdict);
    rows.push({ domain, verdict });
  }

  // Домен, попавший в конфликт, не должен вернуться в результат из более ранней строки.
  const conflicted = new Set(skipped.filter(s => s.reason === "conflict").map(s => s.value));
  return { rows: rows.filter(r => !conflicted.has(r.domain)), skipped };
}
