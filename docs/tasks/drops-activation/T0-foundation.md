# T0 — Foundation

Implements `CONTRACT.md` verbatim. Nothing else in the wave compiles until this merges.

## Files (exclusive ownership)

- `prisma/schema.prisma` — append the activation block after `DropEvent` (models
  `DropAsset`, `DropLegacyUrl`, `DropDonor`, `DropDonorPlacement` — literal from CONTRACT).
- `src/lib/drops/activation.ts` — NEW. Pure helpers + constants from CONTRACT.
- `src/lib/drops/activationStore.ts` — NEW. Prisma store, signatures from CONTRACT.
- `src/lib/drops/activation.test.ts` — NEW. Pure-helper tests (no DB).
- `package.json` — register the test file in `test:unit`.
- Hook: where a `DropCandidate` transitions to `stage: "acquired"`, call
  `ensureAsset(userId, domain, { candidateId })`. Find the transition site(s) with
  `grep -rn "acquired" src/` — if the only writers are check/manual flows that never
  set it, hook the generic stage-write route instead and leave a comment.

## Notes

- `candidateId` is a plain column, NOT a relation — `DropCandidate` stays untouched.
- `ensureAsset` generates `indexnowKey` (32 hex, `crypto.randomUUID().replace(/-/g, "")`)
  once; re-ensuring never regenerates it (the file on the host would go stale).
- `eligibleDoorways`: `groupBy IndexerDailyStat` where `botType = "google"` and
  `date >= (today - days)` as YYYY-MM-DD strings, joined against `IndexerDomain`
  `status = "active"`; return hits per domain, order desc. No caching — the list must
  not rot (see README hard rules).
- `addPlacements` enqueues into `IndexerQueue` (`upsert` on `@@unique([domainId, url])`)
  in the same function that writes the placement row — callers cannot forget half of it.
- Models must stay MySQL-portable: String/Int/Boolean/DateTime only, no `Json` columns.

## Acceptance

- `npx prisma db push` clean + `npx prisma generate` run afterwards (Prisma 7: push
  does NOT regenerate the client — known trap).
- `npm run test:unit` green including the new file; file registered in `package.json`.
- `npm run check` green.
- A manual `ensureAsset` twice in a row returns the SAME `indexnowKey` and does not
  duplicate the row (`@@unique([userId, domain])`).
- `utcMidnightDaysBetween` has tests at the Athens-vs-UTC boundary (23:00 UTC vs 01:00
  next day local) — the exact case `wayback.ts:36-39` got wrong.
