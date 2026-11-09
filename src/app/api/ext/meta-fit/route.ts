import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { fitMeta, fitMetaLocal } from "@/lib/seo/metaFit";
import { pageInsights } from "@/lib/ext/insights";
import type { ExtMetaFitRequest, ExtMetaFitResponse } from "@/lib/ext/types";

// POST /api/ext/meta-fit — suggest title/description inside the audit band for the panel.
// Without allowLlm: pure string work, "act", llmCalls 0. With allowLlm: up to 2 repair calls
// on the instance owner's AI key → "spend" AND confirm: true (the estimate is the refusal
// body). Nothing is stored — the human copies the suggestion into the CMS.
//
// The keyword a fit must keep at the start of the title is the page's main GSC query; fitting
// without one is refused (no_main_query) rather than dropping the keyword silently.

export async function POST(req: Request) {
  let body: ExtMetaFitRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const allowLlm = body?.allowLlm === true;

  const auth = await extAuth(req, allowLlm ? "spend" : "act");
  if (!auth.ok) return auth.response;
  const cors = { headers: auth.auth.cors };

  if (allowLlm && body.confirm !== true) {
    return NextResponse.json(
      { error: "confirm_required", estimate: { maxCalls: 2, note: "your AI key" } },
      { status: 400, ...cors },
    );
  }

  if (!body || typeof body.url !== "string" || !String(body.title ?? "") || !String(body.description ?? "")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, ...cors });
  }

  // The main query of THIS page is the fit's keyword — resolved server-side, never trusted
  // from the client (the extension could not know the clicks ranking).
  let keyword = "";
  try {
    const insights = await pageInsights(auth.auth.userId, {
      url: String(body.url).slice(0, 2000),
      title: String(body.title ?? "").slice(0, 500),
      description: String(body.description ?? "").slice(0, 500),
      h1: "",
    });
    keyword = insights.mainQuery?.query ?? "";
  } catch {
    return NextResponse.json({ notMigrated: true }, { status: 200, ...cors });
  }
  if (!keyword) {
    return NextResponse.json({ error: "no_main_query" }, { status: 400, ...cors });
  }

  const language = String(body.language || "en").slice(0, 8) || "en";

  if (!allowLlm) {
    const out: ExtMetaFitResponse = {
      title: fitMetaLocal("title", String(body.title), [], keyword),
      description: fitMetaLocal("description", String(body.description), [], keyword),
      llmCalls: 0,
    };
    return NextResponse.json(out, cors);
  }

  // Provider credentials resolve the same way the server-side meta-fit route does for
  // server callers: the stored per-task mirror (the extension sends no keys).
  const creds = await resolveAiCreds(auth.auth.userId, {}, "text").catch(() => null);
  if (!creds?.aiApiKey) {
    return NextResponse.json({ error: "no_ai_key" }, { status: 400, ...cors });
  }
  const llm = {
    allow: true,
    provider: creds.aiProvider,
    apiKey: creds.aiApiKey,
    model: creds.model,
    baseUrl: creds.aiBaseUrl,
  };

  const captureBodies = await resolveCaptureBodies(auth.auth.userId);
  const results = await withCallContext({ userId: auth.auth.userId, feature: "meta-fit", captureBodies }, async () =>
    fitMeta({ keyword, language, title: String(body.title), description: String(body.description) }, llm).catch(() => ({
      llmCalls: 0,
    })),
  );

  return NextResponse.json(results as ExtMetaFitResponse, cors);
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
