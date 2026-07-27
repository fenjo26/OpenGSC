// Main-content extraction — boilerplate removal without a DOM parser.
//
// WHY THIS EXISTS. The scraper used to flatten the entire document and take the first N characters
// as its text sample. On any real site the first few thousand characters are the mega-menu, the
// language switcher and the breadcrumbs — so the "content sample" handed to the LLM was navigation,
// and everything downstream inherited it: the Rewriter rewrote menus, the outline MAP stage
// extracted "facts" from link labels, Content Gap compared menus. The symptom looked like a bad
// prompt; the cause was upstream of every prompt.
//
// Constraint: no HTML-parsing dependency, matching the rest of this module. Regex alone cannot
// remove a nested block, so the missing piece is a small tag-balancing scanner — that is enough to
// cut whole containers out safely without pulling in a parser.

// Containers that are never article body, matched by tag name.
const BOILERPLATE_TAGS = ["nav", "header", "footer", "aside", "form", "script", "style", "noscript", "svg", "template", "iframe", "select", "dialog"];

// Containers that are never article body, matched by class/id. Kept deliberately conservative: a
// false positive here silently deletes real content, which is worse than leaving some noise in.
const BOILERPLATE_ATTR = /(^|[\s_-])(nav|navbar|navigation|menu|megamenu|header|footer|sidebar|side-bar|breadcrumb|cookie|consent|gdpr|popup|modal|banner|widget|social|share|subscribe|newsletter|pagination|pager|comment|related-posts|lang-switch|language-switcher|topbar|offcanvas|drawer|skip-link|screen-reader)([\s_-]|$)/i;

/**
 * Find the index just past the closing tag matching the element that starts at `openStart`.
 * Counts nested opens of the same tag so `<div><div></div></div>` closes correctly.
 * Returns -1 when the element is unclosed (malformed markup) so the caller can skip it.
 */
function findBlockEnd(html: string, tag: string, openStart: number): number {
  const openRe = new RegExp(`<${tag}\\b`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 0;
  let pos = openStart;
  // Walk opens and closes in document order, whichever comes next.
  for (let guard = 0; guard < 10000; guard++) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return -1;
    if (o && o.index < c.index) { depth++; pos = o.index + o[0].length; continue; }
    depth--;
    pos = c.index + c[0].length;
    if (depth === 0) return pos;
  }
  return -1;
}

/** Cut out every element with one of these tag names, contents included. */
function removeTags(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b`, "i");
    for (let guard = 0; guard < 500; guard++) {
      const m = re.exec(out);
      if (!m) break;
      const end = findBlockEnd(out, tag, m.index);
      // Self-closing or unclosed: drop just the tag so the scan can move on.
      out = end === -1
        ? out.slice(0, m.index) + " " + out.slice(m.index + m[0].length)
        : out.slice(0, m.index) + " " + out.slice(end);
    }
  }
  return out;
}

/** Cut out block elements whose class or id looks like chrome rather than content. */
function removeBoilerplateContainers(html: string): string {
  let out = html;
  const re = /<(div|section|ul|ol|span|table)\b[^>]*?(?:class|id)\s*=\s*["']([^"']*)["'][^>]*>/i;
  for (let guard = 0; guard < 400; guard++) {
    const m = re.exec(out);
    if (!m) break;
    const [full, tag, attr] = m;
    if (!BOILERPLATE_ATTR.test(attr)) {
      // Not boilerplate — neutralize this tag's attributes so the scan advances past it.
      out = out.slice(0, m.index) + `<${tag}>` + out.slice(m.index + full.length);
      continue;
    }
    const end = findBlockEnd(out, tag, m.index);
    out = end === -1
      ? out.slice(0, m.index) + " " + out.slice(m.index + full.length)
      : out.slice(0, m.index) + " " + out.slice(end);
  }
  return out;
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Share of the text that sits inside links. Navigation is ~1.0, article body is typically <0.15.
 * This is the single most reliable signal for "this is chrome, not content" and needs no heuristics
 * about class names, so it also catches sites whose markup gives no hints at all.
 */
export function linkDensity(html: string): number {
  const total = textOf(html).length;
  if (!total) return 1;
  let linked = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) linked += textOf(m[1]).length;
  return Math.min(1, linked / total);
}

/** Prefer an explicit content container when the page provides one. */
function pickContainer(html: string): string {
  for (const tag of ["article", "main"]) {
    const m = new RegExp(`<${tag}\\b`, "i").exec(html);
    if (m) {
      const end = findBlockEnd(html, tag, m.index);
      if (end !== -1) {
        const inner = html.slice(m.index, end);
        if (textOf(inner).length > 400) return inner;
      }
    }
  }
  const roleMain = /<(div|section)\b[^>]*role\s*=\s*["']main["'][^>]*>/i.exec(html);
  if (roleMain) {
    const end = findBlockEnd(html, roleMain[1], roleMain.index);
    if (end !== -1) {
      const inner = html.slice(roleMain.index, end);
      if (textOf(inner).length > 400) return inner;
    }
  }
  return html;
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&(?:rsquo|lsquo);/g, "'")
    .replace(/&(?:rdquo|ldquo);/g, '"').replace(/&(?:mdash|ndash);/g, "-")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Convert cleaned HTML to Markdown, keeping the structure a writer actually needs: headings, list
 * items, table rows and paragraph breaks. The old flat-text sample destroyed all of it, which is
 * why a rewritten page came back as one undifferentiated wall.
 */
function toMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote)>/gi, "\n\n");
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n))} `);
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<t[dh]\b[^>]*>/gi, " | ");
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `**${textOf(inner)}**`);
  s = s.replace(/<[^>]+>/g, " ");
  s = decode(s);
  return s
    .split("\n")
    .map(line => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Last-resort removal of menu and widget labels that survived every structural filter — a route
 * label repeated once per language version, or booking-form options like "1 guests / 2 guests".
 *
 * The test is deliberately narrow, and the reason matters. Pages legitimately repeat whole content
 * blocks: one real page carries the same "Important booking information" notice under seven
 * different sections. Collapsing those would silently restructure the article, and a rewrite built
 * on it would come back with one block where the original had seven — a structural edit nobody
 * asked for. So a repeated line is only dropped when it looks like a UI label rather than prose:
 * short, no sentence punctuation, and not a heading.
 */
function isProseLike(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("#")) return true;              // headings are structure, never deduplicate
  if (t.length > 60) return true;                  // long enough to be a sentence
  return /[.!?:;·]|\p{Ll}\s\p{Ll}+\s\p{Ll}+/u.test(t); // punctuation or several lowercase words
}

function dropRepeats(md: string): string {
  const lines = md.split("\n");
  const seen = new Map<string, number>();
  for (const l of lines) {
    const k = l.trim().toLowerCase();
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const emitted = new Map<string, number>();
  return lines
    .filter(l => {
      const k = l.trim().toLowerCase();
      if (!k) return true;
      if ((seen.get(k) ?? 0) < 3) return true;
      if (isProseLike(l)) return true;
      const n = (emitted.get(k) ?? 0) + 1;
      emitted.set(k, n);
      return n === 1;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export interface MainContent {
  /** article body as Markdown, headings preserved */
  markdown: string;
  /** flattened text, for callers that want a plain sample */
  text: string;
  words: number;
  linkDensity: number;
  /** true when the page yielded navigation rather than an article */
  boilerplateOnly: boolean;
}

const MIN_CONTENT_WORDS = 120;
const MAX_LINK_DENSITY = 0.45;

export function extractMainContent(html: string): MainContent {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;

  let cleaned = removeTags(body, BOILERPLATE_TAGS);

  // Rescue the H1 before attribute-based removal runs.
  //
  // On a real page the H1 shares its hero container with the booking widget and a rating badge, so
  // a container whose class matches /banner|widget/ takes the H1 down with it — and the rewrite
  // comes back starting at H2. Losing the H1 is the single most damaging thing this extractor could
  // do to a page it is supposed to help. It is captured AFTER nav/header/footer are gone, so a site
  // name sitting in <header><h1> is not what gets picked up.
  const heroH1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned)?.[1];
  const h1Text = heroH1 ? textOf(heroH1) : "";

  cleaned = removeBoilerplateContainers(cleaned);
  cleaned = pickContainer(cleaned);

  const density = linkDensity(cleaned);
  let markdown = dropRepeats(toMarkdown(cleaned));

  // Re-attach only when the body genuinely lost it — never duplicate an H1 that survived.
  if (h1Text && !/^#\s+\S/m.test(markdown)) markdown = `# ${decode(h1Text)}\n\n${markdown}`;
  const text = markdown.replace(/[#*|>-]/g, " ").replace(/\s+/g, " ").trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

  return {
    markdown,
    text,
    words,
    linkDensity: Math.round(density * 100) / 100,
    // Two independent ways to be sure there is no article here: too little prose, or prose that is
    // mostly link labels. Callers surface this instead of processing the result — rewriting a
    // navigation menu produces confident, fluent, worthless output, which is the worst failure mode
    // available, because it looks like success.
    boilerplateOnly: words < MIN_CONTENT_WORDS || density > MAX_LINK_DENSITY,
  };
}
