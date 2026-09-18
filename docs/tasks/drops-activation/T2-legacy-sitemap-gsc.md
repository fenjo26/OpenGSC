# T2 — Legacy URL harvest + sitemap bundle + GSC submit

Priority 1 of the wave (README). Google crawls sitemaps and reads GSC — this is the
main re-activation channel.

## Files (exclusive ownership)

- `src/lib/drops/legacyUrls.ts` (+ `legacyUrls.test.ts`) — NEW.
- `src/app/api/drops/activation/[domain]/harvest/route.ts` — NEW.
- `src/app/api/drops/activation/[domain]/bundle/route.ts` — NEW.
- `src/app/api/drops/activation/[domain]/gsc-submit/route.ts` — NEW.
- Register the test in `package.json` `test:unit`.

## Behaviour

### Harvest (`POST …/harvest` `{ source: "wayback" | "gsc" | "all", gscSiteUrl? }`)

- `ensureAsset` on demand (first harvest creates the asset; `candidateId` passed when
  the caller has it), stage → `harvesting` while empty.
- **Wayback**: reuse the CDX machinery in `src/lib/drops/wayback.ts` (matchType=host,
  the process-wide `cdxGate`, `throttled` handling — do NOT re-implement fetching).
  Normalize every candidate URL with `normalizeLegacyUrl(url, host)`; drop nulls;
  cap the stored set at 50 000 URLs per asset (no artificial caps rule applies to
  *display*; this is a sitemap-size guard, name it in the response).
  Write via `addLegacyUrls(userId, assetId, rows, {})`.
- **GSC**: `gscSiteUrl` given or read from the asset (`sc-domain:…` or `https://…/`).
  Pull the property's top pages through the existing GSC query surface (search
  `src/lib` for the live-query helper the `query_gsc_live` MCP tool uses — dimension
  `page`, no row cap below the API's own). Normalize + write with
  `addLegacyUrls(..., { markInGsc: true })` — a URL already stored from Wayback just
  flips `inGsc`.
- Response: `{ added, updated, urlsTotal, bySource: { wayback, gsc } }`.

### Bundle (`GET …/bundle`)

- 404 `asset_not_found` when the asset is missing.
- Builds and returns, as text/plain parts of one JSON (strings, ready to copy):
  `sitemapXml` (from stored legacy URLs via `buildSitemapXml`, newest-first is fine),
  `robotsTxt`, `keyFile` (asset's `indexnowKey`), `nginxSnippet` (constant from
  `activation.ts`), `sitemapUrl`.
- Sets `setSitemapBuilt(userId, assetId, { url, count })`.

### GSC submit (`POST …/gsc-submit` `{ siteUrl, sitemapPath? }`)

- `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}`
  with the user's OAuth token — reuse the same token plumbing the URL-inspection
  route uses (`grep -rn "searchconsole.googleapis.com" src/`).
- Honest errors: site not verified in GSC (403) surfaces verbatim with a hint to add
  the property manually first; success records via `setGscSite`.
- Response: `{ ok: true, siteUrl, sitemapPath }` or `{ error, hint }`.

## Acceptance

- Wayback harvest on a domain with CDX history stores only URLs on that host (test
  with fixture rows: foreign host, fragment-bearing, uppercase host all handled).
- GSC harvest marks existing Wayback rows `inGsc` instead of duplicating
  (`@@unique([assetId, url])` proves it: `updated` increments, `added` does not).
- Bundle output pastes as valid `sitemap.xml` (well-formed XML, urlset namespace) and
  the robots.txt disallows nothing while pointing at the sitemap.
- `gsc-submit` with an unverified site returns the Google error body, not a bare 500.
- `npm run check` + `npm run test:unit` green.
