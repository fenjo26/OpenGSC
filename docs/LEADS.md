# Audit widget, leads and proposals (N9, wave «November»)

An embeddable "check your website" iframe: a visitor types a domain, sees a score and the
top problems, leaves an e-mail — and the workspace receives a **lead with the findings
attached**, plus everything needed to draft the first letter and a commercial proposal.
Task brief: `docs/tasks/wave-nov/N9-audit-widget-leads.md`; the trap that shaped the code
is `CONTRACT.md` §0.6.

## The security model (read this first)

The widget is reachable by **anonymous visitors of the internet**. The public contour —
`/embed/audit`, `/api/public/audit`, `/api/public/lead` — sees exactly one thing of the
owner's data: `User.widgetSettings`, looked up by the public `widgetKey`. No GSC, no sites,
no keys, no other leads. Everything else is a leak.

| Guard | Where | Rule |
|---|---|---|
| SSRF | `liteAudit.ts` (`widgetFetch`) | every outbound request is `safeFetch(url, { allowPrivate: false })` — written out, never inherited. `http://127.0.0.1:9091` through the widget is refused |
| Crawl bounds | `liteAudit.ts` | home + ≤ 4 pages (sitemap else main menu), ≤ 2 MB per page, 25 s wall clock, ≤ 30 HEAD link checks, ≤ 5 redirect hops |
| Rate limit | `ratelimit.ts` | per IP-hash: 5 audits/hour, 20/day, 10 leads/hour; per widget key: 200 audits/day. 429 + `Retry-After` |
| IP privacy | `ratelimit.ts` (`hashIp`) | an IP exists in memory only as `sha256(per-process salt + ":" + ip)`; the salt dies with the process; the raw IP is stored **nowhere** |
| Turnstile | `/api/public/audit` | verified server-side when `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` are set; without keys the widget works and the settings card warns «can be spammed» |
| Origin | `originGuard.ts` | `Origin`/`Referer` hostname must be in `allowedOrigins` (empty = anywhere, warned); subdomains covered; no header + non-empty list = refused |
| Token | `cache.ts` | a Lead (and its report e-mail) requires a one-time token minted by a completed audit — the SMTP relay cannot be driven by posting the form |
| Cache | `cache.ts` | results cached 15 min per key+domain; the cache stores RAW findings so one entry serves every language and no translated string crosses visitors |
| Errors | public routes | short codes only (`rate_limited`, `invalid_domain`, `token`, …); no internal detail |

PSI is **not** called even when the owner has a key: CONTRACT §0.6 forbids the public
contour from reading the owner's keys, and the stricter document wins.

## Embedding

Settings → **Audit widget** → copy the embed code:

```html
<iframe src="https://YOUR-INSTANCE/embed/audit?key=wid_…"
        style="width:100%;height:640px;border:0" loading="lazy" title="SEO audit"></iframe>
```

Auto-height variant — the widget posts `{type: "opengsc:widget:height", height}` to the
parent on every resize:

```html
<iframe id="ogsc-widget" src="https://YOUR-INSTANCE/embed/audit?key=wid_…"
        style="width:100%;border:0" loading="lazy" title="SEO audit"></iframe>
<script>
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.type === "opengsc:widget:height") {
      document.getElementById("ogsc-widget").style.height = (d.height + 8) + "px";
    }
  });
</script>
```

`?lang=xx` (one of `en ru uk fr es de zh`) fixes the widget language; without it the
visitor's browser language is used. Width 320–720 px; the theme follows
`prefers-color-scheme`. The widget's own strings live in `src/lib/leads/i18n.ts` (all
seven languages) — the public page runs outside the app's LanguageProvider, and the locale
files are N0/R's.

## The lite audit (`src/lib/leads/liteAudit.ts`)

Page parsing and rules are **imported from the runtime Site Audit**
(`audit/pageSignals.ts`, `audit/rules.ts`) so a finding means the same thing as in the
operator's crawl. Checks: HTTPS + certificate (via `https:` first), HTTP status and
redirect chains (followed manually so hops are observable), title/description lengths
against `metaLimits`, H1, canonical, noindex, viewport, `lang`, JSON-LD, Open Graph,
security headers, response time, broken same-site links on the home page (≤ 30 HEADs),
mixed content, thin content, images without alt. Score = 100 − 12/5/1 per distinct
critical/warning/info finding, floored at 0.

## Leads (`/leads`, `/api/leads/**`)

Inbox with filters, search, CSV export (formula-injection-safe: a leading `= + - @` is
prefixed with `'`). The card expands into every finding with evidence; **Write** opens a
deterministic `mailto:` draft (greeting, the 3 worst problems in plain words, a call
offer — the operator's template from the widget settings wins if set); **Make client**
sets status `client` and opens `/reports` (a site is never auto-created — sites come from
Search Console). New lead → `leadNewTitle/Msg` notification on the `lead` event, plus an
optional e-mail copy to `widgetSettings.notifyEmail`.

## Proposals (`/api/leads/[id]/proposal`)

Deterministic, **LLM-free**: every sentence comes from the findings dictionary in
`leads/i18n.ts`. Structure: about the company (from settings) → what we found (grouped by
category, each with a plain-language consequence) → scope of work (the operator ticks
which findings to include) → pricing table (operator fills in) → timeline → next step.
Export: branded HTML (reads N8's `User.reportBranding` — logo, colour, footer — never
writes it), printable to PDF from the browser.

**The rule this feature is built around: no forecasts.** A crawl of up to 5 pages cannot
support a traffic, ranking or revenue promise, and a proposal is a document the client
will hold you to. `NO_FORECAST_MARKERS` in `proposal.ts` is the banned-phrase dictionary;
the test walks every language's dictionary and every generated proposal against it. Keep
it that way when adding strings.

## i18n

The `lead*` keys from the brief live in the locale files (N0). Everything else the widget
contour needs — finding titles/fixes/consequences, the report e-mail, the letter, the
proposal skeleton, extra UI labels — lives in `src/lib/leads/i18n.ts` in all seven
languages, because the public page has no session locale and the locale JSONs are owned by
N0/R. `t2()` reads the locale first, so a key R later migrates into the locales keeps
working.

## Orbitra bridge (lead → tracker campaign)

For operators who also run [Orbitra.link](https://orbitra.link/?utm_source=opengsc) — a
self-hosted traffic tracker — the lead inbox connects to it directly:

1. In Orbitra: **Users → API keys** → create a key with the **write** scope.
2. In OpenGSC `/leads`: the **Orbitra tracker** card at the top → paste the tracker URL
   and the key → Save → *Test connection* (one read call proves both halves).
3. Every lead now carries a **“→ campaign in Orbitra”** button. It creates one campaign
   named after the lead's domain (`alias ogsc-<domain>-<timestamp>`, no streams or offers
   invented — a shell you fill in when the traffic starts). The lead then shows an
   `Orbitra ↗` badge with the created campaign's alias; the button never creates a second
   campaign for the same lead.

The other direction needs no setup at all: the audit widget is a plain iframe, so it can
be embedded into an Orbitra landing page — leads from paid traffic then arrive here with
the landing's URL in the `origin` field (subids included, if the landing URL carries
them).

The URL/key live in `InstanceSetting` (`orbitra_url` / `orbitra_key`); the lead row only
stores the created campaign's `orbitraCampaignId` / `orbitraAlias`. The bridge never runs
from the public contour.
