import { NextResponse } from "next/server";
import { runPublicCheck, normalizePublicTarget } from "@/lib/publicChecker/audit";
import { anonymizedClientKey, publicCacheKey, takePublicCheckRate, withPublicCheckCache } from "@/lib/publicChecker/guard";

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")?.trim()
    || req.headers.get("x-real-ip")?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, ...(ip !== "unknown" ? { remoteip: ip } : {}) });
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body, signal: AbortSignal.timeout(8_000), cache: "no-store",
    });
    const data = await res.json();
    return data?.success === true;
  } catch { return false; }
}

async function readLimitedJson(req: Request, maxBytes = 8_192): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("request_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad_json");
    return parsed;
  } catch { throw new Error("bad_json"); }
}

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return NextResponse.json({ error: "request_too_large" }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }
  const ip = clientIp(req);
  const rate = takePublicCheckRate(anonymizedClientKey(ip));
  if (!rate.ok) return NextResponse.json({ error: "rate_limited", retryAfter: rate.retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds), "Cache-Control": "no-store" } });
  let body: Record<string, unknown>;
  try { body = await readLimitedJson(req); }
  catch (error) {
    const code = error instanceof Error ? error.message : "bad_json";
    return NextResponse.json({ error: code }, { status: code === "request_too_large" ? 413 : 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!(await verifyTurnstile(String(body.turnstileToken ?? ""), ip))) {
    return NextResponse.json({ error: "turnstile_required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const target = normalizePublicTarget(String(body.url ?? ""));
    const cacheKey = publicCacheKey(target.hostname + (target.port ? `:${target.port}` : ""));
    const checked = await withPublicCheckCache(cacheKey, () => runPublicCheck(target.href));
    return NextResponse.json({ ...checked.value, cached: checked.cached, rateRemaining: rate.remaining }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "check_failed";
    const status = ["invalid_url", "unsupported_protocol", "credentials_not_allowed", "private_address"].includes(code) ? 400 : 502;
    return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
