import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROXY_FAIL_LIMIT, PROXY_REST_MS, createProxyPool, hasSocks, markProxyResult, newHealth,
  parseProxyList, parseProxyLine, pickProxy, proxyKey, redactProxy,
} from "./proxies";

const ok = (line: string) => {
  const r = parseProxyLine(line);
  assert.ok("proxy" in r, `${line} was rejected: ${JSON.stringify(r)}`);
  return r.proxy;
};

test("the formats proxy panels actually hand out all parse", () => {
  assert.deepEqual(ok("user:pass@1.2.3.4:8080"),
    { kind: "http", host: "1.2.3.4", port: 8080, username: "user", password: "pass" });
  assert.deepEqual(ok("socks5://user:pass@1.2.3.4:1080"),
    { kind: "socks5", host: "1.2.3.4", port: 1080, username: "user", password: "pass" });
  assert.deepEqual(ok("http://1.2.3.4:80"), { kind: "http", host: "1.2.3.4", port: 80 });
  assert.deepEqual(ok("1.2.3.4:3128"), { kind: "http", host: "1.2.3.4", port: 3128 });
  // The panel format with no @ at all.
  assert.deepEqual(ok("1.2.3.4:8000:user:pass"),
    { kind: "http", host: "1.2.3.4", port: 8000, username: "user", password: "pass" });
  assert.equal(ok("proxy.example.com:8080").host, "proxy.example.com");
});

test("host:port@user:pass — the mirrored spelling some panels hand out", () => {
  // Proxy5 delivers exactly this. Assuming the classic ordering rejected every line with "not a
  // proxy", which reads as "these proxies are broken" rather than "this field wants them the
  // other way round".
  assert.deepEqual(ok("157.22.126.95:1080@mix379E4SOP99:gy5i2iKS"),
    { kind: "http", host: "157.22.126.95", port: 1080, username: "mix379E4SOP99", password: "gy5i2iKS" });
  assert.deepEqual(ok("socks5://45.80.104.72:1080@user:pw"),
    { kind: "socks5", host: "45.80.104.72", port: 1080, username: "user", password: "pw" });
  // And the classic ordering still wins when it is the one that looks like an address.
  assert.equal(ok("mix379E4SOP99:gy5i2iKS@157.22.126.95:1080").host, "157.22.126.95");
});

test("when both sides could be an address, the IP literal decides", () => {
  // A username with a dot and a numeric password make the left side look like a host:port too.
  const p = ok("1.2.3.4:1080@my.user:12345");
  assert.equal(p.host, "1.2.3.4");
  assert.equal(p.username, "my.user");
  assert.equal(p.password, "12345");
  // Neither side an IP → the classic ordering is the tie-break.
  assert.equal(ok("my.user:12345@proxy.example.com:8080").host, "proxy.example.com");
});

test("a password with a colon in it survives — only the first colon splits", () => {
  const p = ok("user:pa:ss@1.2.3.4:8080");
  assert.equal(p.username, "user");
  assert.equal(p.password, "pa:ss");
});

test("no scheme means http, never a silent socks5", () => {
  // Claiming socks5 for an HTTP proxy would promise WHOIS support that does not exist.
  assert.equal(ok("user:pass@1.2.3.4:8080").kind, "http");
  assert.equal(ok("socks://1.2.3.4:1080").kind, "socks5");
  assert.equal(ok("socks5h://1.2.3.4:1080").kind, "socks5");
});

test("junk is rejected with a reason rather than half-parsed", () => {
  for (const [line, reason] of [
    ["", "empty"],
    ["1.2.3.4", "no_port"],
    ["1.2.3.4:notaport", "bad_port"],
    ["1.2.3.4:70000", "bad_port"],
    ["ftp://1.2.3.4:21", "bad_scheme"],
    ["localhost:8080", "bad_host"],
  ] as const) {
    const r = parseProxyLine(line);
    assert.ok("reason" in r && r.reason === reason, `${line} → ${JSON.stringify(r)}`);
  }
});

test("the password never appears in anything printable", () => {
  const p = ok("bob:hunter2@1.2.3.4:8080");
  assert.equal(redactProxy(p), "http://bob:***@1.2.3.4:8080");
  assert.ok(!redactProxy(p).includes("hunter2"));
  assert.ok(!proxyKey(p).includes("hunter2"));
  const { skipped } = parseProxyList("bob:hunter2@1.2.3.4:notaport\n");
  assert.equal(skipped.length, 1);
  assert.ok(!skipped[0].value.includes("hunter2"), skipped[0].value);
});

test("a list dedupes by endpoint and reports what it dropped", () => {
  const { proxies, skipped } = parseProxyList(
    "user:pass@1.2.3.4:8080\nuser:pass@1.2.3.4:8080\n5.6.7.8:1080\nrubbish\n",
  );
  assert.equal(proxies.length, 2);
  assert.equal(skipped.length, 1);
});

test("rotation is least-recently-used, and a resting proxy is skipped", () => {
  const a = newHealth("a"), b = newHealth("b");
  const first = pickProxy([a, b], 1000);
  assert.equal(first?.key, "a");
  markProxyResult(a, true, 1000);
  assert.equal(pickProxy([a, b], 1001)?.key, "b");

  b.restingUntil = 9999;
  assert.equal(pickProxy([a, b], 1002)?.key, "a");
  b.restingUntil = 0;
});

test("failures rest a proxy, a success clears the count, and the rest expires", () => {
  const h = newHealth("a");
  for (let i = 0; i < PROXY_FAIL_LIMIT - 1; i++) markProxyResult(h, false, 100);
  assert.equal(h.restingUntil, 0, "not rested before the limit");
  markProxyResult(h, false, 100);
  assert.equal(h.restingUntil, 100 + PROXY_REST_MS);
  assert.equal(h.failures, 0, "the counter restarts with the rest");
  // Resting is temporary on purpose: a paid proxy blips far more often than it dies.
  assert.equal(pickProxy([h], 100 + PROXY_REST_MS + 1)?.key, "a");

  const g = newHealth("b");
  markProxyResult(g, false, 1);
  markProxyResult(g, true, 2);
  assert.equal(g.failures, 0);
});

test("hasSocks answers the question the WHOIS path depends on", () => {
  assert.equal(hasSocks(parseProxyList("1.2.3.4:8080").proxies), false);
  assert.equal(hasSocks(parseProxyList("1.2.3.4:8080\nsocks5://5.6.7.8:1080").proxies), true);
});

// The pool's whole job is politeness accounting: the registry counts requests per ADDRESS, so
// two proxies may hit one zone at once and one proxy may not.

test("an empty pool leases a direct connection instead of blocking", async () => {
  const pool = createProxyPool([]);
  assert.equal(pool.size, 0);
  const lease = await pool.lease("com", 1000);
  assert.equal(lease.endpoint, null);
});

test("two proxies serve one zone concurrently — that is the entire speedup", async () => {
  const pool = createProxyPool(parseProxyList("1.1.1.1:8080\n2.2.2.2:8080").proxies);
  const started = Date.now();
  const a = await pool.lease("com", 10_000);
  const b = await pool.lease("com", 10_000);
  assert.notEqual(a.endpoint!.host, b.endpoint!.host);
  assert.ok(Date.now() - started < 500, "neither lease waited for the other");
  a.release(true); b.release(true);
});

test("the same proxy waits out the zone interval before asking again", async () => {
  const pool = createProxyPool(parseProxyList("1.1.1.1:8080").proxies);
  const first = await pool.lease("com", 300);
  first.release(true);
  const started = Date.now();
  const second = await pool.lease("com", 300);
  assert.ok(Date.now() - started >= 250, `waited ${Date.now() - started}ms`);
  second.release(true);
});

test("a different zone does not inherit another zone's wait", async () => {
  const pool = createProxyPool(parseProxyList("1.1.1.1:8080").proxies);
  (await pool.lease("com", 10_000)).release(true);
  const started = Date.now();
  const other = await pool.lease("de", 10_000);
  assert.ok(Date.now() - started < 500, "the .de queue is not behind the .com one");
  other.release(true);
});

test("a proxy in use is not handed out twice", async () => {
  const pool = createProxyPool(parseProxyList("1.1.1.1:8080").proxies);
  const held = await pool.lease("com", 0);
  let secondDone = false;
  const second = pool.lease("com", 0).then(l => { secondDone = true; return l; });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(secondDone, false, "the second lease waited for the first to be released");
  held.release(true);
  (await second).release(true);
});

test("when every proxy is resting the check goes direct rather than stopping", async () => {
  const pool = createProxyPool(parseProxyList("1.1.1.1:8080").proxies);
  for (let i = 0; i < PROXY_FAIL_LIMIT; i++) {
    const l = await pool.lease("com", 0);
    l.release(false);
  }
  assert.equal(pool.snapshot()[0].resting, true);
  const lease = await pool.lease("com", 0);
  assert.equal(lease.endpoint, null, "a dead pool must not stall the whole run");
});

test("release is idempotent — a double release cannot free someone else's turn", async () => {
  const pool = createProxyPool(parseProxyList("1.1.1.1:8080").proxies);
  const l = await pool.lease("com", 0);
  l.release(true);
  l.release(false);
  assert.equal(pool.snapshot()[0].resting, false);
});

test("one machine added as both http and socks5 is still ONE address to a registry", () => {
  // The natural setup for a proxy that speaks both: HTTP entries carry RDAP, SOCKS5 entries
  // carry WHOIS. They are two pool entries — but one machine, one IP, and the registry counts
  // requests per address. Letting them run as two independent lanes would double the rate the
  // zone interval exists to hold.
  const pool = createProxyPool(parseProxyList("1.1.1.1:1080\nsocks5://1.1.1.1:1080").proxies);
  assert.equal(pool.size, 2, "both entries are in the pool");
  return (async () => {
    const held = await pool.lease("com", 0);
    let secondDone = false;
    const second = pool.lease("com", 0).then(l => { secondDone = true; return l; });
    await new Promise(r => setTimeout(r, 120));
    assert.equal(secondDone, false, "the second entry waited: same address, one turn at a time");
    held.release(true);
    (await second).release(true);
  })();
});

test("the same address waits out the zone interval across protocols too", async () => {
  const pool = createProxyPool(parseProxyList("2.2.2.2:1080\nsocks5://2.2.2.2:1080").proxies);
  (await pool.lease("com", 300)).release(true);
  const started = Date.now();
  const next = await pool.lease("com", 300);
  assert.ok(Date.now() - started >= 250, `the second protocol waited ${Date.now() - started}ms`);
  next.release(true);
});
