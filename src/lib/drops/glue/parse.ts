import type { PageFacts, PageFetch } from "./types";
import { absolutise } from "./locale";

/**
 * Разбор <head> без DOM-библиотеки: нужны только link[rel=canonical],
 * link[rel=alternate][hreflang], meta[name=robots] и атрибут lang у <html>.
 *
 * Если в репозитории уже есть парсер из site-audit краулера — использовать его,
 * этот модуль тогда сводится к мапперу. Осознанные ограничения:
 *  - теги внутри <!-- --> отбрасываются;
 *  - всё после закрывающего </head> игнорируется (Google тоже читает hreflang только из head);
 *  - аннотации из XML-сайтмапа и HTTP-заголовка Link не рассматриваются (фаза 2).
 */
export function parsePage(fetched: PageFetch): PageFacts {
  const base = fetched.finalUrl || fetched.requestedUrl;
  const facts: PageFacts = {
    requestedUrl: fetched.requestedUrl,
    finalUrl: base,
    status: fetched.status,
    redirectChain: fetched.redirectChain ?? [],
    htmlLang: null,
    canonical: null,
    canonicalRaw: null,
    alternates: [],
    alternatesRaw: [],
    robots: [],
    error: fetched.error,
  };

  const headers = fetched.headers ?? {};
  const xRobots = headers["x-robots-tag"];
  if (xRobots) facts.robots.push(...splitDirectives(xRobots));

  const html = fetched.html;
  if (!html) return facts;

  const head = headSection(stripComments(html));

  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) facts.htmlLang = attr(htmlTag[0], "lang");

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!head.includes(tag)) continue;
    const rel = (attr(tag, "rel") ?? "").toLowerCase().trim();
    const href = attr(tag, "href");
    if (!href) continue;

    if (rel === "canonical") {
      if (facts.canonicalRaw === null) {
        facts.canonicalRaw = href;
        facts.canonical = absolutise(href, base);
      } else {
        // второй canonical — фиксируем как ещё одну "сырую" запись, решает валидатор
        facts.alternatesRaw.push({ hreflang: "__canonical2", url: href });
      }
      continue;
    }

    if (rel === "alternate") {
      const hreflang = attr(tag, "hreflang");
      if (!hreflang) continue;
      facts.alternatesRaw.push({ hreflang, url: href });
      const abs = absolutise(href, base);
      if (abs) facts.alternates.push({ hreflang, url: abs });
    }
  }

  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, "name") ?? "").toLowerCase().trim();
    if (name !== "robots" && name !== "googlebot") continue;
    const content = attr(tag, "content");
    if (content) facts.robots.push(...splitDirectives(content));
  }

  return facts;
}

export function hasNoindex(facts: PageFacts): boolean {
  return facts.robots.some((d) => d === "noindex" || d === "none");
}

function headSection(html: string): string {
  const end = /<\/head\s*>/i.exec(html);
  const start = /<head\b[^>]*>/i.exec(html);
  const from = start ? start.index : 0;
  const to = end ? end.index : Math.min(html.length, 200_000);
  return html.slice(from, Math.max(from, to));
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function splitDirectives(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return decode((m[2] ?? m[3] ?? m[4] ?? "").trim());
}

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
