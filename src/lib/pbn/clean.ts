// Чистка восстановленного HTML от следов архива и чужих сайтов.
//
// Против того, что оставляет WayForge (проверено на их выдаче pets.com):
//  - ссылки/картинки на web.archive.org/…im_/ — у них остаются; здесь переписываются на
//    локальные пути или убираются;
//  - свои маркеры data-wf-* на каждом теге — здесь не добавляем вовсе (в clean их и быть не
//    может, тест ниже это стережёт);
//  - javascript:-ссылки на чужой сайт — у них остаются; здесь убираются.
//
// Задача этого модуля — только чистка. Вставка ссылок — в place.ts/inject (отдельно).
// Чистая функция над строкой HTML; тяжёлый разбор DOM — дело стадии, здесь — консервативные
// регэкспы над уже выкачанным снимком.

export interface CleanOptions {
  /** Домен восстанавливаемого сайта — его внутренние ссылки оставляем, чужие исходящие режем. */
  domain: string;
  /** Базовый путь, на который переписываются ассеты (по умолчанию локальные относительные). */
}

export interface CleanResult {
  html: string;
  stats: {
    archiveRefsRewritten: number;   // ссылок/ассетов с web.archive.org переписано/убрано
    externalLinksStripped: number;  // исходящих на чужие домены снято (href → без ссылки)
    trackersRemoved: number;        // GA/Metrika/GTM-скриптов удалено
    jsLinksStripped: number;        // javascript:-ссылок снято
  };
}

const ARCHIVE_HOST = /https?:\/\/web\.archive\.org\/web\/\d+(?:id_|im_|js_|cs_)?\/(https?:\/\/[^"'\s)]+)/gi;
const TRACKER_SRC = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*(?:google-analytics\.com|googletagmanager\.com|mc\.yandex\.ru\/metrika|top-fwz1\.mail\.ru)[^"']*["'][^>]*>\s*<\/script>/gi;
const INLINE_TRACKER = /<script\b[^>]*>[^<]*?(?:ga\(|gtag\(|yaCounter|_gaq|dataLayer|ym\()[^<]*?<\/script>/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Снять архивную обёртку: `…/web/<ts>im_/https://site/x.gif` → `https://site/x.gif`, а затем
 * привести к локальному относительному пути, если это наш же домен. Чужие архивные ссылки
 * раскрываются в исходный URL (а исходящие потом снимет отдельный проход).
 */
export function unwrapArchiveUrls(html: string, domain: string): { html: string; count: number } {
  let count = 0;
  const host = domain.replace(/^www\./, "").toLowerCase();
  const out = html.replace(ARCHIVE_HOST, (_m, original: string) => {
    count++;
    const h = hostOf(original);
    if (h && (h === host || h.endsWith("." + host))) {
      // Наш же ассет — в относительный путь.
      try {
        return new URL(original).pathname + new URL(original).search;
      } catch {
        return original;
      }
    }
    return original; // чужой — раскрываем; исходящие уберёт stripExternal
  });
  return { html: out, count };
}

/** Удалить скрипты-трекеры (GA/GTM/Metrika/Mail.ru), и внешние по src, и инлайновые. */
export function stripTrackers(html: string): { html: string; count: number } {
  let count = 0;
  let out = html.replace(TRACKER_SRC, () => { count++; return ""; });
  out = out.replace(INLINE_TRACKER, () => { count++; return ""; });
  return { html: out, count };
}

/**
 * Снять исходящие ссылки на ЧУЖИЕ домены (href на другой сайт → остаётся текст анкора без <a>),
 * а также javascript:-ссылки. Внутренние ссылки и якоря не трогаем.
 */
export function stripExternalLinks(html: string, domain: string): { html: string; external: number; js: number } {
  const host = domain.replace(/^www\./, "").toLowerCase();
  let external = 0;
  let js = 0;
  // Разворачиваем <a ...>текст</a> в текст, если href ведёт на чужой домен или на javascript:.
  const out = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    if (/^\s*javascript:/i.test(href)) { js++; return inner; }
    if (/^(https?:)?\/\//i.test(href)) {
      const h = hostOf(href.startsWith("//") ? "https:" + href : href);
      if (h && h !== host && !h.endsWith("." + host)) { external++; return inner; }
    }
    return whole; // внутренняя, относительная или якорь — оставляем
  });
  return { html: out, external, js };
}

/** Полная чистка одним проходом. */
export function cleanHtml(html: string, opts: CleanOptions): CleanResult {
  const a = unwrapArchiveUrls(html, opts.domain);
  const t = stripTrackers(a.html);
  const e = stripExternalLinks(t.html, opts.domain);
  return {
    html: e.html,
    stats: {
      archiveRefsRewritten: a.count,
      externalLinksStripped: e.external,
      trackersRemoved: t.count,
      jsLinksStripped: e.js,
    },
  };
}

/**
 * Проверка «нет чужих следов»: ни web.archive.org, ни маркеров WayForge (на случай, если
 * восстанавливаем из чьего-то чужого экспорта). Возвращает список найденных маркеров — в тестах
 * и в экспортном гейте он должен быть пустым.
 */
export function residualFootprints(html: string): string[] {
  const found: string[] = [];
  if (/web\.archive\.org/i.test(html)) found.push("web.archive.org");
  for (const m of ["data-wf-reconstructed", "data-wf-healed", "data-wf-injected", "data-wf-domain", "data-wf-media-healer", "wf-footer-partner"]) {
    if (html.includes(m)) found.push(m);
  }
  return found;
}
