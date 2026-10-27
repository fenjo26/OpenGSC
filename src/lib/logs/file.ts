/**
 * Stream one access-log file (plain or gzip, detected by magic bytes) through the aggregator,
 * then verify the crawler IPs. Kept apart from importer.ts so it runs without the database.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";
import zlib from "node:zlib";
import { LogAggregator, type LogSummary } from "./aggregate";
import { parseAccessLine } from "./parse";
import { verifyIps, type Verification } from "./verify";

const MAX_LINES = 30_000_000;

async function isGzip(file: string): Promise<boolean> {
  const handle = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(2);
    await handle.read(buf, 0, 2, 0);
    return buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

/** Stream one file through the aggregator and the verifier. */
export async function summarizeLogFile(
  file: string,
  verify: (ips: { ip: string; family: string }[]) => Promise<Verification> = verifyIps,
): Promise<LogSummary> {
  const raw = fs.createReadStream(file);
  const input = (await isGzip(file)) ? raw.pipe(zlib.createGunzip()) : raw;
  const agg = new LogAggregator();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      agg.add(parseAccessLine(line));
      if (agg.lines >= MAX_LINES) break;
    }
  } finally {
    rl.close();
    raw.destroy();
  }
  const { verdicts, dnsAvailable } = await verify(agg.ipsToVerify());
  return agg.finalize(verdicts, { dnsAvailable });
}

