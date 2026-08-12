import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSource, type SourceFile } from "./rules";

const file = (path: string, content: string): SourceFile => ({ path, content, size: content.length });

test("Next.js source registry reports deterministic SEO and performance gaps", () => {
  const report = analyzeSource([
    file("package.json", JSON.stringify({ dependencies: { next: "16.2.4" } })),
    file("src/app/layout.tsx", `export default function Layout({children}) { return <html><body>{children}<img src="/hero.png" /></body></html> }`),
  ]);
  const ids = new Set(report.findings.map(item => item.ruleId));
  assert.equal(report.framework, "nextjs");
  assert.equal(ids.has("source.next.metadata_missing"), true);
  assert.equal(ids.has("source.next.sitemap_missing"), true);
  assert.equal(ids.has("source.next.robots_missing"), true);
  assert.equal(ids.has("source.next.raw_img"), true);
  assert.equal(ids.has("source.next.image_alt_missing"), true);
  assert.equal(report.score > 0, true);
});

test("security rules never include a secret value in evidence", () => {
  const report = analyzeSource([
    file("package.json", JSON.stringify({ dependencies: { next: "16" } })),
    file("src/app/page.tsx", `const value = process.env.NEXT_PUBLIC_ADMIN_TOKEN; const literal = "do-not-leak"`),
    file("src/app/product/page.tsx", `<script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify(product)}} />`),
  ]);
  const serialized = JSON.stringify(report);
  assert.equal(report.findings.some(item => item.ruleId === "source.security.public_secret_name"), true);
  assert.equal(report.findings.some(item => item.ruleId === "source.next.jsonld_not_escaped"), true);
  assert.equal(serialized.includes("do-not-leak"), false);
});

test("safe URL fetch and escaped JSON-LD do not produce security findings", () => {
  const report = analyzeSource([
    file("package.json", JSON.stringify({ dependencies: { next: "16" } })),
    file("src/app/layout.tsx", `export const metadata = { title: "Site" }; export default function Layout({children}) { return <html>{children}</html> }`),
    file("src/app/sitemap.ts", `export default function sitemap(){ return [] }`),
    file("src/app/robots.ts", `export default function robots(){ return {rules: []} }`),
    file("src/app/product/page.tsx", `<script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify(product).replace(/</g, "\\u003c")}} />`),
    file("src/app/api/check/route.ts", `import { safeFetch } from "@/lib/security/safeFetch"; export async function POST(req){ const body=await req.json(); return safeFetch(body.url) }`),
  ]);
  assert.equal(report.findings.some(item => item.severity === "error"), false);
});

test("root Route Handlers and non-JSON-LD raw HTML are checked independently", () => {
  const report = analyzeSource([
    file("package.json", JSON.stringify({ dependencies: { next: "16" } })),
    file("src/app/route.ts", `export async function POST(req){ const body=await req.json(); const targetUrl=body.url; return fetch(targetUrl) }`),
    file("src/app/page.tsx", `<><script type="application/ld+json" dangerouslySetInnerHTML={{__html: JSON.stringify(data).replace(/</g, "\\u003c")}} /><section dangerouslySetInnerHTML={{__html: userHtml}} /></>`),
  ]);
  const ids = report.findings.map(item => item.ruleId);
  assert.equal(ids.includes("source.security.user_url_raw_fetch"), true);
  assert.equal(ids.includes("source.security.unsafe_html_review"), true);
  assert.equal(ids.includes("source.next.jsonld_not_escaped"), false);
});
