import assert from "node:assert/strict";
import test from "node:test";
import { hostMatches, hostOfUrl, ignorePredicate, parseHostList } from "./hosts";
import { DEFAULT_PLATFORM_HOSTS } from "./types";

test("hostOfUrl lower-cases, strips one leading www. and the trailing dot", () => {
  assert.equal(hostOfUrl("https://www.site.com/x"), "site.com");
  assert.equal(hostOfUrl("http://WWW.Site.COM./a?b=1"), "site.com");
  assert.equal(hostOfUrl("https://Example.COM/Path"), "example.com");
  assert.equal(hostOfUrl("https://www.www.site.com/"), "www.site.com"); // only ONE leading www. goes
  assert.equal(hostOfUrl("https://www.co.uk/"), "co.uk");
  assert.equal(hostOfUrl("https://site.com:8443/x"), "site.com"); // port is not part of the host
});

test("hostOfUrl keeps punycode and IP hosts as URL reports them", () => {
  assert.equal(hostOfUrl("https://москва.рф/"), "xn--80adxhks.xn--p1ai");
  assert.equal(hostOfUrl("http://192.168.0.1/x"), "192.168.0.1");
  assert.equal(hostOfUrl("http://192.168.0.1:9000/"), "192.168.0.1");
});

test("hostOfUrl rejects non-http(s) schemes and garbage", () => {
  assert.equal(hostOfUrl("ftp://ftp.example.com/pub"), null);
  assert.equal(hostOfUrl("javascript:void(0)"), null);
  assert.equal(hostOfUrl("mailto:someone@example.com"), null);
  assert.equal(hostOfUrl("file:///etc/passwd"), null);
  assert.equal(hostOfUrl("not a url"), null);
  assert.equal(hostOfUrl("site.com"), null); // a bare host is not a URL
  assert.equal(hostOfUrl(""), null);
});

test("hostOfUrl caps the host at 191 characters", () => {
  const ok = `${"a".repeat(187)}.com`; // 191
  assert.equal(hostOfUrl(`https://${ok}/`), ok);
  const long = `${"a".repeat(188)}.com`; // 192
  assert.equal(hostOfUrl(`https://${long}/`), null);
});

test("hostMatches is dot-bounded, never substring", () => {
  assert.ok(hostMatches("m.facebook.com", ["facebook.com"]));
  assert.ok(hostMatches("facebook.com", ["facebook.com"]));
  assert.ok(hostMatches("www.facebook.com", ["facebook.com"]));
  assert.ok(hostMatches("sub.m.facebook.com", ["facebook.com"]));
  assert.ok(hostMatches("es.wikipedia.org", ["wikipedia.org"]));
  assert.ok(hostMatches("apps.apple.com", ["apps.apple.com"]));
  assert.ok(!hostMatches("apple.com", ["apps.apple.com"])); // apple.com is not the App Store
  assert.ok(!hostMatches("notfacebook.com", ["facebook.com"]));
  assert.ok(!hostMatches("netflix.com", ["x.com"]));
  assert.ok(!hostMatches("vox.com", ["x.com"]));
  assert.ok(!hostMatches("1xbet.com", ["x.com"]));
  assert.ok(!hostMatches("x.com.evil.test", ["x.com"]));
  assert.ok(!hostMatches("facebook.com", []));
});

test("ignorePredicate unions platform defaults with the project list", () => {
  const isIgnored = ignorePredicate(["myspam.example"]);
  for (const platform of DEFAULT_PLATFORM_HOSTS) {
    assert.ok(isIgnored(`www.${platform}`), `www.${platform} is a platform subdomain`);
  }
  assert.ok(isIgnored("m.facebook.com"));
  assert.ok(isIgnored("es.wikipedia.org"));
  assert.ok(isIgnored("apps.apple.com"));
  assert.ok(isIgnored("play.google.com"));
  assert.ok(isIgnored("www.myspam.example"));
  assert.ok(!isIgnored("apple.com"));
  assert.ok(!isIgnored("notfacebook.com"));
  assert.ok(!isIgnored("myspam.example.test"));
  assert.ok(!isIgnored("regular-site.test"));
});

test("parseHostList splits on newlines and commas, trims, lower-cases, strips www, dedupes", () => {
  assert.deepEqual(
    parseHostList("https://www.site.com/x\nFOO.COM, www.bar.com\n\nsite.com\n https://Other.Org/path "),
    ["site.com", "foo.com", "bar.com", "other.org"],
  );
  assert.deepEqual(parseHostList("WWW.Site.COM."), ["site.com"]);
  assert.deepEqual(parseHostList(""), []);
  assert.deepEqual(parseHostList("   \n  ,  "), []);
  assert.deepEqual(parseHostList("ftp://x.test, https://y.test"), ["y.test"]);
  assert.deepEqual(parseHostList("not a host"), []);
  assert.deepEqual(parseHostList("site.test/path"), []); // garbage with a path is dropped, not stored
});
