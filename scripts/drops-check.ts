// Live probe of the drops funnel — the phase-1 check tool docs/DROPS-PLAN.md asks for.
//
//   npx tsx scripts/drops-check.ts domain [domain ...]
//   npx tsx scripts/drops-check.ts --recon name.fr [name.gr ...]
//
// Plain mode runs the funnel exactly as the app does: ingest normalisation, the DNS
// pre-filter, then registry verdicts for everything DNS did not settle. --recon skips
// the funnel and prints the RAW WHOIS body per name — phase 0's job of capturing a
// zone's exact "free" phrasing before trusting a profile against it.

import { checkAvailabilityBatch } from "@/lib/drops/availability";
import { checkDnsBatch, settlesWithoutRegistry } from "@/lib/drops/dns";
import { parseDomainList } from "@/lib/drops/ingest";
import { profileForDomain } from "@/lib/drops/registries";
import { discoverWhoisHost, whoisQuery } from "@/lib/drops/whois";
import type { AvailabilityResult } from "@/lib/drops/types";

const recon = process.argv.includes("--recon");
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));

function verdictLine(r: AvailabilityResult): string {
  if (r.ok && r.status === "registered") {
    const exp = r.expiresAt ? ` expires ${r.expiresAt.toISOString().slice(0, 10)}` : "";
    return `registered        via ${r.via}${exp}`;
  }
  if (r.ok && r.status === "available") {
    return r.corroborated
      ? "AVAILABLE ✔✔      rdap 404 + whois agree"
      : `AVAILABLE ?       uncorroborated (via ${r.via}) — do not buy on this`;
  }
  if (!r.ok && r.status === "rate_limited") return "rate_limited      backed off, retry later";
  return `error             ${"error" in r ? r.error : "unknown"}`;
}

async function reconMode(): Promise<never> {
  for (const domain of args) {
    const profile = profileForDomain(domain);
    console.log(`\n──── ${domain} (tld=${profile?.tld} rdap=${profile?.rdap ?? "none"} verified=${profile?.verified})`);
    if (!profile) { console.log("  not a domain"); continue; }
    const host = profile.whoisHost ?? (await discoverWhoisHost(profile.tld));
    console.log(`  whois host: ${host ?? "discovery failed"}`);
    if (!host) continue;
    try {
      const body = await whoisQuery(host, domain);
      const lines = body.trimEnd().split(/\r?\n/);
      console.log(lines.slice(0, 30).join("\n  "));
      if (lines.length > 30) {
        console.log(`  … (${Math.max(0, lines.length - 38)} more lines)`);
        console.log("  " + lines.slice(-8).join("\n  "));
      }
    } catch (e) {
      console.log(`  WHOIS ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(0);
}

async function main() {
  if (recon) await reconMode();

  // ── Stage 1: ingest — the same parser the import box uses ────────────────────
  const { domains, skipped } = parseDomainList(args.join("\n"));
  console.log(`ingest: ${domains.length} accepted, ${skipped.length} skipped` +
    skipped.map(s => `\n  skipped ${s.reason}: ${s.value}`).join(""));

  // ── Stage 2: DNS pre-filter — free, and the reason registries see ~10% ───────
  console.log("\nDNS pre-filter:");
  const dns = await checkDnsBatch(domains);
  const counts = { delegated: 0, nxdomain: 0, no_records: 0, unknown: 0 } as Record<string, number>;
  for (const d of domains) counts[dns.get(d)!.outcome]++;
  for (const [k, v] of Object.entries(counts)) if (v) console.log(`  ${k.padEnd(11)} ${v}`);
  const onward = domains.filter(d => !settlesWithoutRegistry(dns.get(d)!.outcome));

  // ── Stage 3: registries — RDAP then WHOIS, throttled per zone ────────────────
  console.log(`\nRegistry verdicts (${onward.length} names, zones run in parallel, throttled per zone):`);
  const t0 = Date.now();
  const results = await checkAvailabilityBatch(onward);
  for (const d of domains) {
    const dnsRes = dns.get(d)!;
    if (settlesWithoutRegistry(dnsRes.outcome)) {
      console.log(`  ${d.padEnd(34)} dns:delegated (${dnsRes.nameServers[0] ?? "?"}…)`);
      continue;
    }
    const r = results.get(d);
    console.log(`  ${d.padEnd(34)} dns:${dnsRes.outcome.padEnd(10)} ${r ? verdictLine(r) : "no result"}`);
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

void main();
