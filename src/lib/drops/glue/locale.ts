/** Коды локалей для hreflang: проверка и исправление типовых ошибок. */

export interface LocaleCheck {
  /** нормализованный код (язык в нижнем, регион в верхнем регистре) */
  value: string;
  valid: boolean;
  /** предложенная замена, если код невалиден или это частая ошибка */
  suggestion?: string;
  reason?: string;
}

/** Частые ошибки: домен верхнего уровня вместо кода языка/региона. */
const FIXES: Record<string, { to: string; reason: string }> = {
  "en-uk": { to: "en-GB", reason: "регион Великобритании — GB, не UK" },
  "en-eu": { to: "x-default", reason: "EU не регион ISO 3166-1; для общей версии x-default" },
  gr: { to: "el", reason: "греческий язык — el, gr это домен" },
  "gr-gr": { to: "el-GR", reason: "греческий язык — el, gr это домен" },
  "el-gr": { to: "el-GR", reason: "" },
  jp: { to: "ja", reason: "японский язык — ja, jp это домен" },
  cz: { to: "cs", reason: "чешский язык — cs, cz это домен" },
  ua: { to: "uk", reason: "украинский язык — uk, ua это домен" },
  se: { to: "sv", reason: "шведский язык — sv, se это домен" },
  dk: { to: "da", reason: "датский язык — da, dk это домен" },
  iw: { to: "he", reason: "iw устаревший код иврита" },
  "zh-cn": { to: "zh-Hans", reason: "для китайского надёжнее письменность: zh-Hans/zh-Hant" },
};

/** язык[-письменность][-регион], например en, en-GB, zh-Hans, zh-Hans-CN */
const SHAPE = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i;

export function checkLocale(input: string): LocaleCheck {
  const raw = (input ?? "").trim();
  const lower = raw.toLowerCase();

  if (lower === "x-default") return { value: "x-default", valid: true };
  if (!raw) return { value: raw, valid: false, reason: "пустой код" };

  const fix = FIXES[lower];
  if (fix) {
    return {
      value: normalise(raw),
      valid: false,
      suggestion: fix.to,
      reason: fix.reason || undefined,
    };
  }

  if (!SHAPE.test(lower)) {
    return { value: raw, valid: false, reason: "не похоже на код вида язык[-письменность][-регион]" };
  }

  return { value: normalise(raw) , valid: true };
}

/** en-gb -> en-GB, ZH-hans-cn -> zh-Hans-CN */
export function normalise(code: string): string {
  const parts = code.trim().split("-");
  return parts
    .map((p, i) => {
      if (i === 0) return p.toLowerCase();
      if (p.length === 4) return p[0].toUpperCase() + p.slice(1).toLowerCase();
      return p.toUpperCase();
    })
    .join("-");
}

/** базовый языковой субтег: en-GB -> en */
export function baseLanguage(code: string): string {
  return normalise(code).split("-")[0];
}

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Сравнение URL для нужд кластера: схема и хост регистронезависимы,
 * хвостовой слэш на корне не считается различием, хеш игнорируется.
 * Регистр пути, параметры и www/не-www — считаются различием намеренно:
 * для Google это разные URL.
 */
export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalKey(a) === canonicalKey(b);
}

export function canonicalKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** Абсолютизирует href относительно страницы; null, если не разобрать. */
export function absolutise(href: string, base: string): string | null {
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return null;
  }
}

export function isAbsolute(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}
