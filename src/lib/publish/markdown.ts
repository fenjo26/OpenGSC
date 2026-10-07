// Markdown → HTML for publishing to a blog's REST API (P1: WordPress `content`).
//
// Two serializers already exist and neither fits:
//   • lib/seo/exportFormats.ts `mdToHtmlBody` — closest in spirit, but the file is
//     "use client", so calling it from an API route yields a client reference, not a
//     function. Copying the algorithm was the only way to run it server-side.
//   • lib/reports/render.ts `markdownToHtml` — server-safe, but built for operator notes:
//     it shifts headings one level down (## → <h3>), stamps rel="nofollow" on every link
//     (nofollowing the money-site links this feature EXISTS to build would defeat the
//     purpose), and knows no code fences.
//
// Limits, stated honestly: no nested lists, no blockquotes, no images, tables render only in
// the pipe syntax the app's own generators emit. The SEO posts this app produces use exactly
// headings / paragraphs / lists / bold / italic / links / tables / code fences — anything
// outside that survives as an escaped paragraph rather than being dropped.

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Escaped BEFORE markers convert, so article content can never inject markup into the blog.
// Links stay dofollow on purpose: these posts are donor pages for the money site.
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** Markdown body → HTML body, no document wrapper. Heading levels pass through untouched. */
export function markdownToHtmlBody(md: string): string {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let fence: string | null = null;
  let fenceLines: string[] = [];
  let inTable = false;
  let headerDone = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (inTable) { out.push("</tbody></table>"); inTable = false; headerDone = false; } };
  const closeFence = () => {
    if (fence !== null) {
      // Fenced content is escaped as a whole: code must arrive as text, never as markup.
      out.push(`<pre><code>${esc(fenceLines.join("\n"))}</code></pre>`);
      fence = null; fenceLines = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    const fenceMatch = /^```/.exec(line);
    if (fenceMatch) {
      if (fence === null) { closeList(); closeTable(); fence = ""; fenceLines = []; }
      else closeFence();
      continue;
    }
    if (fence !== null) { fenceLines.push(raw); continue; }

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

    const ulItem = /^[-*+]\s+(.+)$/.exec(line);
    if (ulItem) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(ulItem[1])}</li>`);
      continue;
    }
    const olItem = /^\d+[.)]\s+(.+)$/.exec(line);
    if (olItem) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(olItem[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  // An unclosed fence at EOF still emits what was collected — dropping a code block because
  // the model forgot the closing ticks would silently eat content.
  closeFence();
  closeList();
  closeTable();
  return out.join("\n");
}
