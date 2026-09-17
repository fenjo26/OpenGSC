// What a live A-Parser answers to the exact SE::Google::Position requests the Rank Tracker
// makes. Run it once before switching the tracker to A-Parser, and again after an A-Parser
// update: it is the ground truth for the option ids in src/lib/seo/aparserPosition.ts and for the
// raw row shape `mapAparserPosition` reads (position / link / bulkcheck).
//
//   npx tsx scripts/aparser-position-probe.ts transfer-thessaloniki.gr "taxi thessaloniki airport" gr el
//   npx tsx scripts/aparser-position-probe.ts <site> "<keyword>" <gl> <hl> [depth=100] [--dump] [--opt id=value ...]
//
// Four requests: (a) the site as the tracker would ask, (b) the same keyword for a domain that
// cannot rank (is "not found" a clean 0 after all pages?), (c) exact-domain mode with the www twin
// (the plan used for subdomains), (d) SE::Google for the same keyword, to compare the position
// against a full SERP. Creds come from the app's own resolution (env and settings probed).
// The password is never printed.

import "dotenv/config";
import { aparserInfo, aparserOneRequest, aparserParserPreset, normaliseBaseUrl, type AparserOption } from "@/lib/seo/aparser";
import { getAparserServerCreds } from "@/lib/seo/aparserServerCreds";
import {
  APARSER_POSITION_OPTION_IDS, APARSER_POSITION_PARSER, aparserPositionOptions, aparserPositionQuery,
  mapAparserPosition, positionMatchPlan, type PositionMatchPlan,
} from "@/lib/seo/aparserPosition";
import { APARSER_SERP_PARSERS, aparserSerpOptions, describeAparserRow, mapAparserSerp } from "@/lib/seo/aparserSerp";
import { prisma } from "@/lib/prisma";

const TIMEOUT_MS = 180_000;

function hostMatches(url: string, site: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return h === site || h.endsWith("." + site);
  } catch { return false; }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const extra: AparserOption[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--opt" && argv[i + 1]) {
      const m = argv[++i]; const eq = m.indexOf("=");
      if (eq <= 0) { console.error(`--opt expects id=value, got "${m}"`); process.exit(1); }
      const raw = m.slice(eq + 1);
      extra.push({ type: "override", id: m.slice(0, eq), value: /^-?\d+$/.test(raw) ? Number(raw) : raw });
    } else if (!argv[i].startsWith("--")) positional.push(argv[i]);
  }
  const dump = argv.includes("--dump");
  const [siteArg, keyword, gl = "us", hl = "en", depthArg] = positional;
  if (!siteArg || !keyword) {
    console.error('Usage: npx tsx scripts/aparser-position-probe.ts <site> "<keyword>" <gl> <hl> [depth=100] [--dump] [--opt id=value ...]');
    process.exit(1);
  }
  const depth = Math.min(100, Math.max(10, Number(depthArg) || 100));
  const site = siteArg.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");

  const owner = await prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true } }).catch(() => null);
  const creds = owner ? await getAparserServerCreds(owner.id) : null;
  if (!creds) { console.error("No A-Parser connection (env OPENGSC_APARSER_* or Settings)."); process.exit(1); }
  const host = normaliseBaseUrl(creds.baseUrl);
  console.log(`A-Parser: ${"url" in host ? host.url : "?"} [creds: ${creds.source}]  site=${site}  "${keyword}" ${gl}/${hl} depth=${depth}\n`);

  const info = await aparserInfo(creds);
  if (!info.data) { console.error(`info failed: ${info.error}`); process.exit(1); }
  const has = info.data.availableParsers.includes(APARSER_POSITION_PARSER);
  console.log(`1. A-Parser ${info.data.version} · ${APARSER_POSITION_PARSER} ${has ? "PRESENT" : "MISSING"}`);
  if (!has) process.exit(1);

  const preset = await aparserParserPreset(creds, APARSER_POSITION_PARSER, "default");
  if (!preset.data) { console.error(`getParserPreset failed: ${preset.error}`); process.exit(1); }
  console.log(`\n2. getParserPreset ${APARSER_POSITION_PARSER} default:`);
  console.log(JSON.stringify(preset.data, null, 2));
  const keys = new Set(Object.keys(preset.data));
  console.log("   Our override ids vs this preset:");
  for (const [slot, id] of Object.entries(APARSER_POSITION_OPTION_IDS)) {
    console.log(`   ${slot.padEnd(22)} → "${id}" ${keys.has(id) ? "present" : "NOT in preset"}`);
  }
  const stopKeys = [...keys].filter((k) => /stop|found|match/i.test(k));
  console.log(`   stop/match-looking ids: ${stopKeys.join(", ") || "none"}`);

  const run = async (label: string, plan: PositionMatchPlan) => {
    const base = aparserPositionOptions({ depth, gl, hl, matchType: plan.matchType });
    const options = [...base.filter((o) => !extra.some((e) => e.id === o.id)), ...extra];
    const query = aparserPositionQuery(plan, keyword);
    console.log(`\n${label}  query="${query}"\n   options ${JSON.stringify(options)}`);
    const t0 = Date.now();
    const r = await aparserOneRequest(creds, APARSER_POSITION_PARSER, query, options, { timeoutMs: TIMEOUT_MS, doLog: true });
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.data) { console.log(`   FAILED after ${s} s: ${r.error}`); return null; }
    const row = Array.isArray(r.data.results) ? r.data.results[0] : null;
    const raw = JSON.stringify(row);
    console.log(`   ${s} s · keys: ${row && typeof row === "object" ? Object.keys(row).join(", ") : "—"}`);
    console.log(`   raw (${dump ? "full" : "first 2000 chars"}): ${dump ? raw : raw?.slice(0, 2000)}`);
    console.log(`   diagnosis: ${describeAparserRow(row, r.data.logs, 600)}`);
    const mapped = mapAparserPosition(row, r.data.logs, { siteHost: plan.domains[0].replace(/^www\./, ""), depth });
    console.log(`   mapped: position=${mapped.position} url=${mapped.url} problem=${mapped.problem ?? "null"}${mapped.detail ? `\n   detail: ${mapped.detail}` : ""}`);
    return mapped;
  };

  const plan = positionMatchPlan(site);
  const a = await run(`3a. tracker plan (${plan.matchType})`, plan);
  await run("3b. not-found control", { domains: ["opengsc-probe-nonexistent-site.com"], matchType: "domain" });
  await run("3c. exact domain + www twin (subdomain plan)", { domains: [site, `www.${site}`], matchType: "domain" });

  console.log(`\n3d. ${APARSER_SERP_PARSERS.google} full SERP for comparison`);
  const t0 = Date.now();
  const serp = await aparserOneRequest(creds, APARSER_SERP_PARSERS.google, keyword, aparserSerpOptions({ depth, gl, hl }), { timeoutMs: TIMEOUT_MS, doLog: true });
  const row = serp.data && Array.isArray(serp.data.results) ? serp.data.results[0] : null;
  const m = mapAparserSerp(row, depth);
  const hit = m.results.find((x) => hostMatches(x.url, site));
  console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)} s · ${m.results.length} results, problem=${m.problem ?? "null"} · site at ${hit ? `${hit.position} (${hit.url})` : "—"}`);
  if (a && !a.problem && hit && a.position !== hit.position) {
    console.log(`   ! Position says ${a.position}, SE::Google says ${hit.position} — send both lines along.`);
  }
  console.log("\nDone. Send the whole output back.");
  await prisma.$disconnect().catch(() => {});
}

void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
