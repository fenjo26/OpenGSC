# T5 — UI tab «Активация» in /drops

## Files (exclusive ownership)

- `src/app/drops/page.tsx` — add top-level tabs, mount the panel.
- `src/components/drops/ActivationPanel.tsx` — NEW (all real logic lives here).
- `src/lib/i18n/**` — locale files (ALL of them; keys prefixed `drops_activation_`).

## Behaviour

- Top-level tabs on `/drops`: «Каталог» (everything that exists today) and «Активация».
  Tab state persisted via `usePersistedState` + `urlParam` (`?tab=activation` is a
  share link — same pattern as the site pages). Default tab: Каталог.
- `ActivationPanel` (client component, fetches its own routes):
  - Asset list from a `GET /api/drops/activation` route you ADD inside this task's
    page.tsx ownership? — NO: fetch via `listAssets` through a thin
    `GET /api/drops/activation/route.ts` you create here (this is the one route file
    T5 owns; the `[domain]/*` routes belong to T2/T3/T4/T6).
  - Per asset: stage chip, `urlsTotal` split by source, `sitemapBuiltAt` as
    «N дней назад» via `utcMidnightDaysBetween` (**UTC midnight — the local-calendar
    version in `wayback.ts:36-39` already drifted a day; do not re-derive**),
    indexnow count + status (copy must name Bing/Yandex, never Google), GSC submitted
    at, donors / active placements, `googleHits7d` + `lastGoogleHitAt` when present.
  - Actions wired to the tail routes: Harvest (wayback|gsc|all), Copy bundle
    (opens a section with sitemap.xml / robots.txt / key file / nginx snippet +
    copy buttons), Submit to GSC, Push IndexNow, Donors (textarea, PUT, then Run).
  - Empty state explains the pipeline in one line + names the nginx-before-301 rule
    (it is the most likely "everything looks done but nothing works" cause).
- i18n: every string through `useLanguage()`'s `t()`; `{host}`-style placeholders
  substituted manually (no interpolation in this codebase). Missing keys fail `tsc`
  — that is the gate.

## Acceptance

- `?tab=activation` deep link opens the tab; switching back and forth keeps filters
  of the catalogue intact (they live in persisted state already).
- All actions show honest inline errors from the route responses (422 quota, GSC 403
  hint, `donor_not_allowed` with the rejected URL list).
- `npm run check` green (tsc catches missing i18n keys); all locale files carry every
  new key.
- No changes to the catalogue's table/panels beyond mounting them inside the tab.
