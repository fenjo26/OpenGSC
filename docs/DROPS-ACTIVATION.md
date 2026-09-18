# Drops Activation — runbook

The drops funnel ends at `acquired`. This runbook covers everything after: turning a
freshly bought drop domain back into a site Google crawls and indexes. The module lives
in the **Activation** tab of `/drops`, backed by `DropAsset` / `DropLegacyUrl` /
`DropDonor` / `DropDonorPlacement` (deploy note: `prisma db push` + `npx prisma generate`).

## The pipeline

```
harvest → bundle → host → GSC submit → IndexNow → donors → measure (log upload)
```

| # | Step | What happens |
| - | ---- | ------------ |
| 1 | **Harvest** | The domain's legacy URL space from Wayback CDX (and from GSC once the property exists) lands in `DropLegacyUrl`. Stage: `new → harvesting`. |
| 2 | **Bundle** | Build the deploy bundle: `sitemap.xml` (from the harvested URLs), `robots.txt`, the IndexNow key file `/{key}.txt`, and the nginx snippet below. Stage becomes `ready`. |
| 3 | **Host** | Place the three files on the asset host (one directory per domain under `/srv/activation/<host>/` in the snippet's layout). As far as this pipeline is concerned, the three files *are* the site — the rest of the host can stay a 301 to wherever you point it. |
| 4 | **GSC submit** | Add the property in Search Console yourself (see below), then submit the sitemap from the Activation tab — the submit runs through your own OAuth and records the submission time on the asset. |
| 5 | **IndexNow** | Push the legacy URLs in batches of 10 000 (the protocol's per-request cap). Honestly scoped: **Bing and Yandex** read IndexNow; **Google does not**. This is why sitemap + GSC is the main channel and IndexNow is a bonus. |
| 6 | **Donors** | Accelerate Google's re-crawl through the indexer network: doorway domains enqueue **donor** URLs into their queues. Optional, and never the primary channel. |
| 7 | **Measure** | Paste the asset host's access log back into the tab; the parser counts Googlebot hits (total, 7-day window, last seen) onto the asset. Manual, deliberately — no scheduler yet. |

Stages: `new | harvesting | ready | live | paused` — moved by the steps above and by hand.

## The nginx order — read this before declaring anything "done but dead"

`/robots.txt`, `/sitemap.xml` and `/{indexnow-key}.txt` **must be served as files BEFORE
the catch-all 301**. Placed after it, they redirect away: the key file answers with a 301,
and IndexNow rejects the push **silently** — no error surfaces anywhere, not in the panel,
not in the push status. robots.txt and the sitemap are equally never read. This is the
#1 "everything looks done, nothing happens" cause of this pipeline.

The bundle endpoint returns this snippet verbatim (`NGINX_SNIPPET` in
`src/lib/drops/activation.ts`):

```nginx
# ── drops-activation bundle ──────────────────────────────────────────────
# These locations MUST stay ABOVE the catch-all 301. Below it the files redirect
# away and IndexNow rejects the key file silently.
location = /robots.txt    { root /srv/activation/<host>; }
location = /sitemap.xml   { root /srv/activation/<host>; }
location ~ ^/[0-9a-f]{32}\.txt$ { root /srv/activation/<host>; }
# ── existing catch-all 301 stays below this line ──────────────────────────
```

`<host>` is a literal placeholder: create one directory per asset domain under
`/srv/activation/` and drop the bundle's three files there. After deploying, verify the
order with `curl -sI https://<host>/robots.txt` — the answer must be `200`, not `301`.

## GSC: the one manual step

Adding the property in Search Console **cannot be automated**: verification requires a
DNS record or an HTML file only the domain's owner can place, and the Search Console API
offers no add-property-and-verify path. So: add `sc-domain:<domain>` (or a URL-prefix
property) in GSC yourself, verify it the way you normally would, and only then hit
**Submit sitemap** in the Activation tab.

## Doorway eligibility

A doorway (an indexer-network domain) is usable for the donor accelerator only with a
**confirmed Google crawl**: at least `GOOGLE_CRAWL_MIN_HITS = 1000` hits over the last
`DOORWAY_WINDOW_DAYS = 30` days, summed from `IndexerDailyStat`. The eligible list is
**recomputed on every run and never stored** — crawl patterns shift within a month, and
a stored list rots exactly that fast.

Why 1000 and not simply "> 0": on 2026-09-18 the network is 13 domains, of which Google
genuinely visits **3** — `deadp47.shop` (47 694 hits / 30d), `carcolor.shop` (31 135),
`juliet.autos` (27 698). A literal `> 0` would select 10 of 13, including domains Google
touched 4–7 times in a month — doorways Google never crawls are dead weight in the queue
and a footprint for nothing.

## The footprint rule: donors only, never the asset

Every link the indexer network creates for an activation goes to a **donor page** — a
third-party page that already links to the asset — and never to the asset itself. The
edge «дорвей → домен» must not exist anywhere in the network. The reason is the network's
own survival: a doorway's outbound links are its fingerprint, and a doorway linking to
the very domain it was rented out to promote is the one pattern that ties the whole
network to a single operator's goal. `isDonorAllowed()` (in `src/lib/drops/activation.ts`)
rejects any donor URL on the asset's host — www and subdomains included — at donor input,
and the placement runner re-checks the same rule before every write, so a caller cannot
forget half of the rule.

## Measuring: upload the access log

`POST /api/drops/activation/<domain>/crawl-log` with `{ log }` — a pasted nginx
`combined` (or `common`) access log of the asset host. The parser
(`src/lib/drops/crawlLog.ts`) is liberal and total: garbage lines are counted in
`skipped`, never a 500.

A line counts as a Googlebot hit when its user agent contains `Googlebot`
(case-insensitive) and the HTTP status is below 400 — redirects count, errors do not.
A line without a user-agent field (common format) parses but cannot be attributed and
therefore does not count. The 7-day window is whole UTC midnights
(`utcMidnightDaysBetween`) — a hit at 23:30 UTC counts for the day the log says, not for
the day your reading timezone thinks it is. The summary — `hitsTotal`, `hits7d`,
`lastHitAt`, `skipped` — is returned in the response, and `lastGoogleHitAt` +
`googleHits7d` are written onto the asset. The last upload wins, so paste the freshest
log, not a growing archive.
