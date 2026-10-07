import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtmlBody } from "./markdown";

// Round-trip here means CONTENT round-trip, not syntax round-trip: the serializer is one-way,
// so what these assert is that every fact of the source — words, URLs, link texts, code —
// survives into the HTML, escaped on the way in. The limits are documented in the module
// header; these tests pin the subset the app's generators actually emit.

test("headings keep their level (no shift, no document wrapper)", () => {
  const html = markdownToHtmlBody("# One\n\n## Two\n\n### Three\n\n#### Four");
  assert.ok(html.includes("<h1>One</h1>"));
  assert.ok(html.includes("<h2>Two</h2>"));
  assert.ok(html.includes("<h3>Three</h3>"));
  assert.ok(html.includes("<h4>Four</h4>"));
  assert.ok(!html.includes("<!DOCTYPE"), "no document wrapper");
});

test("bold, italic and inline code convert; links stay dofollow", () => {
  const html = markdownToHtmlBody("A **bold** and *italic* and `code` word, plus [home](https://example.com/).");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes('<a href="https://example.com/">home</a>'));
  // The whole point of the publish is a followed link to the money site — nofollow here
  // would be a bug, not a safety feature (this is our own content).
  assert.ok(!html.includes("nofollow"));
});

test("unordered and ordered lists render as their own elements", () => {
  const html = markdownToHtmlBody("- a\n- b\n\n1. first\n2. second");
  // Elements are newline-joined; the list groups only wrap their own items.
  assert.ok(html.includes("<ul>\n<li>a</li>\n<li>b</li>\n</ul>"), html);
  assert.ok(html.includes("<ol>\n<li>first</li>\n<li>second</li>\n</ol>"), html);
  // Two sibling lists, not one nested inside the other: the ul closes before the ol opens.
  assert.ok(html.indexOf("</ul>") < html.indexOf("<ol>"), html);
});

test("code fences keep their content as text, never as markup", () => {
  const html = markdownToHtmlBody("Intro\n\n```html\n<script>alert(1)</script>\n<a href=\"x\">y</a>\n```");
  // The fence content must arrive escaped — WP would otherwise store live script tags.
  assert.ok(html.includes("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;</code></pre>"), html);
});

test("pipe tables render with a header row and skip the separator", () => {
  const html = markdownToHtmlBody("| Col A | Col B |\n| --- | --- |\n| 1 | 2 |");
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("<thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody>"));
  assert.ok(html.includes("<tr><td>1</td><td>2</td></tr>"), html);
  assert.ok(html.includes("</tbody></table>"));
  assert.ok(!html.includes("<td>---</td>"), "the separator row is structure, not data");
});

test("article text is escaped before markers convert — no markup injection", () => {
  const html = markdownToHtmlBody("Price <b>100</b> & quality \">\"");
  assert.ok(!html.includes("<b>100</b>"));
  assert.ok(html.includes("&lt;b&gt;100&lt;/b&gt;"));
  assert.ok(html.includes("&amp; quality"));
});

test("every word and URL of a realistic post survives the conversion", () => {
  const md = [
    "# Athens airport transfer",
    "",
    "The fixed rate is **54 EUR** for a sedan — see [prices](https://money.example.com/prices).",
    "",
    "## Highlights",
    "- Door-to-door",
    "- Flight tracking",
  ].join("\n");
  const html = markdownToHtmlBody(md);
  for (const needle of ["Athens airport transfer", "54 EUR", "money.example.com/prices", "Door-to-door", "Flight tracking"]) {
    assert.ok(html.includes(needle), `missing: ${needle}`);
  }
});
