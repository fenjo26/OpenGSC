// What a live A-Parser answers to the exact requests the SERP Monitor makes — the contract
// snapshot docs/tasks/serp-monitor/T1-aparser-serp.md asks for. It exists for ONE decision:
// the internal option ids of SE::Google are not in the documentation (the docs name settings in
// prose, `options` overrides address them by id), and step 2 below is the ground truth that
// is what APARSER_SERP_OPTION_IDS in src/lib/seo/aparserSerp.ts was verified against.
//
//   OPENGSC_APARSER_BASE_URL=… OPENGSC_APARSER_PASSWORD=… \
//     npx tsx scripts/aparser-serp-probe.ts "casino online" ar es 100
//
// Without env vars the owner's stored settings are used (like getAparserServerCreds does in the
// app; the owner is the first user in the database). Run it on a machine that can reach the
// instance — a LAN address from a random VPS answers with a connection error, not a secret.
// The password is never printed; the transport's error strings are host-only by construction.

import "dotenv/config";
import {
  aparserInfo, aparserOneRequest, aparserParserPreset, envPassword, normaliseBaseUrl,
} from "@/lib/seo/aparser";
import { getAparserServerCreds } from "@/lib/seo/aparserServerCreds";
import { APARSER_SERP_OPTION_IDS, APARSER_SERP_PARSERS, aparserSerpOptions, describeAparserRow, mapAparserSerp } from "@/lib/seo/aparserSerp";
import { prisma } from "@/lib/prisma";

const PROBE_TIMEOUT_MS = 180_000;

interface ProbeCreds { baseUrl: string; password: string; configPreset?: string; source?: string }

async function loadCreds(): Promise<ProbeCreds | null> {
  // The same resolution the app uses (env and settings passwords probed, first accepted wins),
  // so this script cannot disagree with the SERP Monitor about which password is live. It used
  // to take the env pair blindly, which reproduced exactly the stale-env "Auth failed" it was
  // meant to diagnose. User has no createdAt, so "the owner" is the first id — single-user
  // deployment is the norm.
  const owner = await prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true } }).catch(() => null);
  if (owner) {
    const creds = await getAparserServerCreds(owner.id);
    if (creds) return creds;
  }
  // No database reachable: the env pair alone.
  const envUrl = (process.env.OPENGSC_APARSER_BASE_URL || "").trim();
  const envPass = envPassword();
  if (envUrl && envPass) {
    const norm = normaliseBaseUrl(envUrl);
    if (!("problem" in norm)) return { baseUrl: norm.url, password: envPass, source: "env" };
  }
  return null;
}

function printRow(r: { anchor: unknown; link: unknown }, i: number): void {
  console.log(`  ${String(i + 1).padStart(3)}. ${String(r.anchor ?? "").slice(0, 80)}`);
  console.log(`      ${String(r.link ?? "")}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [query, gl = "us", hl = "en", depthArg] = args;
  if (!query) {
    console.error('Usage: npx tsx scripts/aparser-serp-probe.ts "<query>" <gl> <hl> [depth=100]');
    process.exit(1);
  }
  const depth = Math.max(1, Number(depthArg) || 100);

  const creds = await loadCreds();
  if (!creds) {
    console.error(
      "No A-Parser connection found. Set OPENGSC_APARSER_BASE_URL and OPENGSC_APARSER_PASSWORD, "
      + "or configure them for the owner in Settings → API keys.",
    );
    process.exit(1);
  }
  const host = normaliseBaseUrl(creds.baseUrl);
  console.log(`A-Parser: ${"url" in host ? host.url : creds.baseUrl}  [creds: ${creds.source ?? "?"}]`);
  if (process.env.OPENGSC_APARSER_PASSWORD && creds.source === "settings") {
    console.warn("   ! OPENGSC_APARSER_PASSWORD in .env is rejected by A-Parser — the password saved in Settings works. Fix or remove the env var.");
  }
  console.log(`Query: "${query}"  gl=${gl}  hl=${hl}  depth=${depth}\n`);

  // ── 1. Does this instance even have the parser? ───────────────────────────
  const info = await aparserInfo(creds);
  if (!info.data) {
    console.error(`info failed: ${info.error ?? "no answer"}`);
    process.exit(1);
  }
  const parser = APARSER_SERP_PARSERS.google;
  const hasParser = info.data.availableParsers.includes(parser);
  console.log(`1. availableParsers: ${info.data.availableParsers.length} parsers, SE::Google ${hasParser ? "PRESENT" : "MISSING"}`);
  if (!hasParser) {
    console.error(`   → ${parser} is not installed on this build; nothing below will work.`);
    process.exit(1);
  }

  // ── 2. The preset dump — the main output, the authority on option ids ─────
  const presetName = "default";
  const preset = await aparserParserPreset(creds, parser, presetName);
  if (!preset.data) {
    console.error(`getParserPreset ${parser} ${presetName} failed: ${preset.error ?? "no answer"}`);
    process.exit(1);
  }
  console.log(`\n2. getParserPreset ${parser} ${presetName} — option ids and values:`);
  console.log(JSON.stringify(preset.data, null, 2));
  const presetKeys = new Set(Object.keys(preset.data ?? {}));
  console.log("   Our override ids vs this preset:");
  for (const [slot, id] of Object.entries(APARSER_SERP_OPTION_IDS)) {
    const known = id ? presetKeys.has(id) : false;
    console.log(`   ${slot.padEnd(9)} → "${id}" ${known ? "present in preset" : "NOT in preset — fix APARSER_SERP_OPTION_IDS"}`);
  }

  // ── 3. The request SERP Monitor itself makes ──────────────────────────────
  const options = aparserSerpOptions({ depth, gl, hl });
  console.log(`\n3. oneRequest with options ${JSON.stringify(options)}`);
  const started = Date.now();
  const r = await aparserOneRequest(creds, parser, query, options, { preset: presetName, timeoutMs: PROBE_TIMEOUT_MS, doLog: true });
  const ms = Date.now() - started;
  if (!r.data) {
    console.error(`oneRequest failed after ${ms} ms: ${r.error ?? "no answer"}`);
    process.exit(1);
  }
  const rows = Array.isArray(r.data.results) ? r.data.results : [];
  const row = rows[0] ?? null;
  // The raw shape, trimmed: when the mapping disagrees with this build, this is the evidence.
  console.log(`   results is ${Array.isArray(r.data.results) ? `an array of ${rows.length}` : typeof r.data.results}`);
  console.log(`   raw (first 1500 chars): ${JSON.stringify(Array.isArray(r.data.results) ? row : r.data.results)?.slice(0, 1500)}`);
  console.log(`   diagnosis: ${describeAparserRow(Array.isArray(r.data.results) ? row : r.data.results, r.data.logs, 2000)}`);
  console.log(`   request took ${(ms / 1000).toFixed(1)} s, results[0]: ${row ? "present" : "ABSENT"}`);
  if (!row || typeof row !== "object") {
    console.error("   → no structured row. rawResults was 1; a missing results[0] means the call failed.");
    process.exit(1);
  }
  const record = row as Record<string, unknown>;
  const serp = Array.isArray(record.serp) ? record.serp : [];
  console.log(`   serp rows: ${serp.length}${serp.length <= 10 ? "  ← too few: depth did not take, check pagecount id above" : ""}`);
  console.log(`   totalcount: ${JSON.stringify(record.totalcount ?? null)}`);
  console.log(`   other keys in results[0] (candidates for features): ${Object.keys(record).join(", ")}`);
  console.log("   first 3 rows:");
  const first3 = serp.slice(0, 3);
  for (let i = 0; i < first3.length; i++) {
    const raw = first3[i];
    if (raw && typeof raw === "object") printRow(raw as { anchor: unknown; link: unknown }, i);
  }
  const mapped = mapAparserSerp(row, depth);
  console.log(`   mapped: ${mapped.results.length} results, totalCount="${mapped.totalCount}", features=[${mapped.features.join(", ")}], problem=${mapped.problem ?? "null"}`);
  console.log("\nDone. If every id above reads 'present in preset' and serp rows is 90–100, "
    + "the ids in src/lib/seo/aparserSerp.ts match this build.");
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
