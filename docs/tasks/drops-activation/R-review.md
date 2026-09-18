# R — Review pass

Run after T0+T1 merge and again after the tail lands. Reads everything, edits only
what findings name.

## Predictable errors while T0 is unmerged (not real breakage)

- `TS2339: Property 'dropAsset' | 'dropLegacyUrl' | 'dropDonor' | 'dropDonorPlacement'
  does not exist on type PrismaClient` — schema not pushed/generated yet.
- `Cannot find module './activation' | './activationStore'` in tail task files.
- Missing `drops_activation_*` i18n keys fail `tsc` only when T5's locale edits land.

Anything else red is real.

## Checklist

1. **Footprint rule** — grep the merged diff for any path where an asset's own URL can
   reach `IndexerQueue` or a placement. `isDonorAllowed` must gate the UI route, the
   runner, AND `addPlacements` (defense in depth, CONTRACT pins all three).
2. **Counter honesty (T1)** — panel numbers after a pass equal persisted counts; the
   unfiltered funnel chips are still unfiltered (a "fix" there is a regression of the
   user's own filter-must-not-hide-data rule).
3. **No hardcoded doorway list** anywhere; threshold comes from `activation.ts`.
4. **UTC midnight** everywhere day math appears; `wayback.ts`'s local-calendar
   `daysBetween` untouched but not copied either.
5. **i18n completeness** — every `drops_activation_` key in every locale file.
6. **Idempotency** — harvest twice, run-donors twice, indexnow twice: no duplicate
   rows (`@@unique` constraints prove it), no reset progress fields.
7. **Gates** — `npm run check`, `npm run test:unit` (files registered in
   `package.json`), `npx prisma db push` + `npx prisma generate` ran (deploy note in
   CHANGELOG).
8. **README pair** edited together; CHANGELOG under `[Unreleased]`; no version bump.
