import { test } from "node:test";
import assert from "node:assert/strict";
import { rankErrorKey } from "./rankError";

test("rank error tooltips use safe localized message keys", () => {
  assert.equal(rankErrorKey('serper: {"message":"Not enough credits"}'), "rankErrQuota");
  assert.equal(rankErrorKey("serper: empty_serp"), "rankErrEmpty");
  assert.equal(rankErrorKey("untrusted_not_found"), "rankErrUntrusted");
  assert.equal(rankErrorKey("location_unsupported"), "lrErr_location_unsupported");
  assert.equal(rankErrorKey("no_serp_key (serper)"), "rankErrCredentials");
  assert.equal(rankErrorKey("сеть Serper: fetch failed"), "rankErrNetwork");
  assert.equal(rankErrorKey("serper: an unfamiliar provider payload"), "rankErrGeneric");
});
