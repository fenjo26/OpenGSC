// Which address a request came from, for rate limits.
//
// A Next.js route cannot see the TCP peer, only headers, and every one of those headers can be sent
// by the client itself unless something in front of the app overwrites it. Which header is honest
// depends on the deployment, not on the code:
//
//   Cloudflare Tunnel             → CF-Connecting-IP (cloudflared sets it; nothing else reaches the app)
//   nginx from install.sh         → X-Real-IP        (nginx writes $remote_addr over any client value)
//   another proxy that appends    → X-Forwarded-For  (the LAST hop is the one your proxy added)
//   app port open to the internet → none of them     (every header is forgeable)
//
// OPENGSC_CLIENT_IP_HEADER names the one to trust: cf-connecting-ip | x-real-ip | x-forwarded-for |
// none. With it set, no other header is consulted — that is the whole point: a header the proxy
// never touches is a header the client controls. Unset keeps the old order (CF-Connecting-IP, then
// X-Real-IP, then the first X-Forwarded-For hop) so existing instances behave as before; install.sh
// writes the variable for new ones.
//
// The value is read per call, never cached, so tests and a changed .env behave predictably.

export type HeaderSource =
  | { get?(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | undefined
  | null;

export const CLIENT_IP_HEADER_ENV = "OPENGSC_CLIENT_IP_HEADER";

const TRUSTABLE = new Set(["cf-connecting-ip", "x-real-ip", "x-forwarded-for", "none"]);

/** The configured trusted header, "none", or null when unset/unrecognised (legacy order). */
export function trustedIpHeader(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env[CLIENT_IP_HEADER_ENV] ?? "").trim().toLowerCase();
  return TRUSTABLE.has(raw) ? raw : null;
}

export function clientIpFromHeaders(headers: HeaderSource, env: Record<string, string | undefined> = process.env): string {
  const trusted = trustedIpHeader(env);
  if (trusted === "none") return "unknown";
  if (trusted === "x-forwarded-for") return lastHop(readHeader(headers, "x-forwarded-for")) || "unknown";
  if (trusted) return firstHop(readHeader(headers, trusted)) || "unknown";

  const cf = firstHop(readHeader(headers, "cf-connecting-ip"));
  if (cf) return cf;
  const real = firstHop(readHeader(headers, "x-real-ip"));
  if (real) return real;
  const forwarded = firstHop(readHeader(headers, "x-forwarded-for"));
  if (forwarded) return forwarded;
  return "unknown";
}

function readHeader(headers: HeaderSource, name: string): string {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== want || value == null) continue;
    return Array.isArray(value) ? value.map(String).join(",") : String(value);
  }
  return "";
}

function clean(hop: string | undefined): string {
  const v = (hop ?? "").trim().slice(0, 128);
  if (!v || /[\s\u0000]/.test(v)) return "";
  return v;
}

function firstHop(value: string): string {
  return clean(value.split(",")[0]);
}

function lastHop(value: string): string {
  const hops = value.split(",");
  return clean(hops[hops.length - 1]);
}
