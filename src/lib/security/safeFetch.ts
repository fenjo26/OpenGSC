import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export type SafeFetchErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "credentials_not_allowed"
  | "private_address"
  | "dns_failed"
  | "request_timeout"
  | "response_too_large"
  | "too_many_redirects"
  | "network_error";

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  /**
   * Opt out of the private-address guard for this call. Defaults to the instance setting
   * (OPENGSC_ALLOW_PRIVATE_TARGETS). Anything reachable by an anonymous visitor must pass
   * `false` explicitly instead of inheriting the default.
   */
  allowPrivate?: boolean;
  headers?: HeadersInit;
  redirect?: "follow" | "manual";
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  readonly byteLength: number;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

/**
 * A self-hosted operator may legitimately need to audit a staging site on the same box or LAN
 * (http://localhost:3000, 192.168.x.x). That is exactly the shape of an SSRF target, so it stays
 * off unless the instance owner turns it on with OPENGSC_ALLOW_PRIVATE_TARGETS=1 in .env.
 * The flag is read per call, never cached, and public surfaces override it with allowPrivate:false.
 */
export function privateTargetsAllowed(): boolean {
  const value = (process.env.OPENGSC_ALLOW_PRIVATE_TARGETS || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  if (octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function inV4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Number(raw: string): bigint | null {
  let value = raw.toLowerCase().split("%")[0];
  const dottedTail = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const ipv4 = ipv4Number(dottedTail);
    if (ipv4 == null) return null;
    value = value.slice(0, -dottedTail.length) + `${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [left = "", right = ""] = value.split("::");
  const before = left ? left.split(":") : [];
  const after = right ? right.split(":") : [];
  const missing = 8 - before.length - after.length;
  if ((value.includes("::") && missing < 1) || (!value.includes("::") && missing !== 0)) return null;
  const parts = [...before, ...Array(missing).fill("0"), ...after];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((result, part) => (result << BigInt(16)) | BigInt(`0x${part}`), BigInt(0));
}

function inV6Range(value: bigint, base: bigint, prefix: number): boolean {
  return prefix === 0 || (value >> BigInt(128 - prefix)) === (base >> BigInt(128 - prefix));
}

/** True for non-public IPv4/IPv6 destinations that must never receive user-driven requests. */
export function isUnsafeAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().split("%")[0];
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isUnsafeAddress(mapped);

  if (isIP(address) === 4) {
    const value = ipv4Number(address)!;
    const ranges: Array<[string, number]> = [
      ["0.0.0.0", 8],       // unspecified / current network
      ["10.0.0.0", 8],      // private
      ["100.64.0.0", 10],    // carrier-grade NAT
      ["127.0.0.0", 8],     // loopback
      ["169.254.0.0", 16],  // link-local and cloud metadata
      ["172.16.0.0", 12],   // private
      ["192.0.0.0", 24],    // IETF protocol assignments
      ["192.0.2.0", 24],    // documentation
      ["192.168.0.0", 16],  // private
      ["198.18.0.0", 15],   // benchmark networks
      ["198.51.100.0", 24], // documentation
      ["203.0.113.0", 24],  // documentation
      ["224.0.0.0", 4],     // multicast
      ["240.0.0.0", 4],     // reserved / broadcast
    ];
    return ranges.some(([base, prefix]) => inV4Range(value, ipv4Number(base)!, prefix));
  }

  if (isIP(address) === 6) {
    const value = ipv6Number(address);
    if (value == null) return true;

    // IPv4-mapped and deprecated IPv4-compatible literals are normalized by URL to hexadecimal
    // (::ffff:7f00:1), so a dotted-decimal-only check would let loopback bypass the IPv4 rules.
    const high96 = value >> BigInt(32);
    if (high96 === BigInt(0xffff)) return isUnsafeAddress(`${Number((value >> BigInt(24)) & BigInt(255))}.${Number((value >> BigInt(16)) & BigInt(255))}.${Number((value >> BigInt(8)) & BigInt(255))}.${Number(value & BigInt(255))}`);
    if (high96 === BigInt(0)) return true;

    const ranges: Array<[string, number]> = [
      ["64:ff9b::", 96],   // NAT64 well-known prefix (can encode private IPv4)
      ["64:ff9b:1::", 48], // local-use NAT64 prefix
      ["100::", 64],       // discard-only
      ["2001::", 32],      // Teredo
      ["2001:2::", 48],    // benchmarking
      ["2001:10::", 28],   // ORCHID
      ["2001:20::", 28],   // ORCHIDv2
      ["2001:db8::", 32],  // documentation
      ["2002::", 16],      // 6to4 (can encode private IPv4)
      ["3fff::", 20],      // documentation
      ["fc00::", 7],       // unique-local
      ["fe80::", 10],      // link-local
      ["fec0::", 10],      // deprecated site-local
      ["ff00::", 8],       // multicast
    ];
    return ranges.some(([base, prefix]) => inV6Range(value, ipv6Number(base)!, prefix));
  }

  return true;
}

function parseTarget(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (cause) {
    throw new SafeFetchError("invalid_url", "The target is not a valid absolute URL.", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("unsupported_protocol", "Only http and https URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("credentials_not_allowed", "Credentials in target URLs are not allowed.");
  }
  return url;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export async function assertSafeTarget(
  input: string | URL,
  options: { allowPrivate?: boolean } = {},
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const allowPrivate = options.allowPrivate ?? privateTargetsAllowed();
  const url = parseTarget(input);
  const hostname = normalizedHostname(url);
  if (!hostname) throw new SafeFetchError("private_address", "Local and internal hostnames are not allowed.");
  if (!allowPrivate && (hostname === "localhost" || /\.(?:localhost|local|internal|home|lan)$/.test(hostname))) {
    throw new SafeFetchError("private_address", "Local and internal hostnames are not allowed.");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!allowPrivate && isUnsafeAddress(hostname)) {
      throw new SafeFetchError("private_address", "Private, local and reserved addresses are not allowed.");
    }
    return { url, addresses: [{ address: hostname, family: literalFamily as 4 | 6 }] };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new SafeFetchError("dns_failed", "The target hostname could not be resolved.", { cause });
  }
  if (!records.length) throw new SafeFetchError("dns_failed", "The target hostname has no addresses.");
  if (!allowPrivate && records.some(record => isUnsafeAddress(record.address))) {
    throw new SafeFetchError("private_address", "The target resolves to a private, local or reserved address.");
  }

  // Prefer IPv4 because many self-hosted nodes have an IPv6 resolver but no working IPv6 route.
  const addresses = records
    .map(record => ({ address: record.address, family: record.family as 4 | 6 }))
    .sort((a, b) => a.family - b.family)
    .filter((record, index, all) => all.findIndex(other => other.address === record.address) === index);
  return { url, addresses };
}

function responseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach(item => result.append(name, item));
    else if (value != null) result.set(name, value);
  }
  return result;
}

function decodeBody(body: Buffer, headers: Headers, maxBytes: number): Buffer {
  const encoding = (headers.get("content-encoding") || "").toLowerCase().trim();
  if (!encoding || encoding === "identity" || body.length === 0) return body;
  try {
    const options = { maxOutputLength: maxBytes };
    const decoded = encoding === "gzip" || encoding === "x-gzip"
      ? gunzipSync(body, options)
      : encoding === "deflate"
        ? inflateSync(body, options)
        : encoding === "br"
          ? brotliDecompressSync(body, options)
          : body;
    if (decoded.length > maxBytes) throw new SafeFetchError("response_too_large", "The decoded response exceeded the configured size limit.");
    if (decoded !== body) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    return decoded;
  } catch (cause) {
    if (cause instanceof SafeFetchError) throw cause;
    throw new SafeFetchError("network_error", "The compressed response could not be decoded.", { cause });
  }
}

function requestPinned(
  url: URL,
  address: ResolvedAddress,
  method: "GET" | "HEAD",
  headers: Headers,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const outgoingHeaders = Object.fromEntries(headers.entries());
    outgoingHeaders.host = url.host;

    const request = transport.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method,
      headers: outgoingHeaders,
      agent: false,
      ...(url.protocol === "https:" ? { servername: normalizedHostname(url), rejectUnauthorized: true } : {}),
    }, incoming => {
      const headers = responseHeaders(incoming.headers);
      const declaredLength = Number(headers.get("content-length") || "0");
      if (method !== "HEAD" && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        incoming.destroy();
        reject(new SafeFetchError("response_too_large", "The response exceeded the configured size limit."));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on("data", chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          incoming.destroy(new SafeFetchError("response_too_large", "The response exceeded the configured size limit."));
          return;
        }
        chunks.push(buffer);
      });
      incoming.on("end", () => {
        try {
          const body = decodeBody(Buffer.concat(chunks), headers, maxBytes);
          resolve({ status: incoming.statusCode || 0, statusText: incoming.statusMessage || "", headers, body });
        } catch (error) {
          reject(error);
        }
      });
      incoming.on("error", error => reject(error instanceof SafeFetchError ? error : new SafeFetchError("network_error", "The response stream failed.", { cause: error })));
    });

    request.setTimeout(timeoutMs, () => request.destroy(new SafeFetchError("request_timeout", "The request timed out.")));
    request.on("error", error => reject(error instanceof SafeFetchError ? error : new SafeFetchError("network_error", "The target could not be reached.", { cause: error })));
    request.end();
  });
}

function makeResponse(raw: RawResponse, url: URL, redirected: boolean): SafeFetchResponse {
  const body = raw.body;
  return {
    status: raw.status,
    statusText: raw.statusText,
    ok: raw.status >= 200 && raw.status < 300,
    headers: raw.headers,
    url: url.href,
    redirected,
    byteLength: body.length,
    async text() { return body.toString("utf8"); },
    async json<T = unknown>() { return JSON.parse(body.toString("utf8")) as T; },
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer; },
  };
}

/**
 * Fetch an untrusted http(s) URL without allowing SSRF into the host network.
 *
 * DNS is resolved and validated before the socket is opened, and the request is pinned to that
 * exact public address while preserving TLS SNI and the HTTP Host header. Redirect targets are
 * resolved and checked again. This intentionally supports only GET/HEAD; provider API POSTs use
 * their fixed, trusted endpoints and should keep their existing clients.
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const method = options.method || "GET";
  const redirect = options.redirect || "follow";
  const timeoutMs = Math.min(120_000, Math.max(250, options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.min(50 * 1024 * 1024, Math.max(1, options.maxBytes || DEFAULT_MAX_BYTES));
  const maxRedirects = Math.min(10, Math.max(0, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  // Resolved once so every hop of one request shares the same decision, even if the environment
  // variable changes mid-flight.
  const allowPrivate = options.allowPrivate ?? privateTargetsAllowed();
  const deadline = Date.now() + timeoutMs;
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  headers.delete("host");
  headers.delete("connection");
  headers.delete("transfer-encoding");

  let current = parseTarget(input);
  let redirects = 0;
  while (true) {
    const { url, addresses } = await assertSafeTarget(current, { allowPrivate });
    let raw: RawResponse | null = null;
    let lastError: unknown = null;

    // A hostname may return several CDN addresses. Try a small bounded set, while one deadline
    // covers the entire operation so a bad DNS answer cannot multiply the timeout indefinitely.
    for (const address of addresses.slice(0, 4)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeFetchError("request_timeout", "The request timed out.");
      try {
        raw = await requestPinned(url, address, method, headers, remaining, maxBytes);
        break;
      } catch (error) {
        if (error instanceof SafeFetchError && error.code === "response_too_large") throw error;
        lastError = error;
      }
    }
    if (!raw) {
      if (lastError instanceof SafeFetchError) throw lastError;
      throw new SafeFetchError("network_error", "The target could not be reached.", { cause: lastError });
    }

    const location = raw.headers.get("location");
    const isRedirect = raw.status >= 300 && raw.status < 400 && raw.status !== 304 && Boolean(location);
    if (redirect !== "follow" || !isRedirect) return makeResponse(raw, url, redirects > 0);
    if (redirects >= maxRedirects) throw new SafeFetchError("too_many_redirects", "The redirect limit was exceeded.");

    let next: URL;
    try {
      next = new URL(location!, url);
    } catch (cause) {
      throw new SafeFetchError("invalid_url", "The target returned an invalid redirect URL.", { cause });
    }
    if (next.origin !== url.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }
    current = next;
    redirects++;
  }
}
