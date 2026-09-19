import test from "node:test";
import assert from "node:assert/strict";

import type { SafeFetchOptions, SafeFetchResponse } from "@/lib/security/safeFetch";
import { collectEvidence, ToxThrottledError } from "./collect";

function res(status: number, body?: string): SafeFetchResponse {
  return {
    status,
    statusText: "",
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    url: "",
    redirected: false,
    byteLength: body?.length ?? 0,
    async text() { return body ?? ""; },
    async json() { return JSON.parse(body ?? "null"); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

const CDX_BODY = JSON.stringify([
  ["timestamp", "original", "statuscode", "mimetype", "digest", "length"],
  ["20240115000000", "example.com/", "200", "text/html", "abc", 100],
  ["20250324000000", "example.com/", "200", "text/html", "def", 100],
  ["20260201000000", "example.com/", "404", "text/html", "ghi", 10],
]);

const SNAP_HTML = "<html lang=\"de\"><head><title>Klempner Berlin</title></head><body>Notdienst 24h</body></html>";

function mockFetch(log?: { url: string; headers: Record<string, string> }[]) {
  return async (url: string, options: SafeFetchOptions): Promise<SafeFetchResponse> => {
    const headers = (options.headers ?? {}) as Record<string, string>;
    log?.push({ url, headers });
    if (url.startsWith("https://web.archive.org/cdx/")) return res(200, CDX_BODY);
    if (url.includes("/20240115")) return res(200, SNAP_HTML);
    if (url.includes("/20250324")) return res(200, "<html><head><title>米乐m6官网</title></head></html>");
    return res(200, "");
  };
}

test("собирает снимки: 404-й ряд отфильтрован, титулы и lang прочитаны, порядок старый→новый", async () => {
  const evidence = await collectEvidence("example.com", { fetch: mockFetch() });
  assert.equal(evidence.snapshots.length, 2);
  assert.equal(evidence.snapshots[0]?.timestamp, "20240115000000");
  assert.equal(evidence.snapshots[0]?.title, "Klempner Berlin");
  assert.equal(evidence.snapshots[0]?.htmlLang, "de");
  assert.equal(evidence.snapshots[1]?.title, "米乐m6官网");
  assert.equal(evidence.domain, "example.com");
});

test("снимки тянутся с суффиксом id_ и заголовком Range", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  await collectEvidence("example.com", { fetch: mockFetch(log) });
  const snap = log.filter(l => !l.url.includes("/cdx/"));
  assert.ok(snap.length >= 1);
  for (const s of snap) {
    assert.match(s.url, /\/web\/\d{14}id_\//);
    assert.equal(s.headers.range, "bytes=0-16383");
  }
});

test("анкоры прокидываются без единого запроса, если snapshots: 0 невозможно — а при пустом CDX сеть не тратится на тела", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const empty = async (url: string): Promise<SafeFetchResponse> => {
    log.push({ url, headers: {} });
    return url.includes("/cdx/") ? res(200, "[]") : res(200, "");
  };
  const evidence = await collectEvidence("example.com", {
    anchors: ["situs togel online"],
    fetch: (u, o) => empty(u),
  });
  assert.deepEqual(evidence.snapshots, []);
  assert.deepEqual(evidence.anchors, ["situs togel online"]);
  assert.equal(log.length, 1); // только CDX, ни одного запроса тела
});

test("429 от CDX — ToxThrottledError, а не пустой вердикт", async () => {
  await assert.rejects(
    collectEvidence("example.com", {
      fetch: async url => (url.includes("/cdx/") ? res(429) : res(200, "")),
    }),
    ToxThrottledError,
  );
});

test("упавший один снимок не топит домен: остаётся записью без контента", async () => {
  const evidence = await collectEvidence("example.com", {
    fetch: async (url, options) => {
      if (url.includes("/cdx/")) return res(200, CDX_BODY);
      // первый снимок падает сетевой ошибкой, второй отвечает
      if (url.includes("/20240115")) {
        void options;
        throw new Error("boom");
      }
      return res(200, SNAP_HTML);
    },
  });
  assert.equal(evidence.snapshots.length, 2);
  assert.equal(evidence.snapshots[0]?.title, undefined);
  assert.equal(evidence.snapshots[1]?.title, "Klempner Berlin");
});
