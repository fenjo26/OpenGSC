# T3 — IndexNow push per asset

Priority 2 of the wave. **Honest scope: IndexNow serves Bing/Yandex (and minor
engines). Google does not read it.** Every user-visible string says so (T5 carries the
UI copy; this task's API responses must not overpromise either).

## Files (exclusive ownership)

- `src/lib/drops/indexnowPush.ts` (+ `indexnowPush.test.ts`) — NEW.
- `src/app/api/drops/activation/[domain]/indexnow/route.ts` — NEW.
- Register the test in `package.json` `test:unit`.

## Behaviour

`POST …/indexnow` `{ limit?: number }`:

- 404 when the asset is missing; 400 `no_urls` when it has zero legacy URLs.
- Reads stored legacy URLs (`getAsset`), slices to `limit` (default: all).
- Chunks by `INDEXNOW_BATCH` (10 000) and POSTs each chunk to
  `https://api.indexnow.org/indexnow` with body `{ host, key, keyLocation, urlList }`
  — host = asset domain, key = asset `indexnowKey`,
  `keyLocation = https://{domain}/{key}.txt`. Mirror the request/response handling of
  the existing generic route `src/app/api/indexing/indexnow/route.ts` (200/202 = ok),
  but do it server-side in the lib; the lib must be unit-testable with an injected
  `fetch` (default global).
- Per-chunk status recorded as the worst outcome: all ok → `"ok"`; any 422 → `"422"`
  (quota — IndexNow's answer to key/location problems, surface it verbatim);
  otherwise the HTTP code. `recordIndexnowPush(userId, assetId, { count, status })`
  once per run, `count` = URLs actually accepted.
- The deployed key file must match: the response includes `keyLocation` and the bundle
  (T2) already carries the file — mention in response `hint` when status ≠ ok:
  «nginx rules must serve /{key}.txt BEFORE the catch-all 301».

Response: `{ pushed, chunks, status, keyLocation }`.

## Acceptance

- Unit tests with a stubbed fetch: two chunks (10 000 + rest), second returns 422 →
  `{ pushed: <first-chunk-size>, status: "422" }`; all-ok run records `"ok"`.
- No network call in tests; `recordIndexnowPush` asserted via a store stub or by
  calling with a fake `db` seam (follow the seams used by `drops/*.test.ts`).
- Re-running the route is idempotent from the network's perspective (same URLs, same
  key — IndexNow dedupes; our side just re-records).
- `npm run check` + `npm run test:unit` green.
