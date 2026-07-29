// Export helpers for rewritten content: filename derivation and Markdown → HTML / plain text.
//
// The rewriter now returns Markdown with the heading tree intact, so a single .txt download throws
// away the structure the rewrite was told to preserve. Three formats cover what the content
// actually gets pasted into: .md for a headless CMS or git, .html for a classic editor, .txt for a
// client who wants prose only.
"use client";

/**
 * Filename stem from the source. A page's own slug is what the operator recognizes six downloads
 * later — "rewrite-1.txt" tells them nothing once three tabs are open.
 */
export function slugFromSource(opts: { url?: string; title?: string; content?: string }): string {
  const fromUrl = (u: string): string => {
    try {
      const parts = new URL(u).pathname.split("/").filter(Boolean);
      // Trailing language or pagination segments are not the page's identity.
      const last = parts.reverse().find(p => p.length > 2 && !/^(el|en|ru|fr|de|es|it|page|\d+)$/i.test(p));
      return last ? last.replace(/\.(html?|php|aspx?)$/i, "") : "";
    } catch { return ""; }
  };

  // NFKD splits an accented letter into base + combining mark. The marks have to be DELETED —
  // treating them as non-letters turns "αεροδρομίου" into "αεροδρομι-ου".
  const slugify = (s: string): string =>
    s.normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  const fromHeading = (md: string): string => {
    const h = /^#{1,6}\s+(.+)$/m.exec(md || "")?.[1] || "";
    return h ? slugify(h) : "";
  };

  return (opts.url ? fromUrl(opts.url) : "")
    || (opts.title ? slugify(opts.title) : "")
    || fromHeading(opts.content || "")
    || "rewrite";
}

/** Markdown → readable plain text: structure markers removed, block breaks kept. */
export function mdToPlain(md: string): string {
  return String(md || "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/^\s*\|/gm, "")
    .replace(/\|\s*$/gm, "")
    .replace(/\s*\|\s*/g, " — ")
    .replace(/^\s*[-:]{3,}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Inline formatting is escaped BEFORE markers are converted, so page content can never inject tags.
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Markdown → HTML body markup, with no document wrapper.
 *
 * This is the form that actually gets pasted: a CMS source view, a WYSIWYG "code" tab or a page
 * template wants the tags for the content and nothing else. A full document with DOCTYPE and head
 * has to be stripped by hand before it is usable there.
 */
export function mdToHtmlBody(md: string): string {
  const lines = String(md || "").split("\n");
  const out: string[] = [];
  let list: "ul" | null = null;
  let inTable = false;
  let headerDone = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (inTable) { out.push("</tbody></table>"); inTable = false; headerDone = false; } };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); closeTable(); continue; }

    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) { closeList(); closeTable(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\|(.+)\|$/.test(line)) {
      const cells = line.slice(1, -1).split("|").map(c => c.trim());
      if (cells.every(c => /^[-: ]+$/.test(c))) continue; // separator row
      closeList();
      if (!inTable) { out.push("<table>"); inTable = true; headerDone = false; }
      if (!headerDone) {
        out.push("<thead><tr>" + cells.map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
        headerDone = true;
      } else {
        out.push("<tr>" + cells.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      continue;
    }
    closeTable();

    const li = /^[-*+]\s+(.+)$/.exec(line);
    if (li) {
      if (!list) { out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join("\n");
}

/**
 * Markdown → a standalone HTML document. Charset is declared explicitly because this content is
 * routinely non-Latin (Greek, Cyrillic) and a file opened straight from disk has no server header
 * to fall back on.
 */
export function mdToHtml(md: string, title = ""): string {
  const docTitle = esc(title || /^#{1,6}\s+(.+)$/m.exec(md)?.[1] || "");
  return `<!DOCTYPE html>
<html lang="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
</head>
<body>
${mdToHtmlBody(md)}
</body>
</html>`;
}

export type ExportFormat = "md" | "html" | "htmltxt" | "txt";

/**
 * The format id is not the file extension: `htmltxt` is HTML markup saved as `.txt` on purpose, so
 * a double-click opens a text editor showing the tags instead of a browser rendering them.
 */
export const EXPORT_FORMATS: { id: ExportFormat; ext: string; label: string }[] = [
  { id: "md", ext: "md", label: ".md" },
  { id: "html", ext: "html", label: ".html" },
  { id: "htmltxt", ext: "txt", label: "<html>.txt" },
  { id: "txt", ext: "txt", label: ".txt" },
];

export const extensionFor = (f: ExportFormat) => EXPORT_FORMATS.find(x => x.id === f)?.ext ?? "txt";

export interface ExportSnippet { title: string; description: string }

// YAML front matter needs quoting for anything containing a colon or a quote — snippet copy is full
// of both ("Transfer Thessaloniki | Premium…", 'από 30€').
const yamlValue = (s: string) => `"${String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Attach the refreshed snippet to the exported file in whatever form that format expects: YAML front
 * matter for Markdown, real head tags for HTML, a labelled header for plain text.
 *
 * The alternative — pasting the snippet on top of the body as loose text — would push it through
 * the value-drift check on the next edit and show up as content the source never had.
 */
export function renderAs(
  format: ExportFormat,
  md: string,
  title = "",
  snippet?: ExportSnippet,
): { content: string; mime: string } {
  const sn = snippet && (snippet.title || snippet.description) ? snippet : undefined;

  if (format === "html") {
    let html = mdToHtml(md, sn?.title || title);
    if (sn?.description) {
      html = html.replace("</head>", `<meta name="description" content="${esc(sn.description)}">\n</head>`);
    }
    return { content: html, mime: "text/html;charset=utf-8" };
  }

  if (format === "htmltxt") {
    // A fragment has no <head> to carry the snippet, so it rides along as comments — visible to
    // whoever pastes the markup, invisible once the page renders.
    const head = sn
      ? `<!-- Title: ${sn.title} -->\n<!-- Meta Description: ${sn.description} -->\n\n`
      : "";
    // text/plain, not text/html: the point of this format is that the file opens as text.
    return { content: head + mdToHtmlBody(md), mime: "text/plain;charset=utf-8" };
  }

  if (format === "txt") {
    const head = sn
      ? `Title: ${sn.title}\nMeta Description: ${sn.description}\n\n${"-".repeat(40)}\n\n`
      : "";
    return { content: head + mdToPlain(md), mime: "text/plain;charset=utf-8" };
  }

  const front = sn
    ? `---\ntitle: ${yamlValue(sn.title)}\ndescription: ${yamlValue(sn.description)}\n---\n\n`
    : "";
  return { content: front + md, mime: "text/markdown;charset=utf-8" };
}

export function downloadFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
