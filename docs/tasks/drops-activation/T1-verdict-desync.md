# T1 — Verdict desync (8/19 vs 2/25)

The drops page shows availability numbers that cannot be reconciled: the pass-progress
panel said «8 free of 19 checked» while the table showed 2 available of 25 rows. Verified
causes (2026-09-18):

1. **Real bug — counters count input, not writes.**
   `recordAvailabilityResults` (`src/lib/drops/store.ts:524-592`) increments
   `available++` / `taken++` per *received verdict*, before and regardless of the
   `updateMany` result. A domain not in the catalogue matches nothing, persists nothing,
   and still lands in the panel via `/api/drops/check` and `/api/drops/manual` counters.
2. **By design — scope difference (NOT a bug, do not "fix").** Funnel chips
   (`stageCounts`, `src/lib/drops/store.ts:387-396`) are deliberately unfiltered while
   the table is filtered (comment at `src/app/api/drops/candidates/route.ts:34-36`;
   house rule: a filter must not hide data from the summary). With a filter active,
   panel ≠ table by design.
3. **By design — time difference.** The watch scheduler (`recordWatchResults`,
   `store.ts:1318-1424`) rewrites `stage` after the pass; «this pass» vs «now» can
   legitimately differ. Also panels count all `stage=available` while the table marks
   uncorroborated rows «?» — display distinction, not a count bug.

## The fix (mechanical, small)

In `recordAvailabilityResults`, capture each `updateMany` result and increment from
`result.count` (rows actually written), not from the branch. Signature and return shape
stay identical; the returned numbers change *meaning* to «rows written». Update the
doc comment to say so.

## Files (exclusive ownership)

- `src/lib/drops/store.ts` — `recordAvailabilityResults` only.
- `src/lib/drops/availability.test.ts` — add cases: verdict for a domain absent from
  the catalogue → `{ available: 0, taken: 0 }`; verdict for a present domain → 1;
  deferred path unchanged.

## Acceptance (literal)

- With the watch scheduler idle and NO row filters active: after a check/manual pass,
  the panel numbers (a free + t taken) equal a fresh count of persisted
  `stage IN (available, taken)` rows written by that pass. The 8/19-vs-2/25 class of
  divergence disappears for cause (1).
- Causes (2) and (3) remain and are documented behavior — if a reviewer reports them
  as bugs, point here; do not "fix" the unfiltered funnel (it is the user's own rule).
- `npm run test:unit` green; `npm run check` green.
