#!/usr/bin/env node
// ccrank server — answers "where does this domain stand in Common Crawl's web graph".
//
//   CCRANK_DATA=./data CCRANK_PORT=8787 node server.mjs
//
//   GET /v1/rank?d=example.com,blog.example.co.uk   (≤ 50 domains)
//   GET /v1/health
//
// Read-only, stateless, no keys, no user data. Listens on 127.0.0.1 by default — put nginx (or
// any TLS proxy) in front and set CCRANK_TRUST_PROXY=1 so the rate limit counts the visitor's
// address from X-Forwarded-For instead of the proxy's.

import http from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup, makeLimiter, parseIndex, MAX_QUERY_DOMAINS } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.CCRANK_DATA ?? path.join(here, "data"));
const port = Number(process.env.CCRANK_PORT ?? 8787);
const host = process.env.CCRANK_HOST ?? "127.0.0.1";
const trustProxy = process.env.CCRANK_TRUST_PROXY === "1";
const allow = makeLimiter(Number(process.env.CCRANK_RATE_LIMIT ?? 120), 60_000);

let dataset = null;      // { release, total, index, size, fh }
let pointerMtime = 0;

async function loadIfChanged() {
  const pointer = path.join(dataDir, "current.json");
  let mtime;
  try { mtime = (await stat(pointer)).mtimeMs; } catch { return; } // nothing built yet
  if (mtime === pointerMtime) return;
  const { release } = JSON.parse(await readFile(pointer, "utf8"));
  if (!/^cc-main-[a-z0-9-]+$/.test(String(release))) throw new Error("current.json: bad release id");
  const dir = path.join(dataDir, release);
  const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
  const index = parseIndex(await readFile(path.join(dir, "index.tsv"), "latin1"));
  const fh = await open(path.join(dir, "ranks.tsv"), "r");
  const size = (await fh.stat()).size;
  const previous = dataset;
  dataset = { release, total: meta.total, index, size, fh };
  pointerMtime = mtime;
  console.log(new Date().toISOString(), `serving ${release}: ${meta.total} domains, ${index.keys.length} index entries`);
  // Requests already in flight may still hold the old handle; close it after they are done.
  if (previous) setTimeout(() => previous.fh.close().catch(() => {}), 30_000);
}

const readBlock = ds => async (start, end) => {
  const buf = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await ds.fh.read(buf, 0, buf.length, start);
  return buf.toString("latin1", 0, bytesRead);
};

function clientIp(req) {
  if (trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function send(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "x-content-type-options": "nosniff", ...extra });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/v1/health") {
      return send(res, dataset ? 200 : 503, dataset ? { ok: true, release: dataset.release, total: dataset.total } : { ok: false, error: "no_data" });
    }
    if (url.pathname !== "/v1/rank") return send(res, 404, { error: "not_found" });
    if (!allow(clientIp(req))) return send(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
    const ds = dataset;
    if (!ds) return send(res, 503, { error: "no_data" });

    const asked = String(url.searchParams.get("d") ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (!asked.length) return send(res, 400, { error: "missing_d" });
    if (asked.length > MAX_QUERY_DOMAINS) return send(res, 400, { error: "too_many_domains", max: MAX_QUERY_DOMAINS });

    const read = readBlock(ds);
    const results = [];
    for (const d of asked) results.push(await lookup(ds, d, read));
    // A release is immutable, so an answer is cacheable until the next monthly switch.
    return send(res, 200, { release: ds.release, total: ds.total, results }, { "cache-control": "public, max-age=86400" });
  } catch (err) {
    console.error(new Date().toISOString(), "request failed:", err?.message ?? err);
    return send(res, 500, { error: "internal" });
  }
});

await loadIfChanged().catch(err => console.error("initial load failed:", err.message));
setInterval(() => loadIfChanged().catch(err => console.error("reload failed:", err.message)), 60_000).unref();
server.listen(port, host, () => console.log(new Date().toISOString(), `ccrank listening on http://${host}:${port} (data: ${dataDir})`));
