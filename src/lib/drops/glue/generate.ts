import type { GlueAlternate, GlueNote, GluePage, GluePlan, GlueSpec } from "./types";
import { baseLanguage, canonicalKey, checkLocale, isAbsolute, normalise, sameUrl } from "./locale";

/**
 * Every note code buildGluePlan can attach to a plan. The UI renders these as
 * `dropsGlueNote_<code>` locale keys; codes.test.ts pins the key set to this list.
 */
export const KNOWN_GLUE_NOTES = [
  "locale_fixed",
  "locale_invalid",
  "locale_duplicate",
  "no_alternates",
  "xdefault_outside_cluster",
  "url_not_absolute",
  "url_invalid",
  "funnel_mode",
] as const;

export type GlueNoteCode = (typeof KNOWN_GLUE_NOTES)[number];

/**
 * Строит одинаковый для всего кластера набор аннотаций и раскладывает его по страницам.
 *
 * Инвариант: набор alternate одинаков на каждой странице кластера и включает саму
 * страницу — без self-ссылки Google игнорирует всю группу. Различаются между
 * страницами только <html lang> и, в режиме cluster, цель canonical.
 */
export function buildGluePlan(spec: GlueSpec): GluePlan {
  const notes: GlueNote[] = [];

  const dropUrl = requireAbsolute(spec.dropUrl, "dropUrl", notes);
  const xDefault = spec.xDefault ? requireAbsolute(spec.xDefault, "xDefault", notes) : dropUrl;

  const seen = new Map<string, string>();
  const alternates: GlueAlternate[] = [];

  for (const alt of spec.alternates) {
    const check = checkLocale(alt.hreflang);
    let code = check.value;

    if (check.suggestion && check.suggestion !== "x-default") {
      code = check.suggestion;
      notes.push({
        code: "locale_fixed",
        severity: "warn",
        detail: `${alt.hreflang} → ${code}${check.reason ? ` (${check.reason})` : ""}`,
      });
    } else if (!check.valid) {
      notes.push({
        code: "locale_invalid",
        severity: "blocker",
        detail: `${alt.hreflang}${check.reason ? `: ${check.reason}` : ""}`,
      });
      continue;
    } else {
      code = normalise(code);
    }

    const url = requireAbsolute(alt.url, `alternate ${code}`, notes);
    if (!url) continue;

    const prev = seen.get(code);
    if (prev) {
      notes.push({
        code: "locale_duplicate",
        severity: "blocker",
        detail: `${code} указан дважды: ${prev} и ${url}; Google игнорирует всю группу`,
      });
      continue;
    }
    seen.set(code, url);
    alternates.push({ hreflang: code, url });
  }

  if (!alternates.length) {
    notes.push({ code: "no_alternates", severity: "blocker", detail: "не осталось ни одной локали" });
  }

  // Дроп участвует в кластере как x-default. Если x-default совпадает с одной из
  // локалей, отдельная строка для дропа не нужна — иначе Google видит URL без self-ссылки.
  const dropInSet = alternates.some((a) => sameUrl(a.url, xDefault));
  if (!dropInSet && !sameUrl(xDefault, dropUrl)) {
    notes.push({
      code: "xdefault_outside_cluster",
      severity: "warn",
      detail: "x-default ведёт на URL, которого нет среди alternate — страница выпадает из группы",
    });
  }

  const dropHtmlLang =
    spec.dropHtmlLang?.trim() ||
    (alternates[0] ? baseLanguage(alternates[0].hreflang) : "en");

  const pages: GluePage[] = [];

  pages.push(
    makePage({
      role: "drop",
      url: dropUrl,
      htmlLang: normaliseLangAttr(dropHtmlLang),
      canonical: dropUrl, // дроп каноничен сам себе в обоих режимах
      alternates,
      xDefault,
    }),
  );

  for (const alt of alternates) {
    if (sameUrl(alt.url, dropUrl)) continue; // дроп уже добавлен
    pages.push(
      makePage({
        role: "money",
        url: alt.url,
        htmlLang: alt.hreflang,
        canonical: spec.mode === "funnel" ? dropUrl : alt.url,
        alternates,
        xDefault,
      }),
    );
  }

  if (spec.mode === "funnel") {
    notes.push({
      code: "funnel_mode",
      severity: "info",
      detail:
        "канoникал мани-страниц ведёт наружу, на дроп: сигналы сливаются в дроп, " +
        "но контроль над кластером — у владельца дропа, и это отклонение от рекомендаций Google",
    });
  }

  return { mode: spec.mode, pages, notes };
}

function makePage(p: Omit<GluePage, "head">): GluePage {
  const lines: string[] = [];
  lines.push(`<link rel="canonical" href="${esc(p.canonical)}" />`);
  for (const alt of p.alternates) {
    lines.push(`<link rel="alternate" hreflang="${esc(alt.hreflang)}" href="${esc(alt.url)}" />`);
  }
  lines.push(`<link rel="alternate" hreflang="x-default" href="${esc(p.xDefault)}" />`);
  return { ...p, head: lines.join("\n") };
}

function requireAbsolute(value: string, label: string, notes: GlueNote[]): string {
  const v = (value ?? "").trim();
  if (!isAbsolute(v)) {
    notes.push({
      code: "url_not_absolute",
      severity: "blocker",
      detail: `${label}: hreflang и canonical принимают только абсолютные URL со схемой (${v || "пусто"})`,
    });
    return v;
  }
  try {
    return new URL(v).toString();
  } catch {
    notes.push({ code: "url_invalid", severity: "blocker", detail: `${label}: ${v}` });
    return v;
  }
}

function normaliseLangAttr(code: string): string {
  const c = checkLocale(code);
  return c.suggestion && c.suggestion !== "x-default" ? c.suggestion : c.value;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Ключи страниц плана — то, что валидатор пойдёт проверять. */
export function pageKeys(plan: GluePlan): string[] {
  return plan.pages.map((p) => canonicalKey(p.url));
}
