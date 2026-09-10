import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROXY_FAIL_LIMIT, PROXY_REST_MS, hasSocks, markProxyResult, newHealth,
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
