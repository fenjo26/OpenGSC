# Indexing

Site → **Indexing** tab. Two separate jobs are kept apart on purpose:

- **Check**: what does Google know about this URL? (URL Inspection, `site:` estimates)
- **Submit**: ask an engine to crawl it. (IndexNow, Bing/Yandex APIs, paid accelerators)

URL Inspection **reports** what Google knows. **It doesn't request indexing** and doesn't speed it up.

## Sitemap inventory

A persistent inventory of the site's sitemaps: recursive sitemap indexes, gzip, image/video/news extensions, up to 20,000 URLs.

- For each URL: source sitemap, `lastmod`, first and last seen, and the **added / changed / disappeared** diff between syncs.
- A URL is only called *disappeared* after **two complete syncs** miss it. A failed or partial child-sitemap fetch never advances that state.
- **Audit from sitemap** seeds the [Site Audit](Site-Audit-Health-Uptime#site-audit) crawler with active inventory URLs, which helps find orphan pages.
- New site with no traffic yet? The inspection tool falls back to up to 20 URLs from `sitemap.xml`.

## Google URL Inspection

Genuine Google verdicts through your own OAuth: coverage state, verdict, Google-selected canonical vs. yours, last crawl.

### Automatic index checks (free)

**Indexing → Automatic index checks.** Google gives every property **2,000 inspections per day** (reset at midnight Pacific time). Previously you could only spend them by pressing a button; the scheduler now spends them for you.

- **Daily budget** for automation: 0–1,800 (default 1,000). Manual checks aren't limited by it.
- **Priority queue**: never checked → changed in the sitemap → not indexed (re-checked every 3 days by default) → indexed (re-checked every 14 days by default). Intervals are configurable.
- The scheduler ticks every 10 minutes and spreads the budget across the day. A page that drops out is usually found the same day.
- Manual checks, the MCP `inspect_url` tool and the automation share **one quota ledger**, so automation can't starve the button. Once Google returns a quota error, all paths stop until Pacific midnight instead of hammering it.
- **Coverage chart**: indexed / not indexed / unknown per day for 90 days, with reasons.
- **Index-loss alert**: a URL that had clicks in the last 28 days and moved from *indexed* to *not indexed* triggers one notification per site per day (event `index`).
- **Check a batch now** runs the same queue on demand (up to 200, spends quota).

Unchecked URLs count as **unknown**, never as "not indexed".

### When you still need paid checkers

- The site isn't in your Search Console (URL Inspection only works for verified properties).
- More than 2,000 URLs a day on one property. The queue copes over several days, but you can't buy more quota.

## `site:` index estimate (paid)

For URLs Google's quota can't reach (sites outside your GSC, drops, PBN domains): **Check via site:** runs `site:` queries through your SERP provider. The first click shows the price, the second runs it. Up to 200 URLs per call. Results land in a separate **site:** column, labelled as an estimate. A captcha is reported as an **error**, never as "not indexed".

## Submitting URLs

### IndexNow

Notifies Bing, Yandex, Seznam, Naver and others through `api.indexnow.org`. One push covers them all. No account needed:

1. Generate a key: `openssl rand -hex 16`.
2. Serve it at `https://your-domain.com/<key>.txt` with the key as the file's only content.
3. Paste it in **Settings → Indexing → IndexNow**.
4. Push URLs from site → Indexing → **Search engines** panel (one per line).

Google doesn't use IndexNow. For Google, use sitemaps and Search Console.

### Paid accelerators (optional)

| Service | What it does | Where to configure |
|---|---|---|
| **2index.ninja** | URL submission for indexing | Settings → Indexing |
| **NeuralIndexer** | Queued slow / fast / Yandex indexing with balance and job polling | Settings → Indexing |
| **XMLRiver** | Index-status verification through Google SERP (also used by the Backlinks checker) | Settings → SERP & scraping |

Each one is opt-in and needs its own account.

### Private Bot Farm

If you run the [Private Indexer Network](Indexer-Network), the Indexing tab can push a site's sitemap URLs into the doorway link queue.

## Bing Webmaster and Yandex.Webmaster

Optional. They add live Bing/Yandex dashboards (site page engine switcher and the dashboard's engine tabs), digests per engine, and submit actions. Bing/Yandex data is fetched live and **isn't stored** in your database. Google is the only locally synced source.

### Bing Webmaster: API key

> Use the **API Key** method, **not** OAuth Client. OpenGSC has no field for a Bing Client ID/Secret.

1. In [Bing Webmaster Tools](https://www.bing.com/webmasters), add and verify your sites. *Import from Google Search Console* is the fastest way.
2. **⚙ Settings → API Access → API Key → Generate API Key.** One key per Bing user covers all their sites.
3. **OpenGSC → Settings → Bing Webmaster**: add it as a connected account (name + key). With several Bing accounts, add each and choose the account per site in the site's Indexing tab.

You get clicks/impressions series, top queries with average position, top pages, crawl stats (pages in index, 4xx/5xx, robots.txt blocks) and sitemap submission. Quota: 10,000 requests per day per key.

### Yandex.Webmaster: OAuth token

1. Add and verify your sites in [Yandex.Webmaster](https://webmaster.yandex.com).
2. Go to [oauth.yandex.ru](https://oauth.yandex.ru) → **Create app**.
   - Name: anything, e.g. `OpenGSC`.
   - Platforms: tick **Web services**, Redirect URI: `https://oauth.yandex.ru/verification_code`.
   - Permissions: under **Yandex.Webmaster**, tick all boxes.
   - Create, then copy the **ClientID**.
3. Open `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>` and click **Allow**. Copy the token (starts with `y0_…`).
4. **OpenGSC → Settings → Яндекс.Вебмастер**: paste it as the global default token or into a specific account.

The token lasts about a year. To renew, repeat step 3 with the same ClientID.

You get SQI (ИКС), pages in search / excluded, 8 weeks of clicks and impressions, top-25 queries, Yandex's site diagnostics, sitemap submission and **recrawl** (up to 10 URLs per click, within Yandex's daily per-host quota).

### Bing / Yandex FAQ

- **No Bing / Я buttons**: the key or token isn't saved yet, or the page needs a reload.
- **Yandex "site not found in this account"**: the token belongs to a Yandex account that doesn't have that exact host.
- **Bing shows empty stats**: newly verified sites need a few days.
- **Why "≈" on positions?** Neither engine exposes a daily sitewide position. OpenGSC shows an impression-weighted average of the top queries: good for trends, not comparable with the GSC number.

## MCP

`get_indexing_status`, `get_index_coverage` (free), `inspect_url` (Google quota), `serp_index_check` (paid, `confirm: true`), `index_check_queue` (paid, `confirm: true`), `index_check_queue_status` (free).

## Mass index check (/index-check)

The Indexing tab answers "what does Google say about this site" on Google's free URL Inspection
quota; `/index-check` answers "what does the public search say about many URLs at once" — as one
queued, paid run.

- **Providers**: your SERP provider (`site:` query — the one from Settings → SEO Tools) or **XML
  River's direct indexed? check** (usually cheaper; needs the XR keys). XR runs are priced from
  the optional *price per check* field on the XR settings card — empty means the estimate shows
  the URL count only ("priced by your tariff"), and no units are recorded.
- **Sources**: your sites (multi-select, filtered to *never checked*, *Google says not indexed*
  or the whole inventory), a pasted URL list (foreign URLs included — donors, drops), or every
  purchased donor page.
- **The run** drains sequentially in the background (one provider call per item, 300–800 ms
  apart), survives a reload and a server restart, and can be paused or stopped — a stop skips
  the queued URLs but lets the call in flight land, because its money is already committed. One
  active run per user. Ten consecutive provider errors pause the run and fire one alert.
- **Verdicts** use the same vocabulary and semantics as the Indexing tab's site: column: a
  provider failure is `error`, NEVER `not_indexed`. Own-site URLs persist into that table;
  foreign URLs live in the run only.
- **The not-found list** (every `not_indexed` verdict, deduped, no errors/unchecked) is copied,
  downloaded as .txt, or pushed straight into NeuralIndexer / 2index / the doorway farm with one
  click — the check → fix loop never leaves the app.

Deploy note: requires `npx prisma db push` (the `SerpCheckRun`/`SerpCheckItem` tables and the
`User.xmlRiverPriceUsd` column).

MCP: `index_check_queue` (paid, `confirm: true`), `index_check_queue_status` (free).
