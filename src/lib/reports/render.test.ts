import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummary, buildNextSteps, markdownToHtml, renderReportHTML, clicksSvg, fmtDeltaPct, escapeHtml,
} from "./render";
import type { ReportData } from "./collect";
import type { ReportSectionId } from "./sections";

// ─── fixtures ─────────────────────────────────────────────────────────────────

function fixtureData(): ReportData {
  return {
    siteDomain: "client.example",
    window: { from: "2026-08-26", to: "2026-09-25", days: 30, prevFrom: "2026-07-27", prevTo: "2026-08-26" },
    traffic: {
      current: { clicks: 1180, impressions: 62_000, ctr: 0.019, position: 14.2 },
      previous: { clicks: 1000, impressions: 60_000, ctr: 0.0167, position: 15.0 },
      series: [
        { date: "2026-08-26", clicks: 40, impressions: 2000 },
        { date: "2026-08-27", clicks: 51, impressions: 2100 },
        { date: "2026-08-28", clicks: 0, impressions: 1500 },
      ],
    },
    queries: {
      rows: [
        { key: "transfer halkidiki", clicks: 300, impressions: 9000, prevClicks: 60, delta: 240 },
        { key: "taxi thessaloniki", clicks: 120, impressions: 5000, prevClicks: 130, delta: -10 },
      ],
    },
    positions: {
      checked: 12,
      top3: 2,
      top10: 5,
      improved: [{ keyword: "airport taxi", location: "", position: 2, prevPosition: 5, change: 3 }],
      declined: [{ keyword: "night taxi", location: "", position: 18, prevPosition: 6, change: -12 }],
    },
    indexing: {
      first: { day: "2026-08-26", total: 100, indexed: 98, notIndexed: 2, unknown: 0 },
      latest: { day: "2026-09-25", total: 100, indexed: 92, notIndexed: 6, unknown: 2 },
      series: [
        { day: "2026-08-26", total: 100, indexed: 98, notIndexed: 2, unknown: 0 },
        { day: "2026-09-25", total: 100, indexed: 92, notIndexed: 6, unknown: 2 },
      ],
    },
  };
}

const SECTIONS_ALL: ReportSectionId[] = [
  "summary", "traffic", "queries", "positions", "indexing", "work_done", "next_steps",
];

const render = (over: {
  data?: ReportData; notes?: string; branding?: Record<string, unknown> | null; sections?: ReportSectionId[];
} = {}) => renderReportHTML({
  title: "September report",
  sections: over.sections ?? SECTIONS_ALL,
  data: over.data ?? fixtureData(),
  branding: over.branding === null ? null : (over.branding as never),
  notes: over.notes,
  generatedAt: "2026-09-25T09:00:00.000Z",
});

// ─── the frozen document ──────────────────────────────────────────────────────

test("the snapshot contains no <script> and no event handler attributes", () => {
  const html = render({ notes: "## Notes\n- shipped **pricing** page" });
  assert.ok(!/<script/i.test(html), "no <script> element");
  assert.ok(!/ on[a-z]+\s*=/i.test(html), "no on*= handler attributes");
});

test("the snapshot is self-contained: inline CSS, inline SVG chart, A4 print rules", () => {
  const html = render();
  assert.ok(html.includes("<style>"));
  assert.ok(html.includes("@page"));
  assert.ok(html.includes("size: A4"));
  assert.ok(html.includes("break-before: page"));
  assert.ok(html.includes("<svg"));
  // No external resource of any kind.
  assert.ok(!/<link\s/i.test(html));
  assert.ok(!/src="http/i.test(html));
  assert.ok(!/https?:\/\/[^"]*\.(woff|css|js)/i.test(html));
});

test("branding: logo inline, accent colour used, footer shown, white-label by default", () => {
  const html = render({ branding: {
    companyName: "Acme Agency", logoDataUrl: "data:image/png;base64,QUJD", accentColor: "#ff00aa",
    footer: "Acme — acme.example", website: "https://acme.example", showPoweredBy: false,
  } });
  assert.ok(html.includes("data:image/png;base64,QUJD"));
  assert.ok(html.includes("#ff00aa"));
  assert.ok(html.includes("Acme Agency"));
  assert.ok(html.includes("Acme — acme.example"));
  assert.ok(!html.includes("OpenGSC"), "white-label: no OpenGSC anywhere");
});

test("branding: showPoweredBy names OpenGSC exactly once, in the footer", () => {
  const html = render({ branding: { showPoweredBy: true } });
  assert.equal((html.match(/OpenGSC/g) ?? []).length, 1);
});

test("deterministic: the same input renders byte-identical HTML", () => {
  assert.equal(render({ notes: "same" }), render({ notes: "same" }));
});

// ─── no data ≠ 0 ──────────────────────────────────────────────────────────────

test("a section without data shows the no-data pill, never a zero", () => {
  const data = fixtureData();
  delete data.queries; // tracked, but nothing collected for the period
  const html = render({ data });
  assert.ok(html.includes("No data for this period"), "the queries section carries the pill");
  // The numeric sections that DO have data still show their numbers.
  assert.ok(html.includes("1,180"));
  assert.ok(html.includes("#2"));
});

test("a period with no previous traffic shows an em dash, not +0%", () => {
  const data = fixtureData();
  data.traffic!.previous = null;
  const html = render({ data });
  assert.ok(html.includes("vs prev: —"));
  assert.ok(!html.includes("+0%"));
});

test("clicks of zero draw a baseline tick, not an invisible bar", () => {
  const svg = clicksSvg([{ date: "2026-09-01", clicks: 0 }], "#2563eb");
  assert.ok(svg.includes('stroke="#c8ccd4"'));
});

// ─── the deterministic summary ────────────────────────────────────────────────

test("summary reads direction, best win and priority straight off the numbers", () => {
  const s = buildSummary(fixtureData());
  assert.equal(s.direction, "Clicks +18% vs the previous period (1,180 vs 1,000).");
  assert.equal(s.win, "Best growth — “transfer halkidiki” (+240 clicks).");
  assert.equal(s.priority, "6 page(s) dropped out of the Google index during the period.");
});

test("summary priority order: index losses outrank rank drops, which outrank audit", () => {
  const data = fixtureData();
  data.audit = {
    startedAt: "2026-09-20T00:00:00Z", pages: 100, healthScore: 61, pagesWithIssues: 39,
    topIssues: [{ code: "http_error", severity: "critical", count: 3 }], cwv: [],
  };
  assert.equal(buildSummary(data).priority, "6 page(s) dropped out of the Google index during the period.");
  delete data.indexing;
  assert.ok(buildSummary(data).priority!.startsWith("1 tracked keyword(s) lost positions"));
  delete data.positions;
  assert.ok(buildSummary(data).priority!.startsWith("Audit:"));
});

test("summary with no traffic at all says nothing rather than inventing a zero", () => {
  const s = buildSummary({ siteDomain: "x", window: { from: "", to: "", days: 7, prevFrom: "", prevTo: "" } });
  assert.equal(s.direction, null);
  assert.equal(s.win, null);
  assert.equal(s.priority, null);
});

test("next steps are derived from the period's numbers, capped at six", () => {
  const steps = buildNextSteps(fixtureData());
  assert.ok(steps.some(s => s.includes("night taxi")));
  assert.ok(steps.some(s => s.includes("not indexed")));
  assert.ok(steps.length <= 6);
  assert.deepEqual(buildNextSteps({ siteDomain: "x", window: { from: "", to: "", days: 7, prevFrom: "", prevTo: "" } }), []);
});

// ─── markdown notes ───────────────────────────────────────────────────────────

test("operator notes: markdown subset renders, everything else stays escaped", () => {
  const html = markdownToHtml("## June\n- shipped **pricing**\n- call *Sarah*\n[site](https://example.com/x)");
  assert.ok(html.includes("<h3>June</h3>"));
  assert.ok(html.includes("<li>shipped <strong>pricing</strong></li>"));
  assert.ok(html.includes("<em>Sarah</em>"));
  assert.ok(html.includes('<a href="https://example.com/x"'));
});

test("operator notes: script injection and javascript: links are neutralised", () => {
  const hostile = '## Title\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))';
  const html = markdownToHtml(hostile);
  // No live markup: the payloads survive only as escaped text (&lt;…&gt;), never as tags.
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  // No event-handler attribute and no javascript: URL in anything that IS a tag — the
  // words themselves may appear inside the escaped text, where they are inert.
  const liveMarkup = html.replace(/&lt;[^&]*&gt;/g, "");
  assert.ok(!/\son[a-z]+\s*=/i.test(liveMarkup), "no on*= handler in real tags");
  assert.ok(!/href\s*=\s*["']?\s*javascript:/i.test(html), "no javascript: href");
  // The payload survives as visible text, not as markup.
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("hostile notes inside the full document stay inert", () => {
  const html = render({ notes: "<script>alert('x')</script>" });
  assert.ok(!/<script/i.test(html));
});

// ─── small formatters ─────────────────────────────────────────────────────────

test("delta formatting: null is an em dash, signs and the minus are typographic", () => {
  assert.equal(fmtDeltaPct(120, null), "—");
  assert.equal(fmtDeltaPct(120, 0), "—");
  assert.equal(fmtDeltaPct(118, 100), "+18%");
  assert.equal(fmtDeltaPct(90, 100), "−10%");
});

test("escapeHtml covers the five dangerous characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});
