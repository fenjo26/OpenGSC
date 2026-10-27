/**
 * Reverse-DNS verification of crawler IPs — Google's, Bing's, Yandex's and Apple's documented
 * method: the PTR of the IP must end in the crawler's domain, and that hostname must resolve back
 * to the same IP. A user agent alone proves nothing; scrapers routinely call themselves Googlebot.
 *
 * Bounded: at most MAX_IPS lookups per import, CONCURRENCY at a time, each with a timeout.
 * Anything not checked or not answered is "unknown" — never "fake": a slow resolver must not make
 * real Googlebot traffic disappear from the report.
 *
 * "No PTR record" only counts as fake once the resolver has proven it works: a probe reverse-
 * resolves a known Googlebot address first. A server whose DNS is broken answers ENOTFOUND for
 * every address — including Google's own — and without the probe would declare every real
 * Googlebot a fake.
 */
import { promises as dns } from "node:dns";
import { familyById } from "./bots";
import type { IpVerdict } from "./aggregate";

const MAX_IPS = 1000;
const CONCURRENCY = 16;
const TIMEOUT_MS = 3000;
/** A documented Googlebot address whose PTR is crawl-66-249-66-1.googlebot.com. */
const PROBE_IP = "66.249.66.1";

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS))]);
}

/** Pure part: does this PTR hostname belong to the family's crawler domains? */
export function hostnameMatches(hostname: string, suffixes: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return suffixes.some(s => h === s || h.endsWith(`.${s}`));
}

let resolverWorks = false;

/** Does reverse DNS work from this server at all? */
export async function probeResolver(): Promise<boolean> {
  try {
    const names = await withTimeout(dns.reverse(PROBE_IP));
    return names.some(name => hostnameMatches(name, ["googlebot.com"]));
  } catch {
    return false;
  }
}

export async function verifyIp(ip: string, familyId: string): Promise<IpVerdict> {
  const suffixes = familyById(familyId)?.rdns;
  if (!suffixes) return "unknown";
  let names: string[];
  try {
    names = await withTimeout(dns.reverse(ip));
  } catch (e) {
    // No PTR record at all is a definite answer for a crawler that always has one.
    const code = (e as { code?: string })?.code;
    return (code === "ENOTFOUND" || code === "ENODATA") && resolverWorks ? "fake" : "unknown";
  }
  const candidate = names.find(name => hostnameMatches(name, suffixes));
  if (!candidate) return names.length ? "fake" : "unknown";
  try {
    const family = ip.includes(":") ? 6 : 4;
    const addrs = family === 6 ? await withTimeout(dns.resolve6(candidate)) : await withTimeout(dns.resolve4(candidate));
    const norm = (a: string) => a.toLowerCase();
    return addrs.map(norm).includes(norm(ip)) ? "verified" : "fake";
  } catch {
    return "unknown";
  }
}

export interface Verification {
  verdicts: Map<string, IpVerdict>;
  /** false = the resolver did not answer the probe; every verdict is then "unknown". */
  dnsAvailable: boolean;
}

export async function verifyIps(ips: readonly { ip: string; family: string }[]): Promise<Verification> {
  const out = new Map<string, IpVerdict>();
  if (!ips.length) return { verdicts: out, dnsAvailable: true };
  resolverWorks = await probeResolver();
  if (!resolverWorks) return { verdicts: out, dnsAvailable: false };
  const queue = ips.slice(0, MAX_IPS);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (next < queue.length) {
      const item = queue[next++];
      out.set(item.ip, await verifyIp(item.ip, item.family).catch((): IpVerdict => "unknown"));
    }
  }));
  return { verdicts: out, dnsAvailable: true };
}
