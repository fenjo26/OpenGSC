import assert from "node:assert/strict";
import test from "node:test";
import { INDEXNOW_BATCH } from "./activation";
import { pushIndexnow, INDEXNOW_ENDPOINT, type IndexnowFetch, type IndexnowRecord } from "./indexnowPush";

// No network and no database: the fetch is a stub returning canned statuses, the store
// call is a recorder. Only the chunking arithmetic and the per-request body are real.

const KEY = "0123456789abcdef0123456789abcdef";
const DOMAIN = "example.gr";
const KEY_LOCATION = `https://${DOMAIN}/${KEY}.txt`;

const makeUrls = (n: number) =>
  Array.from({ length: n }, (_, i) => `https://${DOMAIN}/page-${i}`);

interface Recorded {
  userId: string;
  assetId: string;
  count: number;
  status: string;
}

/** Fetch stub answering with the given statuses in order (last one repeats). */
function stubFetch(statuses: number[]) {
  const calls: { url: string; method?: string; contentType?: string; body?: string }[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      contentType: (init?.headers as Record<string, string> | undefined)?.["Content-Type"],
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    const ok = status === 200 || status === 202;
    return new Response(ok ? "" : "rejected", { status });
  }) as typeof fetch;
  return { calls, fetch: stub };
}

function stubRecord() {
  const rows: Recorded[] = [];
  const record: IndexnowRecord = async (userId, assetId, p) => {
    rows.push({ userId, assetId, count: p.count, status: p.status });
  };
  return { rows, record };
}

// ── chunking + status ──────────────────────────────────────────────────────────

test("two chunks with the second rejected 422: pushed counts only the accepted chunk", async () => {
  const urls = makeUrls(INDEXNOW_BATCH + 347);
  const { calls, fetch } = stubFetch([200, 422]);
  const { rows, record } = stubRecord();

  const res = await pushIndexnow("u1", "a1", { domain: DOMAIN, key: KEY, urls }, { fetch, record });

  assert.equal(res.pushed, INDEXNOW_BATCH);
  assert.equal(res.chunks, 2);
  assert.equal(res.status, "422");
  assert.equal(res.keyLocation, KEY_LOCATION);
  assert.ok(res.hint?.includes(`/${KEY}.txt`), "hint names the key file");
  assert.ok(res.hint?.includes("BEFORE the catch-all 301"), "hint names the nginx ordering");
  assert.equal(calls.length, 2);
  // Recorded exactly once, with what was actually accepted.
  assert.deepEqual(rows, [{ userId: "u1", assetId: "a1", count: INDEXNOW_BATCH, status: "422" }]);
});

test("all chunks accepted (200 and 202 both count): status ok, cumulative count", async () => {
  const urls = makeUrls(INDEXNOW_BATCH * 2 + 5);
  const { fetch } = stubFetch([200, 202, 200]);
  const { rows, record } = stubRecord();

  const res = await pushIndexnow("u1", "a1", { domain: DOMAIN, key: KEY, urls }, { fetch, record });

  assert.equal(res.chunks, 3);
  assert.equal(res.status, "ok");
  assert.equal(res.pushed, urls.length);
  assert.equal(res.hint, undefined);
  assert.deepEqual(rows, [{ userId: "u1", assetId: "a1", count: urls.length, status: "ok" }]);
});

test("422 outranks an earlier plain HTTP failure", async () => {
  const urls = makeUrls(INDEXNOW_BATCH + 1);
  const { fetch } = stubFetch([400, 422]);
  const { rows, record } = stubRecord();

  const res = await pushIndexnow("u1", "a1", { domain: DOMAIN, key: KEY, urls }, { fetch, record });

  assert.equal(res.status, "422");
  assert.equal(res.pushed, 0);
  assert.deepEqual(rows.map(r => r.status), ["422"]);
});

test("a lone HTTP failure surfaces verbatim as the status", async () => {
  const { fetch } = stubFetch([400]);
  const { rows, record } = stubRecord();

  const res = await pushIndexnow("u1", "a1", { domain: DOMAIN, key: KEY, urls: makeUrls(7) }, { fetch, record });

  assert.equal(res.status, "400");
  assert.equal(res.pushed, 0);
  assert.equal(res.chunks, 1);
  assert.ok(res.hint);
  assert.deepEqual(rows, [{ userId: "u1", assetId: "a1", count: 0, status: "400" }]);
});

test("a chunk that never reaches the endpoint surfaces as network_error, not ok", async () => {
  const urls = makeUrls(INDEXNOW_BATCH + 2);
  // First chunk ok, second chunk's transport dies: earlier acceptances still count.
  let call = 0;
  const fetch: IndexnowFetch = async () => {
    if (call++ === 0) return new Response("", { status: 200 });
    throw new Error("ECONNREFUSED");
  };

  const { rows, record } = stubRecord();
  const res = await pushIndexnow("u1", "a1", { domain: DOMAIN, key: KEY, urls }, { fetch, record });

  assert.equal(res.status, "network_error");
  assert.equal(res.pushed, INDEXNOW_BATCH);
  assert.ok(res.hint);
  assert.deepEqual(rows.map(r => r.status), ["network_error"]);
});

// ── request body ───────────────────────────────────────────────────────────────

test("each chunk posts {host,key,keyLocation,urlList} with urlList capped at INDEXNOW_BATCH", async () => {
  const urls = makeUrls(INDEXNOW_BATCH + 3);
  const { calls, fetch } = stubFetch([200, 202]);
  const { record } = stubRecord();

  await pushIndexnow("u1", "a1", { domain: DOMAIN, key: KEY, urls }, { fetch, record });

  assert.equal(calls.length, 2);
  const sent: string[] = [];
  for (const c of calls) {
    assert.equal(c.url, INDEXNOW_ENDPOINT);
    assert.equal(c.method, "POST");
    assert.equal(c.contentType, "application/json; charset=utf-8");
    const body = JSON.parse(c.body ?? "{}") as {
      host: string; key: string; keyLocation: string; urlList: string[];
    };
    assert.equal(body.host, DOMAIN);
    assert.equal(body.key, KEY);
    assert.equal(body.keyLocation, KEY_LOCATION);
    assert.ok(Array.isArray(body.urlList));
    assert.ok(body.urlList.length <= INDEXNOW_BATCH);
    sent.push(...body.urlList);
  }
  assert.equal(JSON.parse(calls[0].body ?? "{}").urlList.length, INDEXNOW_BATCH);
  assert.equal(JSON.parse(calls[1].body ?? "{}").urlList.length, 3);
  // The chunks tile the input exactly — no overlap, nothing dropped.
  assert.equal(new Set(sent).size, urls.length);
  for (const u of urls) assert.ok(sent.includes(u));
});
