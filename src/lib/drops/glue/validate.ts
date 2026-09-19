import type { Finding, GlueMode, GluePlan, GlueReport, PageFacts, Severity } from "./types";
import { hasNoindex } from "./parse";
import { canonicalKey, checkLocale, sameUrl } from "./locale";

/**
 * Every finding code this module can emit, plus `cloaked_annotations`, which the UA-diff
 * in fetchPages.ts folds into a finished report. The UI translates these 1:1 as
 * `dropsGlueFinding_<code>` locale keys; codes.test.ts fails when the two lists drift
 * apart, and typing the emit helpers with GlueFindingCode makes the compiler hold the
 * same line at every add() call site.
 */
export const KNOWN_GLUE_FINDINGS = [
  "fetch_failed",
  "page_dead",
  "page_redirected",
  "noindex",
  "canonical_missing",
  "canonical_relative",
  "canonical_multiple",
  "canonical_to_dead",
  "canonical_to_noindex",
  "canonical_chain",
  "hreflang_missing",
  "hreflang_relative",
  "hreflang_invalid_code",
  "hreflang_duplicate_code",
  "hreflang_target_dead",
  "hreflang_target_noindex",
  "hreflang_not_reciprocal",
  "hreflang_to_noncanonical",
  "hreflang_no_self",
  "xdefault_missing",
  "xdefault_multiple",
  "page_not_checked",
  "canonical_mismatch",
  "lang_attr_mismatch",
  "lang_attr_missing",
  "alternates_mismatch",
  "cloaked_annotations",
] as const;

export type GlueFindingCode = (typeof KNOWN_GLUE_FINDINGS)[number];

/**
 * Проверяет живые страницы кластера. Чистая функция: сеть уже отработала,
 * на вход идут разобранные факты (см. parsePage).
 *
 * plan — необязателен. Без него проверяются только внутренние правила кластера
 * (взаимность, self-ссылка, x-default, noindex, мёртвые цели). С планом
 * дополнительно сверяется, что на сервере лежит то, что было сгенерировано.
 */
export function validateCluster(
  pages: PageFacts[],
  opts: { mode: GlueMode; plan?: GluePlan },
): GlueReport {
  const findings: Finding[] = [];
  const byKey = new Map<string, PageFacts>();
  for (const p of pages) byKey.set(canonicalKey(p.finalUrl), p);

  const add = (code: GlueFindingCode, severity: Severity, page: string, detail?: string) =>
    findings.push({ code, severity, page, detail });

  for (const page of pages) {
    const id = page.requestedUrl;

    /* --- доступность ------------------------------------------------ */
    if (page.error || page.status === 0) {
      add("fetch_failed", "blocker", id, page.error ?? "нет ответа");
      continue;
    }
    if (page.status >= 400) {
      add("page_dead", "blocker", id, `HTTP ${page.status}`);
      continue;
    }
    if (page.redirectChain.length && !sameUrl(page.requestedUrl, page.finalUrl)) {
      const last = page.redirectChain[page.redirectChain.length - 1];
      add(
        "page_redirected",
        "warn",
        id,
        `${last?.status ?? 3
        }xx → ${page.finalUrl}: аннотации читаются уже на другом URL`,
      );
    }
    if (hasNoindex(page)) {
      add("noindex", "blocker", id, page.robots.join(", "));
    }

    /* --- canonical --------------------------------------------------- */
    if (!page.canonicalRaw) {
      add("canonical_missing", "warn", id, "без canonical склейка держится только на догадке Google");
    } else {
      if (!/^https?:\/\//i.test(page.canonicalRaw.trim())) {
        add("canonical_relative", "warn", id, page.canonicalRaw);
      }
      if (page.alternatesRaw.some((a) => a.hreflang === "__canonical2")) {
        add("canonical_multiple", "blocker", id, "два rel=canonical — Google выберет сам или проигнорирует оба");
      }
      const target = page.canonical;
      if (target) {
        const targetPage = byKey.get(canonicalKey(target));
        if (targetPage) {
          if (targetPage.status >= 400 || targetPage.status === 0) {
            add("canonical_to_dead", "blocker", id, `цель отвечает ${targetPage.status || "ничем"}`);
          }
          if (hasNoindex(targetPage)) {
            add("canonical_to_noindex", "blocker", id, "цель канoникала закрыта от индексации");
          }
          if (
            targetPage.canonical &&
            !sameUrl(targetPage.canonical, target) &&
            !sameUrl(targetPage.canonical, page.finalUrl)
          ) {
            add(
              "canonical_chain",
              "blocker",
              id,
              `цепочка: ${target} → ${targetPage.canonical}; Google не идёт по цепочке канoникалов`,
            );
          }
        }
      }
    }

    /* --- hreflang ---------------------------------------------------- */
    if (!page.alternates.length) {
      add("hreflang_missing", "blocker", id, "на странице нет ни одной alternate-аннотации");
      continue;
    }

    const codes = new Map<string, string>();
    let xDefaults = 0;

    for (const raw of page.alternatesRaw) {
      if (raw.hreflang === "__canonical2") continue;
      if (!/^https?:\/\//i.test(raw.url.trim())) {
        add("hreflang_relative", "warn", id, `${raw.hreflang} → ${raw.url}`);
      }
    }

    for (const alt of page.alternates) {
      const code = alt.hreflang.toLowerCase();
      if (code === "x-default") {
        xDefaults += 1;
      } else {
        const check = checkLocale(alt.hreflang);
        if (!check.valid) {
          add(
            "hreflang_invalid_code",
            "blocker",
            id,
            `${alt.hreflang}${check.suggestion ? ` → вероятно ${check.suggestion}` : ""}${
              check.reason ? ` (${check.reason})` : ""
            }`,
          );
        }
      }

      const prev = codes.get(code);
      if (prev && !sameUrl(prev, alt.url)) {
        add("hreflang_duplicate_code", "blocker", id, `${alt.hreflang}: ${prev} и ${alt.url}`);
      }
      codes.set(code, alt.url);

      const targetPage = byKey.get(canonicalKey(alt.url));
      if (!targetPage) continue;

      if (targetPage.status >= 400 || targetPage.status === 0) {
        add("hreflang_target_dead", "blocker", id, `${alt.hreflang} → HTTP ${targetPage.status || "нет ответа"}`);
        continue;
      }
      if (hasNoindex(targetPage)) {
        add("hreflang_target_noindex", "blocker", id, `${alt.hreflang} → страница закрыта от индексации`);
      }

      // взаимность: цель обязана перечислять эту страницу в своём наборе
      const pointsBack = targetPage.alternates.some((a) => sameUrl(a.url, page.finalUrl));
      if (!pointsBack) {
        add(
          "hreflang_not_reciprocal",
          "blocker",
          id,
          `${alt.hreflang} → ${alt.url} не ссылается обратно; Google игнорирует одностороннюю аннотацию`,
        );
      }

      // hreflang обязан вести на канонический URL
      if (targetPage.canonical && !sameUrl(targetPage.canonical, targetPage.finalUrl)) {
        const severity: Severity = opts.mode === "funnel" ? "info" : "blocker";
        add(
          "hreflang_to_noncanonical",
          severity,
          id,
          `${alt.hreflang} → ${alt.url} каноничен на ${targetPage.canonical}` +
            (severity === "info" ? " (это и есть механика funnel-режима)" : ""),
        );
      }
    }

    if (!page.alternates.some((a) => sameUrl(a.url, page.finalUrl))) {
      add(
        "hreflang_no_self",
        "blocker",
        id,
        "страница не перечисляет саму себя — без self-ссылки группа не собирается",
      );
    }
    if (xDefaults === 0) {
      add("xdefault_missing", "warn", id, "нет x-default: непокрытым локалям Google выберет версию сам");
    }
    if (xDefaults > 1) {
      add("xdefault_multiple", "blocker", id, `x-default указан ${xDefaults} раза`);
    }
  }

  /* --- сверка с планом --------------------------------------------- */
  if (opts.plan) {
    for (const planned of opts.plan.pages) {
      const live = byKey.get(canonicalKey(planned.url)) ??
        pages.find((p) => sameUrl(p.requestedUrl, planned.url));
      if (!live) {
        findings.push({
          code: "page_not_checked",
          severity: "warn",
          page: planned.url,
          detail: "страница из плана не проверялась",
        });
        continue;
      }
      if (live.canonical && !sameUrl(live.canonical, planned.canonical)) {
        findings.push({
          code: "canonical_mismatch",
          severity: "blocker",
          page: planned.url,
          detail: `ожидался ${planned.canonical}, на странице ${live.canonical}`,
        });
      }
      if (live.htmlLang && normaliseLoose(live.htmlLang) !== normaliseLoose(planned.htmlLang)) {
        findings.push({
          code: "lang_attr_mismatch",
          severity: "warn",
          page: planned.url,
          detail: `<html lang="${live.htmlLang}">, в плане ${planned.htmlLang}`,
        });
      }
      if (!live.htmlLang) {
        findings.push({
          code: "lang_attr_missing",
          severity: "warn",
          page: planned.url,
          detail: "у <html> нет атрибута lang",
        });
      }
      const missing = planned.alternates.filter(
        (a) => !live.alternates.some((l) => sameUrl(l.url, a.url) && l.hreflang.toLowerCase() === a.hreflang.toLowerCase()),
      );
      if (missing.length) {
        findings.push({
          code: "alternates_mismatch",
          severity: "blocker",
          page: planned.url,
          detail: `не хватает аннотаций: ${missing.map((m) => m.hreflang).join(", ")}`,
        });
      }
    }
  }

  const counts: Record<Severity, number> = { blocker: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return { mode: opts.mode, ok: counts.blocker === 0, findings, counts };
}

function normaliseLoose(code: string): string {
  return code.trim().toLowerCase();
}
