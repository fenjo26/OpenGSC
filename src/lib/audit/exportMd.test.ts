import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditMarkdown, type AuditPage } from "./exportMd";

const page = (path: string, issues: string[]): AuditPage => ({
  url: `https://example.com${path}`,
  httpStatus: 200,
  title: "t",
  issues,
});

test("site-wide findings list every affected page in the appendix", () => {
  // 293 of 365 pages (80.3%) trips the site-wide threshold — the exact shape of a real audit
  // where the suppressed list hid which pages were affected.
  const affected: AuditPage[] = Array.from({ length: 293 }, (_, i) => page(`/a/${i}`, ["title_too_long"]));
  const clean: AuditPage[] = Array.from({ length: 72 }, (_, i) => page(`/c/${i}`, []));
  const md = buildAuditMarkdown(
    { siteUrl: "https://example.com", pagesCrawled: 365, finishedAt: "2026-08-27T12:46:00Z" },
    [...affected, ...clean],
    (c) => c,
  );

  const appendix = md.slice(md.indexOf("## Appendix"));
  for (let i = 0; i < 293; i++) {
    assert.ok(appendix.includes(`/a/${i}`), `appendix must list /a/${i}`);
  }
  assert.match(appendix, /### `title_too_long` \(293\)/);
  assert.ok(!appendix.includes("all 293 crawled pages"), "no summary line in place of the list");
});

test("issues that fit their table are not repeated in the appendix", () => {
  const md = buildAuditMarkdown(
    { siteUrl: "https://example.com", pagesCrawled: 10 },
    [page("/x", ["noindex"]), page("/y", ["noindex"])],
    (c) => c,
  );
  assert.ok(!md.includes("## Appendix"));
});

test("scattered issues beyond MAX_ROWS list all pages in the appendix", () => {
  // 25 of 100 stays under the site-wide threshold, so this exercises the scattered path.
  const affected = Array.from({ length: 25 }, (_, i) => page(`/s/${i}`, ["open_graph_incomplete"]));
  const clean = Array.from({ length: 75 }, (_, i) => page(`/c/${i}`, []));
  const md = buildAuditMarkdown(
    { siteUrl: "https://example.com", pagesCrawled: 100 },
    [...affected, ...clean],
    (c) => c,
  );
  const appendix = md.slice(md.indexOf("## Appendix"));
  assert.match(appendix, /### `open_graph_incomplete` \(25\)/);
  for (let i = 0; i < 25; i++) assert.ok(appendix.includes(`/s/${i}`));
});
