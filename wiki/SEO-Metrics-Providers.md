# SEO Metrics Providers

Search Console tells you how you're performing. It can't tell you how much demand exists, how hard a keyword is, or who's winning instead of you. Those numbers come from a third party. OpenGSC brings them in and **joins them with your own GSC data**, which gives answers neither source has alone.

Everything here is optional. With nothing configured, every new column shows `—` and the free Ahrefs DR badges on dashboard cards keep working.

## What it adds

| Feature | Where |
|---|---|
| Volume, KD, CPC, **Potential** columns | Potential (striking distance), Rank Tracker |
| Backlink profile, lost-link alert | Site → Backlinks |
| Competitor keyword gap: *within reach* / *wrong page* / *no content* | SEO Tools → Competitors |
| Demand check in Content Decay | Decay |
| DR / referring-domain chip per network domain | Indexer, Drops |
| `get_keyword_metrics`, `get_domain_metrics`, `get_backlink_profile`, `get_competitor_gap` | MCP (free, cache-only) |

## Two ways to get data in

| | **Import (free)** | **API (paid)** |
|---|---|---|
| Source | A CSV you exported from Ahrefs/Semrush | An API key |
| Cost | Nothing; exports are part of your browser subscription | From ~$1.25/month at reseller rates |
| Effort | Manual, per file | One button |
| Good for | One-off bulk data: a whole backlink profile, a big keyword list | Anything that must refresh by itself: alerts, MCP, weekly checks |

**Both write into the same cache**, so every feature works the same whichever way the numbers arrived.

### Importing a file

**Settings → SEO Metrics → Import metrics.** Drop the export in, pick the market (country) it belongs to, press **Import**. The report type is detected from the column headers:

| Export | Fills |
|---|---|
| Keywords Explorer / Organic keywords | Volume, KD, CPC |
| Referring domains | One site's backlink profile (you pick which site) |
| Domain-level metrics | Referring domains and traffic on dashboard cards |

The **file's own date** is used, not the upload time. An old export won't overwrite fresher data, and an import never marks a link as lost.

### Configuring an API

**Settings → SEO Metrics.** Everything for these providers is on that one screen: key, host, cap and usage.

1. **Provider**:
   - **Ahrefs**: keywords + links. The reference.
   - **Semrush**: keywords + links. Supported for existing subscribers; more expensive here.
   - **Majestic**: **links only** (Trust Flow, Citation Flow, referring domains) at a fraction of Ahrefs' link price. With Majestic active, keyword tools keep using your Ahrefs/Semrush key.
   - **DataForSEO**: backlink profiles pay-as-you-go ($0.024 per request + $0.000036 per row, no subscription), using the same credential as SERP and Demand.
   - **Crawlgraph**: links only, flat-priced — one API call = one unit (profile pull, changes diff or gap job; $19/month for 1 000 calls, free tier 15). Domain-level data over quarterly Common Crawl snapshots; `cg_authority` is its own 0–100 percentile, never DR.
   - **Keys.so**: the Yandex / Runet market. Backlink profile and domain metrics from its own index (labelled `DR·KS`), Yandex AI answers, a Yandex market for Competitors and Demand, Yandex Direct in Ads. Works with an official `api.keys.so` token or a GroupBuySEO key; the settings card checks the key for free and shows remaining credits.
2. **Where your key comes from**:
   - **Official API**: `api.ahrefs.com` / `api.semrush.com` / `api.majestic.com`.
   - **Reseller**: credits from a group-buy provider; the host is filled in for you.
   - **Custom gateway**: anything that speaks the official protocol; enter the host.
3. **API key**.
4. **Monthly unit cap**: requests are priced *before* they're sent and refused above the cap. Units spent this month are shown alongside.

Link Monitor uses the same Ahrefs key and host.

## What it costs

Every button shows its price before you press it. Nothing fetches on page load.

**Ahrefs** bills `max(50, per-row cost × rows)`. Most fields cost 1 unit, `volume` and `difficulty` cost more. **The fields you select are the price.** That's why loading is batched (one keyword costs the same as four) and **KD is an opt-in checkbox**: it costs 10 units per row and roughly doubles a load.

Rough figures at group-buy rates (Ahrefs $0.0001/unit, Semrush $0.00006, Majestic $0.000002):

| Action | Units | ≈ USD |
|---|---|---|
| 100 keywords, no KD | 1,300 | $0.13 |
| 100 keywords, with KD | 2,300 | $0.23 |
| Domain metrics, one domain (Ahrefs / Majestic) | 100 / 1 | $0.01 / $0.000002 |
| Backlink profile, 100 referring domains (Ahrefs / Majestic) | 550 / 1,101 | $0.055 / $0.0022 |
| Competitor keywords, 200 rows | 2,600 | $0.26 |

For keywords, Ahrefs is cheaper than Semrush in this module (KD 10 vs 50 units). For links, Majestic is now the budget pick, about 25× cheaper than Ahrefs for the same referring-domain pull.

Rate limits: 3 concurrent requests per key, then `429`. The client queues and retries `429`/`502` with backoff.

## About resellers

The **Get key** links on these cards are referral links to a reseller, the only referral links in the project. Nothing depends on them: official hosts are the default, the custom-gateway field accepts any compatible host, and CSV import needs no API at all. Reselling API access is against Ahrefs' and Semrush's terms and can be withdrawn without notice. That risk is yours to weigh.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "This report was not recognised" | The importer lists the columns it found. Headers sometimes change; open an issue with that list |
| Import saved rows but nothing appears | Wrong market. Volumes are stored per country |
| `400` from the API | Usually an invalid field; `pm2 logs opengsc` has the provider's text verbatim |
| Button disabled | No key set (tooltip says so), or everything visible is already cached (*Refresh weights*) |
| `503` from a reseller gateway | The gateway, not OpenGSC. Check its status or switch provider (DataForSEO and Majestic are cheap alternatives) |
| Cap reached | Raise the cap or wait for next month; nothing was spent |

Internals (routing, caches, price model): [docs/METRICS.md](https://github.com/fenjo26/OpenGSC/blob/main/docs/METRICS.md).
