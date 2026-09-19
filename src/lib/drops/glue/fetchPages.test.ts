import test from "node:test";
import assert from "node:assert/strict";

import { SafeFetchError, type SafeFetchOptions, type SafeFetchResponse } from "@/lib/security/safeFetch";
import { detectCloaking, fetchClusterPages, MAX_URLS, withFindings } from "./fetchPages";
import type { GlueReport, PageFacts } from "./types";

/* Мок вместо safeFetch: проверяется поведение фетчера, а не сети. `seen` копит
   (url, headers) каждого вызова — ассерты читают их постфактум. */
type Handler = (url: string, headers: Record<string, string>) => SafeFetchResponse | Promise<SafeFetchResponse>;

function mock(
  handler: Handler,
  calls?: { url: string; headers: Record<string, string> }[],
) {
  return async (input: string | URL, options: SafeFetchOptions): Promise<SafeFetchResponse> => {
    const headers = (options.headers ?? {}) as Record<string, string>;
    calls?.push({ url: String(input), headers });
    return handler(String(input), headers);
  };
}

function res(status: number, init: { location?: string; html?: string; headers?: Record<string, string> } = {}): SafeFetchResponse {
  const h = new Map<string, string>(Object.entries(init.headers ?? {}));
  if (init.location) h.set("location", init.location);
  return {
    status,
    statusText: "",
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => h.get(k.toLowerCase()) ?? null,
      forEach: (fn: (v: string, k: string) => void) => {
        for (const [k, v] of h) fn(v, k);
      },
    } as unknown as Headers,
    url: "",
    redirected: false,
    byteLength: (init.html ?? "").length,
    async text() {
      return init.html ?? "";
    },
    async json() {
      return JSON.parse(init.html ?? "null");
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

function facts(url: string, over: Partial<PageFacts> = {}): PageFacts {
  return {
    requestedUrl: url, finalUrl: url, status: 200, redirectChain: [],
    htmlLang: null, canonical: null, canonicalRaw: null, alternates: [], alternatesRaw: [],
    robots: [], ...over,
  };
}

/* ------------------------------------------------------------------ */
/* один URL: редиректы и ошибки                                        */
/* ------------------------------------------------------------------ */

test("редиректы ведутся вручную: цепочка записана, аннотации читаются с финала", async () => {
  const pages = await fetchClusterPages(["https://drop.com/"], { ua: "browser" }, {
    fetch: mock((url) => {
      if (url === "https://drop.com/") return res(301, { location: "https://www.drop.com/" });
      return res(200, { html: '<html lang="en"><head><link rel="canonical" href="https://www.drop.com/"></head></html>' });
    }),
  });
  const [page] = pages;
  assert.equal(page.redirectChain?.length, 1);
  assert.equal(page.redirectChain[0]?.status, 301);
  assert.equal(page.finalUrl, "https://www.drop.com/");
  assert.match(page.html ?? "", /rel="canonical"/);
});

test("после 5 прыжков — too_many_redirects, цепочка из пяти звеньев", async () => {
  const pages = await fetchClusterPages(["https://loop.com/"], { ua: "browser" }, {
    fetch: mock(url => res(302, { location: `${url}next` })),
  });
  const [page] = pages;
  assert.equal(page.error, "too_many_redirects");
  assert.equal(page.redirectChain?.length, 5);
});

test("3xx без Location — финальный ответ, не ошибка", async () => {
  const pages = await fetchClusterPages(["https://a.com/"], { ua: "browser" }, {
    fetch: mock(() => res(301, { html: "<html></html>" })),
  });
  const [page] = pages;
  assert.equal(page.error, undefined);
  assert.equal(page.status, 301);
  assert.equal(page.redirectChain?.length, 0);
});

test("response_too_large ретраится с Range и приносит голову страницы", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let thrown = false;
  const pages = await fetchClusterPages(["https://big.com/"], { ua: "browser" }, {
    fetch: mock((_url, headers) => {
      if (!thrown) {
        thrown = true;
        throw new SafeFetchError("response_too_large", "too large");
      }
      assert.equal(headers.range, "bytes=0-999999");
      return res(206, { html: "<html><head><title>ok</title></head></html>" });
    }, calls),
  });
  assert.equal(pages[0].status, 206);
  assert.equal(pages[0].error, undefined);
  assert.match(pages[0].html ?? "", /<title>/);
  assert.equal(calls[0].headers.range, undefined);
  assert.equal(calls.length, 2);
});

test("сетевая ошибка записывается в страницу, а не роняет вызов", async () => {
  const pages = await fetchClusterPages(["https://x.com/", "https://y.com/"], { ua: "browser" }, {
    fetch: mock(url => {
      if (url === "https://x.com/") throw new SafeFetchError("dns_failed", "no dns");
      return res(200, { html: "<html></html>" });
    }),
  });
  assert.equal(pages[0].status, 0);
  assert.equal(pages[0].error, "dns_failed");
  assert.equal(pages[1].status, 200);
});

/* ------------------------------------------------------------------ */
/* батч: границы и параллельность                                      */
/* ------------------------------------------------------------------ */

test("не больше 10 URL за вызов", async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://h${i}.com/`);
  const pages = await fetchClusterPages(urls, { ua: "browser" }, {
    fetch: mock(() => res(200, { html: "" })),
  });
  assert.equal(pages.length, MAX_URLS);
});

test("один хост обходится последовательно", async () => {
  let active = 0;
  let maxActive = 0;
  const urls = ["https://one.com/a", "https://one.com/b", "https://one.com/c"];
  await fetchClusterPages(urls, { ua: "browser" }, {
    fetch: mock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setImmediate(r));
      active--;
      return res(200, { html: "" });
    }),
  });
  assert.equal(maxActive, 1);
});

test("разные хосты идут параллельно, но не шире четырёх", async () => {
  let active = 0;
  let maxActive = 0;
  const urls = ["https://a.com/", "https://b.com/", "https://c.com/", "https://d.com/", "https://e.com/"];
  await fetchClusterPages(urls, { ua: "browser" }, {
    fetch: mock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setImmediate(r));
      active--;
      return res(200, { html: "" });
    }),
  });
  assert.equal(maxActive, 4);
});

test("UA гуглбота подставляется по переключателю", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  await fetchClusterPages(["https://a.com/"], { ua: "googlebot" }, {
    fetch: mock(() => res(200, { html: "" }), calls),
  });
  assert.match(calls[0].headers["user-agent"], /Googlebot\/2\.1/);
});

/* ------------------------------------------------------------------ */
/* диф двух UA                                                         */
/* ------------------------------------------------------------------ */

test("разный canonical для браузера и бота — cloaked_annotations", () => {
  const browser = [facts("https://a.com/", { canonical: "https://a.com/" })];
  const bot = [facts("https://a.com/", { canonical: "https://b.com/" })];
  const [f] = detectCloaking(browser, bot);
  assert.equal(f.code, "cloaked_annotations");
  assert.equal(f.severity, "warn");
  assert.equal(f.page, "https://a.com/");
});

test("одинаковые аннотации и упавшие страницы — находок нет", () => {
  const page = facts("https://a.com/", {
    canonical: "https://a.com/",
    alternates: [{ hreflang: "en-GB", url: "https://a.com/" }],
  });
  assert.deepEqual(detectCloaking([page], [page]), []);
  const dead = facts("https://a.com/", { error: "dns_failed" });
  assert.deepEqual(detectCloaking([dead], [facts("https://a.com/", { canonical: "https://b.com/" })]), []);
});

test("withFindings пересобирает счётчики и ok", () => {
  const report: GlueReport = {
    mode: "cluster", ok: true, findings: [],
    counts: { blocker: 0, warn: 0, info: 1 },
  };
  const merged = withFindings(report, [
    { code: "cloaked_annotations", severity: "warn", page: "https://a.com/" },
    { code: "page_dead", severity: "blocker", page: "https://b.com/" },
  ]);
  assert.equal(merged.ok, false);
  assert.equal(merged.counts.warn, 1);
  assert.equal(merged.counts.blocker, 1);
  // Пустая добавка возвращает отчёт как есть.
  assert.equal(withFindings(report, []), report);
});
