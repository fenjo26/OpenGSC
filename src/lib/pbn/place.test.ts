import { test } from "node:test";
import assert from "node:assert/strict";
import { findTextBlocks, choosePlacement, buildAnchorTag, injectIntoBlock, planRel, renderPage, linksForPage, type RenderLink } from "./place";
import { residualFootprints } from "./clean";

const PARA = "This is a substantial paragraph of real content about dog grooming and pet care that easily clears the one hundred and fifty character minimum needed for a natural in-content link placement.";

test("finds leaf text blocks, not the wrapping container", () => {
  const html = `<div><p>${PARA}</p><p>short</p></div>`;
  const blocks = findTextBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tag, "p");
});

test("table-cell content is a valid placement (the pets.com case WayForge broke on)", () => {
  const html = `<table><tr><td>${PARA}</td></tr></table>`;
  const choice = choosePlacement(html, "dog grooming");
  assert.equal(choice.needsParagraph, false);
  assert.equal(choice.block?.tag, "td");
});

test("no suitable block → needsParagraph, never a top-of-body dump", () => {
  const html = `<table><tr><td>Home</td><td>Cat</td><td>Dog</td></tr></table>`;
  const choice = choosePlacement(html, "dog grooming");
  assert.equal(choice.needsParagraph, true);
  assert.equal(choice.block, undefined);
});

test("topical block is preferred over a merely long one", () => {
  const offtopic = "x".repeat(50) + " " + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim";
  const ontopic = "Our dog grooming salon offers the best dog grooming services in town with professional dog grooming staff and years of dog grooming experience for your pet.";
  const html = `<div><p>${offtopic}</p></div><div><p>${ontopic}</p></div>`;
  const choice = choosePlacement(html, "dog grooming");
  assert.ok(choice.block?.text.includes("salon"), choice.block?.text);
});

test("injected anchor carries no markers and lands inside the block", () => {
  const html = `<td>${PARA}</td>`;
  const choice = choosePlacement(html, "dog grooming");
  const tag = buildAnchorTag("https://example.com/money", "best dog grooming", "dofollow");
  const out = injectIntoBlock(html, choice.block!, tag, "For more see {link} today.");
  assert.ok(out.includes('href="https://example.com/money"'));
  assert.ok(out.includes("For more see"));
  assert.deepEqual(residualFootprints(out), []);
  // Link sits before the cell closes, not dumped at the top.
  assert.ok(out.indexOf("example.com") < out.indexOf("</td>"));
  assert.ok(out.indexOf("example.com") > out.indexOf(">This is"));
});

test("rel attribute: dofollow omits rel, others set it", () => {
  assert.ok(!/rel=/.test(buildAnchorTag("x.com", "a", "dofollow")));
  assert.ok(/rel="nofollow"/.test(buildAnchorTag("x.com", "a", "nofollow")));
  assert.ok(/rel="sponsored"/.test(buildAnchorTag("x.com", "a", "sponsored")));
});

test("bare anchor (no surrounding) still has no footprint", () => {
  const html = `<td>${PARA}</td>`;
  const choice = choosePlacement(html, "pets");
  const tag = buildAnchorTag("example.com", "pets", "sponsored");
  const out = injectIntoBlock(html, choice.block!, tag);
  assert.deepEqual(residualFootprints(out), []);
  assert.ok(out.includes('rel="sponsored"'));
});

test("buildAnchorTag escapes quotes and brackets in the URL (no attribute break-out)", () => {
  const tag = buildAnchorTag('https://x.com/a"onmouseover="alert(1)', "hi", "dofollow");
  assert.ok(!tag.includes('"onmouseover'), tag);
  assert.ok(tag.includes("%22"));
});

test("planRel distributes by shares, not all-dofollow (the pickRel bug)", () => {
  const rels = planRel({ dofollow: 80, nofollow: 15, sponsored: 5 }, 20, 7);
  assert.equal(rels.length, 20);
  const n = (k: string) => rels.filter(r => r === k).length;
  assert.equal(n("dofollow"), 16);
  assert.equal(n("nofollow"), 3);
  assert.equal(n("sponsored"), 1);
});

test("planRel is deterministic per seed", () => {
  assert.deepEqual(planRel({ dofollow: 1, nofollow: 1 }, 10, 3), planRel({ dofollow: 1, nofollow: 1 }, 10, 3));
});

test("renderPage is idempotent: rendering twice from pristine gives the same output", () => {
  const pristine = `<html><body><td>${PARA}</td></body></html>`;
  const links: RenderLink[] = [{ pagePath: "/", anchorText: "dog grooming", targetUrl: "https://example.com/m", rel: "dofollow", placement: "content", status: "placed" }];
  const once = renderPage(pristine, links);
  const twice = renderPage(pristine, links);
  assert.equal(once, twice);
  // and exactly one injected link (no accumulation across renders)
  assert.equal((once.match(/example\.com/g) || []).length, 1);
});

test("renderPage footer placement appends a generated paragraph, no footprint", () => {
  const pristine = `<html><body><p>${PARA}</p></body></html>`;
  const links: RenderLink[] = [{ pagePath: "*", anchorText: "x", targetUrl: "https://e.com", rel: "sponsored", placement: "footer", surroundingText: "See {link} for more.", status: "placed" }];
  const out = renderPage(pristine, links);
  assert.ok(out.includes("See <a"));
  assert.ok(out.includes('rel="sponsored"'));
  assert.deepEqual(residualFootprints(out), []);
});

test("renderPage skips non-placed links", () => {
  const pristine = `<html><body><td>${PARA}</td></body></html>`;
  const out = renderPage(pristine, [{ pagePath: "/", anchorText: "a", targetUrl: "https://e.com", rel: "dofollow", placement: "content", status: "skipped" }]);
  assert.ok(!out.includes("e.com"));
});

test("linksForPage: root file, concrete page and sitewide star — one filter for UI zip and MCP export", () => {
  const mk = (pagePath: string): RenderLink => ({ pagePath, anchorText: "a", targetUrl: "https://e.com", rel: "dofollow", placement: "content", status: "placed" });
  const links = [mk("/"), mk("/about"), mk("*"), { ...mk("/"), status: "skipped" }];
  assert.deepEqual(linksForPage(links, "index.html").map(l => l.pagePath), ["/", "*"]);
  assert.deepEqual(linksForPage(links, "about/index.html").map(l => l.pagePath), ["/about", "*"]);
  assert.deepEqual(linksForPage(links, "a/b.html").map(l => l.pagePath), ["*"]);
});
