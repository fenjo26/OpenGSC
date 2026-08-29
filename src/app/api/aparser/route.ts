import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getUserSettings } from "@/lib/mcp/shared";
import {
  aparserAddTask, aparserInfo, aparserOneRequest, aparserParserPreset, aparserPing, aparserProxies,
  aparserTaskResults, aparserTaskState,
  envPassword, normaliseBaseUrl, resolveBaseUrl, setAparserConcurrency,
  type AparserCreds, type AparserOption,
} from "@/lib/seo/aparser";

// POST /api/aparser — talk to the user's own A-Parser instance.
//
// Every other provider route here forwards a key to a host this code owns. This one forwards a
// password to a host the USER names, which is a different thing and is why the guard is
// `manageSecrets` rather than `act`.
//
// `manageSecrets` is owner-only (lib/team/roles.ts), so the set of people who can make this
// server open a connection to an address they chose is exactly the set of people who already
// control the instance, its .env and its network. There is no escalation left to prevent — but
// there would be if this route accepted a base URL from a viewer or an editor, because the
// normal, expected value here is a private LAN address. That is precisely the request an SSRF
// guard exists to refuse, and the only reason it is allowed is that the person asking owns both
// ends. Do not relax this capability.
//
// The base URL and password fall back to the env vars and then to the owner's stored settings,
// so a configured instance can be checked with `{ "op": "ping" }` and nothing else.

export const dynamic = "force-dynamic";

const URL_PROBLEM_STATUS = 400;

export async function POST(req: Request) {
  const ownerId = await workspaceUserId("manageSecrets");
  if (!ownerId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({} as any));
  const op = String(b?.op ?? "ping");

  const settings = await getUserSettings(ownerId);
  const rawBase = String(b?.baseUrl ?? "").trim() || String(settings.seoBaseUrl_aparser ?? "");
  const resolved = resolveBaseUrl(rawBase);
  if ("problem" in resolved) {
    return NextResponse.json({ error: `aparser_url_${resolved.problem}` }, { status: URL_PROBLEM_STATUS });
  }

  const password = String(b?.password ?? "").trim() || envPassword() || String(settings.seoKey_aparser ?? "");
  if (!password) return NextResponse.json({ error: "no_aparser_password" }, { status: 400 });

  const configPreset = String(b?.configPreset ?? "").trim() || String(settings.seoAparserConfig ?? "") || "default";
  const creds: AparserCreds = { baseUrl: resolved.url, password, configPreset };

  const concurrency = Number(settings.seoAparserConcurrency);
  if (Number.isFinite(concurrency)) setAparserConcurrency(concurrency);

  // ── ping: the one call the settings card makes ────────────────────────────
  //
  // It runs `info` too, and returns the parser list. "It answered" and "it has the parser this
  // feature needs" are different questions with the same symptom when only the first is asked,
  // and the second is the one that decides what the UI may offer.
  if (op === "ping") {
    const pong = await aparserPing(creds);
    if (!pong.data) return NextResponse.json({ error: pong.error ?? "aparser_no_answer", fromEnv: resolved.fromEnv }, { status: 502 });
    const info = await aparserInfo(creds);
    return NextResponse.json({
      ok: true,
      fromEnv: resolved.fromEnv,
      host: hostOf(resolved.url),
      info: info.data,
      infoError: info.data ? undefined : info.error,
    });
  }

  if (op === "info") {
    const r = await aparserInfo(creds);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({ info: r.data, host: hostOf(resolved.url), fromEnv: resolved.fromEnv });
  }

  if (op === "proxies") {
    const r = await aparserProxies(creds);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    const byType: Record<string, number> = {};
    for (const types of Object.values(r.data)) {
      for (const type of types ?? []) byType[type] = (byType[type] ?? 0) + 1;
    }
    const total = Object.keys(r.data).length;
    // detail=1 returns the endpoints themselves. This is the owner's own infrastructure on an
    // owner-only route — the collapse to counts was for echo hygiene, not a secret, and the
    // console's proxy panel needs the list to answer "which endpoints are actually alive".
    if (b?.detail) return NextResponse.json({ total, byType, proxies: r.data });
    return NextResponse.json({ total, byType });
  }

  // ── batch: queue on the instance's own schedule, poll, fetch the results file ──
  if (op === "add_task") {
    const parser = String(b?.parser ?? "").trim();
    const queries = Array.isArray(b?.queries) ? b.queries.map((q: any) => String(q)).filter((q: string) => q.trim()) : [];
    if (!parser) return NextResponse.json({ error: "no_parser" }, { status: 400 });
    if (!queries.length) return NextResponse.json({ error: "no_queries" }, { status: 400 });
    const r = await aparserAddTask(creds, {
      parser,
      preset: String(b?.preset ?? "default"),
      queries,
      resultsFormat: typeof b?.resultsFormat === "string" && b.resultsFormat.trim() ? b.resultsFormat : undefined,
    });
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({ taskid: r.data });
  }

  if (op === "task_state") {
    const taskid = Number(b?.taskid);
    if (!Number.isFinite(taskid)) return NextResponse.json({ error: "no_taskid" }, { status: 400 });
    const r = await aparserTaskState(creds, taskid);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({ status: r.data.status, raw: r.data.raw });
  }

  if (op === "task_results") {
    const taskid = Number(b?.taskid);
    if (!Number.isFinite(taskid)) return NextResponse.json({ error: "no_taskid" }, { status: 400 });
    const r = await aparserTaskResults(creds, taskid);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({ results: r.data });
  }

  // ── preset: what the option ids on THIS build actually are ─────────────────
  //
  // The documentation names options in prose ("Pages count", "Results language") while
  // `options` overrides address them by internal id. Reading a live preset is the only reliable
  // way to learn the mapping, and getting it wrong is silent: an unknown id is either rejected
  // outright or ignored, and an ignored one means the parser answered a different question than
  // the one the app asked.
  if (op === "preset") {
    const parser = String(b?.parser ?? "").trim();
    if (!parser) return NextResponse.json({ error: "no_parser" }, { status: 400 });
    const r = await aparserParserPreset(creds, parser, String(b?.preset ?? "default"));
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    return NextResponse.json({ parser, preset: r.data });
  }

  // ── test: one query, raw ──────────────────────────────────────────────────
  if (op === "test") {
    const parser = String(b?.parser ?? "").trim();
    const query = String(b?.query ?? "").trim();
    if (!parser) return NextResponse.json({ error: "no_parser" }, { status: 400 });
    if (!query) return NextResponse.json({ error: "no_query" }, { status: 400 });
    const options: AparserOption[] = Array.isArray(b?.options)
      ? b.options.filter((o: any) => o && typeof o.id === "string").map((o: any) => ({
          type: o.type === "set" ? "set" : "override", id: String(o.id), value: o.value,
        }))
      : [];
    const r = await aparserOneRequest(creds, parser, query, options, { preset: String(b?.preset ?? "default") });
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data" }, { status: 502 });
    // `results` is returned and `resultString` is returned beside it, explicitly labelled, so the
    // screen can show what the preset's template produced WITHOUT anyone being tempted to parse
    // it. See the comment on `aparserOneRequest`.
    return NextResponse.json({
      results: r.data.results ?? [],
      resultStringPreview: String(r.data.resultString ?? "").slice(0, 2000),
      logs: r.data.logs ?? [],
    });
  }

  return NextResponse.json({ error: "unknown_op" }, { status: 400 });
}

function hostOf(url: string): string {
  const n = normaliseBaseUrl(url);
  return "url" in n ? new URL(n.url).host : "";
}
