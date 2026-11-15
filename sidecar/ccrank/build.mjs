#!/usr/bin/env node
// ccrank build — turn one Common Crawl web-graph release into the lookup files server.mjs reads.
//
//   node build.mjs [--release cc-main-2026-may-jun-jul] [--data ./data] [--keep-download]
//                  [--source <url>]   a ranks .txt.gz to use instead of the official one
//                                     (file:// works — that is how the self-test builds)
//
// Steps: resolve the newest release → download the domain ranks file (2.2 GB, resumable) →
// gunzip + reshape + `sort` by domain → write the sparse index and meta → switch `current.json`
// to the new release in one rename. The running server notices the switch within a minute; a
// failed build leaves the previous release untouched.
//
// Needs: Node 20+, `curl`, GNU `sort`. Disk: ~2.2 GB download + ~5 GB result + sort temp
// (~5 GB, in <data>/tmp). RAM: sort is capped at 1 GB (-S).

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeader, transformLine, STRIDE } from "./lib.mjs";

const GRAPHINFO_URL = "https://index.commoncrawl.org/graphinfo.json";
const DATA_BASE = "https://data.commoncrawl.org/projects/hyperlinkgraph";

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(`--${name}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(arg("data") ?? process.env.CCRANK_DATA ?? path.join(here, "data"));

const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function newestRelease() {
  const res = await fetch(GRAPHINFO_URL, { headers: { "user-agent": "opengsc-ccrank-build/1.0" } });
  if (!res.ok) throw new Error(`graphinfo.json: HTTP ${res.status}`);
  const list = await res.json();
  const id = Array.isArray(list) ? list[0]?.id : null;
  if (!id || !/^cc-main-[a-z0-9-]+$/.test(id)) throw new Error("graphinfo.json: no usable release id");
  return id;
}

async function currentRelease() {
  try { return JSON.parse(await readFile(path.join(dataDir, "current.json"), "utf8")).release ?? null; } catch { return null; }
}

/** gunzip → reshape → sort. Returns the number of rows written. */
async function reshapeAndSort(gzPath, outPath, tmpDir) {
  const sort = spawn("sort", ["-t", "\t", "-k1,1", "-S", "1G", "-T", tmpDir, "-o", outPath], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, LC_ALL: "C" }, // bytewise order — the lookup relies on it
  });
  const sorted = new Promise((resolve, reject) => {
    sort.on("error", reject);
    sort.on("exit", code => (code === 0 ? resolve() : reject(new Error(`sort exited with ${code}`))));
  });

  const rl = createInterface({ input: createReadStream(gzPath).pipe(createGunzip()), crlfDelay: Infinity });
  let cols = null, rows = 0, dropped = 0;
  for await (const line of rl) {
    if (!cols) {
      if (line[0] !== "#") throw new Error("ranks file has no header line");
      cols = parseHeader(line);
      continue;
    }
    const out = transformLine(line, cols);
    if (!out) { dropped++; continue; }
    rows++;
    if (!sort.stdin.write(out + "\n")) await new Promise(r => sort.stdin.once("drain", r));
    if (rows % 10_000_000 === 0) log(`  ${rows / 1e6} M rows`);
  }
  sort.stdin.end();
  await sorted;
  log(`reshaped ${rows} rows, dropped ${dropped} malformed`);
  return rows;
}

/** One pass over the sorted file: every STRIDE-th row's key and byte offset. */
async function writeIndex(ranksPath, indexPath) {
  const out = createWriteStream(indexPath);
  let offset = 0, row = 0, carry = Buffer.alloc(0), prev = "";
  for await (const chunk of createReadStream(ranksPath)) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(10, start); nl >= 0; nl = buf.indexOf(10, start)) {
      const tab = buf.indexOf(9, start);
      const key = buf.toString("latin1", start, tab >= 0 && tab < nl ? tab : nl);
      if (key < prev) throw new Error(`ranks.tsv is not sorted at row ${row}: ${prev} > ${key}`);
      prev = key;
      if (row % STRIDE === 0) out.write(`${key}\t${offset}\n`);
      offset += nl + 1 - start;
      start = nl + 1;
      row++;
    }
    carry = buf.subarray(start);
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  return row;
}

async function main() {
  const release = arg("release") ?? (await newestRelease());
  if (!/^cc-main-[a-z0-9-]+$/.test(release)) throw new Error(`bad release id: ${release}`);
  const live = await currentRelease();
  if (live === release && !flag("force")) { log(`already on ${release} — nothing to do (use --force to rebuild)`); return; }

  const tmpDir = path.join(dataDir, "tmp");
  const workDir = path.join(dataDir, `${release}.building`);
  const finalDir = path.join(dataDir, release);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const source = arg("source") ?? `${DATA_BASE}/${release}/domain/${release}-domain-ranks.txt.gz`;
  const gzPath = path.join(tmpDir, `${release}-domain-ranks.txt.gz`);
  log(`downloading ${source}`);
  await run("curl", ["-fL", "--retry", "8", "--retry-delay", "10", "-C", "-", "-o", gzPath, source]);

  log("reshaping and sorting (this is the long step)");
  const ranksPath = path.join(workDir, "ranks.tsv");
  const rows = await reshapeAndSort(gzPath, ranksPath, tmpDir);
  // Guard against a truncated download or a format change: every release so far has had
  // well over 50 M registered domains. Refuse to publish something that is obviously not that.
  if (rows < 10_000_000 && !flag("allow-small")) throw new Error(`only ${rows} rows — refusing to publish (pass --allow-small for a test file)`);

  log("writing the sparse index");
  const indexed = await writeIndex(ranksPath, path.join(workDir, "index.tsv"));
  if (indexed !== rows) throw new Error(`index pass saw ${indexed} rows, expected ${rows}`);
  await writeFile(path.join(workDir, "meta.json"), JSON.stringify({ release, total: rows, stride: STRIDE, builtAt: new Date().toISOString(), source }, null, 2));

  await rm(finalDir, { recursive: true, force: true });
  await rename(workDir, finalDir);
  // The switch itself: write beside, then rename over — the server never reads a half-written file.
  const pointerTmp = path.join(dataDir, "current.json.tmp");
  await writeFile(pointerTmp, JSON.stringify({ release, switchedAt: new Date().toISOString() }));
  await rename(pointerTmp, path.join(dataDir, "current.json"));
  log(`switched to ${release}: ${rows} domains, ${((await stat(path.join(finalDir, "ranks.tsv"))).size / 1e9).toFixed(1)} GB`);

  if (!flag("keep-download")) await rm(gzPath, { force: true });
  // Keep the previous release as a fallback, drop anything older.
  const releases = (await readdir(dataDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^cc-main-[a-z0-9-]+$/.test(e.name) && e.name !== release && e.name !== live)
    .map(e => e.name);
  for (const old of releases) { log(`removing old release ${old}`); await rm(path.join(dataDir, old), { recursive: true, force: true }); }
}

main().catch(err => { console.error(new Date().toISOString(), "BUILD FAILED:", err.message); process.exit(1); });
