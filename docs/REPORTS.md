# Client reports (N8, wave «November»)

White-label client reports: a constructor, a **frozen HTML snapshot** (+ PDF when the server
has a browser), scheduled e-mail and a client-facing link. This doc is the map of the feature;
the task brief is `docs/tasks/wave-nov/N8-client-reports.md`, the wave contract is
`docs/tasks/wave-nov/CONTRACT.md` (§0.7 is the trap that shaped most of this code).

## The one rule everything hangs on

**A sent report is a snapshot, not a live view.** The moment a report is created (Send now or
the scheduler), the fully rendered HTML is stored in `ClientReportRun.html` and is never
re-rendered — not when branding changes, not when data changes, not when the section's data
source gains rows. The numbers a client received in September stay the numbers they received.

The companion rule: a client link (`/share/report/<token>`) opens exactly **one report's
snapshots** — never the site dashboard, never another report. The existing
`/share/<siteId>/<token>` read-only dashboard is a different mechanism with a different token
(`Site.shareToken`) and the two cannot be exchanged for each other.

## Pieces

| Path | What |
|---|---|
| `src/lib/reports/sections.ts` | Section vocabulary (`ReportSectionId`, 14 ids), templates → default section sets, canonical ordering |
| `src/lib/reports/branding.ts` | `ReportBranding` (User.reportBranding): company, logo ≤ 200 KiB data-URL (png/svg/jpeg), accent colour, footer, website, `showPoweredBy` (default off — white-label) |
| `src/lib/reports/schedule.ts` | `nextSendAt` (weekly = ISO weekday 1–7, monthly = day 1–28 — **29–31 are not representable**; both fire 09:00 UTC), recipient parsing (≤ 20, deduped) |
| `src/lib/reports/collect.ts` | Per-section data collectors over the existing modules (`DailyMetric` directly, `uptimeSummary`, `sovForSite`, `SiteAudit` summary + PSI, `TrackedKeyword`/`RankCheck`, `SiteBacklink`, `GbpReview`, `LocalCitation`, `IndexCoverageDaily`) |
| `src/lib/reports/render.ts` | The snapshot renderer: self-contained HTML, inline CSS + inline SVG chart, **no `<script>`**, `@page A4` + page breaks, deterministic "direction + win + priority" summary and derived next steps |
| `src/lib/reports/pdf.ts` | Playwright PDF (dynamic import — no browser → `pdf_unavailable`, the HTML is the fallback and prints to PDF from any browser) |
| `src/lib/reports/mail.ts` | The client e-mail: recipients of the report, SMTP from the October e-mail channel, same SSRF guard; **no attachments** (see below) |
| `src/lib/reports/store.ts` | CRUD, share tokens (32 random bytes, base64url), snapshot creation, send pipeline, `reportsSchemaMissing` → `notMigrated` |
| `src/lib/reports/scheduler.ts` | Hourly tick (serpmon pattern): due = `schedule != off && (nextSendAt null || <= now)`, ≤ 10 per tick, reschedules after send **and after failure** (an SMTP outage must not spin the renderer hourly) |

Routes: `/api/reports` (GET list, POST create), `/api/reports/[id]` (GET/PATCH/DELETE),
`…/send` (POST), `…/preview` (GET, live HTML, not stored), `…/share` (POST rotate / DELETE
disable), `…/runs/[runId]` (GET `?format=html|pdf`), `/api/reports/branding` (GET/PUT), and
the public `GET /api/reports/share/[token]` (JSON list; with `?run=&format=html|pdf` the
artifact) — the token is compared in constant time (`timingSafeEqual` over SHA-256 of every
stored token; > 1000 linked reports refuses rather than scan partially).

UI: `/reports` (list + constructor `ReportEditor` + send/link/runs), `/share/report/[token]`
(client page, zero mutating controls), Settings → `ReportBrandingCard`.

MCP: `list_reports` (local, read-only).

## Sections and where the data comes from

`summary` (deterministic: clicks ±% vs previous period, best query delta, first priority the
data shows — index losses > rank drops > audit criticals > lost links > uptime incidents;
**no forecasts, no LLM**), `traffic` (web rollup rows only — `url='' query='' searchType='web'`,
period vs previous, SVG column chart), `queries` (top 20 + deltas), `pages`, `positions`
(Rank Tracker: top-3/top-10 counts, biggest movers), `local_positions` (location-tracked
keywords, map-pack places, NAP citation status counts — N3/N4 data), `indexing`
(IndexCoverageDaily first/latest), `audit` (last completed audit: health score, top issues by
severity, Core Web Vitals sample — CWV ride inside `audit`, there is no separate `cwv`
section), `uptime` (`uptimeSummary` + incidents in window), `backlinks` (new by
`apiFirstSeen` in window, currently-lost count, avg DR, top new), `ai_visibility`
(`sovForSite` mention/citation share), `reviews` (GbpReview in window), `work_done`
(operator markdown, escaped-first subset: headings/bold/italic/lists/https links),
`next_steps` (derived from the numbers, like the summary).

A section with nothing collected renders the "no data" pill — **never a zero** (`null ≠ 0`).

## Templates

- `executive` — summary, traffic, queries, positions, work_done
- `detailed` — executive + pages, indexing, backlinks, uptime
- `technical` — audit (incl. CWV), indexing, uptime
- `local` — local_positions (incl. NAP), reviews

## Scheduling

Weekly (`sendDay` 1–7, ISO weekday) or monthly (`sendDay` 1–28) at **09:00 UTC**. Editing a
report reschedules from *now*. After a send — or a failure — `nextSendAt` advances to the next
period; the failed run keeps its `error` (e.g. `smtp_not_configured`) and the list shows
«SMTP не настроен». Without SMTP the report and snapshots still work; only the mail is off.

## The attachment question (for R / N10)

`sendEmail()` in `src/lib/notify/channels.ts` takes `(cfg, title, text)` and sends to the
channel's own `to` list — no per-call recipient override, no attachments, no custom HTML.
N8 therefore cannot use it for the client mail and builds its own transport from the same
stored config (`readChannels` + the same `assertSafeTarget` guard) in
`src/lib/reports/mail.ts`. The e-mail carries the client link instead of the PDF.

To attach PDFs, extend `sendEmail` (or add `sendEmailFull`) in `channels.ts` (N10's file) with
an options object — suggested shape:

```ts
sendEmail(cfg, title, text, opts?: { to?: string[]; html?: string; attachments?: { filename: string; path: string }[] })
```

and make `to` override `cfg.to` (semantics of the notify fan-out unchanged when omitted).
`sendReportEmail` in `src/lib/reports/mail.ts` is one small function to swap onto it.

## i18n

The frozen HTML speaks built-in English (a snapshot must not depend on locale files; the
operator's notes render verbatim in whatever language they were written). The dashboard UI
uses the `rep*` keys from the N0 table plus additional keys listed in the N8 report
(`repSection_*`, `repEdit`, `repSite`, `repSendDay`, …) — they show as raw keys until R's
locale pass, by the wave's rules.
