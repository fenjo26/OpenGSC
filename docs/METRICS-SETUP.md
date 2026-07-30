# Metrics Setup — Keyword Weights, Backlinks & Competitors

Search Console tells you how you are performing. It cannot tell you how much demand exists, how
hard a keyword is to win, or who is winning instead of you — those numbers come from a third
party. This module brings Ahrefs and Semrush data into OpenGSC and, more importantly, joins it
with your own GSC data, which produces answers neither source has on its own.

Everything here is **optional**. With nothing configured, OpenGSC behaves exactly as it did
before: the free Domain Rating on dashboard cards keeps working with no key, and every new
column simply shows an em dash.

## 1. Two ways to get the data in

| | Import (free) | API (paid) |
|---|---|---|
| Source | a CSV you exported from Ahrefs/Semrush yourself | an API key |
| Cost | nothing — your browser subscription already includes exports | ~$1.25/month minimum |
| Effort | manual, per file | one button |
| Good for | one-off bulk data: a full backlink profile, a big keyword list | anything that has to refresh on its own: alerts, MCP, weekly checks |

**Both write into the same cache.** Every feature works identically whether the numbers were
bought or uploaded, so an API key is an upgrade in convenience, never a requirement.

If you have a browser subscription (including a group-buy one) you likely already have
thousands of export rows per day included in what you pay. Importing is the cheap path; the API
is for what should not need a human.

### Importing a file

**SEO Tools → Import metrics.** Drop the export in, pick the market it belongs to, press
Import. The report type is detected from the column headers — you do not say what it is.

Recognised exports:

| Export | What it fills |
|---|---|
| Keywords Explorer / Organic keywords | volume, KD, CPC → Striking Distance, Rank Tracker |
| Referring domains | the backlink profile of one of your sites |
| Domain-level metrics | referring domains and organic traffic on dashboard cards |

Two details worth knowing:

- **A referring-domains file needs a target site.** The file lists links pointing at something
  but never says at what, so you pick which of your sites it belongs to.
- **The file's own date is used, not the upload time.** A month-old export will not overwrite
  fresher data fetched since — and an import never marks a link as lost, because a filtered or
  truncated export cannot prove a link is gone.

### Configuring an API key

**Settings → SEO Metrics.** Everything for these two providers is on that one screen — key,
host, cap and usage. Nothing about Ahrefs or Semrush is configured anywhere else.

1. **Data provider** — Ahrefs or Semrush. Ahrefs is cheaper for every task in this module, and
   backlink data is Ahrefs-only.
2. **Where your key comes from** — this is the question that decides the host, so you answer it
   in those words rather than typing a URL:
   - **Official API** — you have your own Ahrefs/Semrush subscription with API access. Requests
     go to `api.ahrefs.com` / `api.semrush.com`.
   - **Reseller** — credits bought from a group-buy provider. Same protocol, different host;
     it is filled in for you.
   - **Custom gateway** — anything else that speaks the official API. You enter the host.
3. **API key** — paste it into the card.
4. **Spending** — set a **monthly unit cap**. Requests are priced before they are sent and
   refused above this number: the safety net against one click on a very long list. Units spent
   this month are shown beside it.

Link Monitor uses the same key and host, so a gateway user does not need a second official key.

## 2. What it adds

### Keyword weights — Striking Distance and Rank Tracker

Impressions are not demand: they are demand filtered through your current visibility. A keyword
sitting at position 18 shows a small number no matter how big its market is. Volume is the
market itself, and the gap between the two is what Striking Distance is for.

Columns: **Volume**, **KD**, **Potential** (roughly what the keyword could bring near the top of
page one, minus what it brings now). Sort by Potential to order the list by opportunity rather
than by current exposure.

Nothing loads automatically. Press **Load weights** and it fetches only the keywords currently
missing from the cache, for the visible selection.

> **KD is a checkbox and it is off by default.** Keyword Difficulty costs 10 units per row on
> Ahrefs against 1 for most fields — it roughly doubles the price of a load. Turn it on when you
> are choosing what to attack, leave it off when you just want demand.

### Backlink profile

**Site → Backlinks.** Referring domains, live and lost, with a stored history of counts. Sits
above the manual backlink list rather than replacing it: the profile answers "what points at
me", the list answers "did the link I built survive".

Lost links are derived by diffing pulls, not fetched separately — so the first pull has no lost
rows, and a filtered pull deliberately marks nothing as lost.

An alert (**Settings → Notifications → Lost backlinks**) fires when a referring domain above a
DR threshold disappears. It reads stored rows only and never calls a provider, so enabling it
costs nothing by itself; it can only fire after a profile refresh.

### Competitors — the keyword gap

**Competitors** in the main menu. Find competitors, pull one's keywords, and the result is
crossed with your Search Console data into three verdicts:

| Verdict | Meaning | What to do |
|---|---|---|
| **Within reach** | they rank, you rank in the top 30 | improve the page — the URL is in the row |
| **Wrong page** | they rank, you get impressions but nothing wins | intent mismatch |
| **No content** | they rank, you are absent | write it |

The gap is recomputed on every read rather than stored: competitor keywords change slowly, your
own positions change daily.

### Demand history in Content Decay

Clicks falling with demand flat is a ranking problem. Clicks falling *with* demand is the
market, and no rewrite fixes that. The **Demand** column checks the page's top query on request
and returns a verdict, not a chart.

### Domain check in the Indexer

A DR/RD chip on every network domain. A dropped domain with no live link profile is worth
nothing, and that is cheaper to learn before you build on it.

### MCP tools

Four tools — `get_keyword_metrics`, `get_domain_metrics`, `get_backlink_profile`,
`get_competitor_gap` — all in the **local** cost tier.

They read the cache and **never fetch**. An agent cannot spend your credits, because it has no
way to know whether you consider a question worth paying for. An empty result therefore means
"not loaded yet", never "zero", and the tool descriptions say so explicitly.

## 3. What it costs

Ahrefs bills `max(50, per_row_cost × rows)`. Most fields cost 1 unit; a few cost 5 or 10 —
`volume` and `difficulty` among them. **The field selection is the price**, not the endpoint.

Two consequences:

- **The 50-unit floor makes small requests wasteful.** One keyword costs the same as four. This
  is why loading is batched and never happens per row.
- **Filters are billed too.** Columns used in `where`/`order_by` cost the same as displaying
  them.

Every button shows its price before you press it. Rough figures at group-buy rates
($0.000025/unit for Ahrefs):

| Action | Units | ≈ USD |
|---|---|---|
| 100 keywords, no KD | 1 300 | $0.03 |
| 100 keywords, with KD | 2 300 | $0.06 |
| Domain metrics, one domain | 100 | $0.0025 |
| Backlink profile, 100 referring domains | 550 | $0.014 |
| Competitor keywords, 200 rows | 2 600 | $0.07 |

**Ahrefs is cheaper than Semrush for everything this module does** — notably Keyword Difficulty
(10 units vs 50) and the keyword gap, which Ahrefs covers via organic-competitors at a fraction
of Semrush's `domain_domains` price. Semrush support exists for people who already have a key;
it is not the recommended default, and backlink data is Ahrefs-only.

### Rate limits

Three concurrent requests per key, then `429`. The client queues rather than fanning out, and
retries `429` and `502` with backoff.

## 4. Notes on group-buy access

The module speaks the official Ahrefs API v3 protocol. Some resellers expose a gateway that is
wire-compatible with it, in which case only the host differs — that is what the **custom base
URL** field is for.

Two things to be aware of, stated plainly:

- Reselling API access is against Ahrefs' and Semrush' terms of service, and such access can be
  withdrawn without notice. That risk is yours, not the project's.
- Nothing in OpenGSC depends on it. The official endpoints are the defaults, the import path
  needs no API at all, and the free Domain Rating keeps working regardless.

## 5. Troubleshooting

**"This report was not recognised"** — the importer lists the columns it actually found under
the error. Ahrefs occasionally renames export headers; open an issue with that list and it is a
one-line fix.

**Import says it saved rows but nothing appears** — check the market. Volumes are stored per
country, and a US import will not show against a list you are viewing as `de`.

**`400` from the API** — usually an invalid field in `select`. Check `pm2 logs opengsc`; the
provider's error text is passed through verbatim.

**Nothing loads and the button is disabled** — either no key is set (the tooltip says so) or
everything visible is already cached. The button label switches to *Refresh weights* once data
exists.

**Cap reached** — raise the monthly unit cap in Settings, or wait for the next month. The cap is
enforced before the request is sent, so nothing was spent.
