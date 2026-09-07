// A WHOIS client, port 43. Twenty lines of protocol and a lot of ways to hang.
//
// Kept apart from `availability.ts` so the socket work and the decision logic are separately
// reviewable, and so the parsing in `patterns.ts` stays reachable from tests that never open a
// socket.
//
// Derived in part from BigDesigner/project-backorder (MIT), rewritten from `cloudflare:sockets`
// onto `node:net`.

import net from "node:net";

const CONNECT_TIMEOUT_MS = 6000;
const READ_TIMEOUT_MS = 8000;
/** A WHOIS reply is a page of text. Anything past this is a misbehaving server, not an answer. */
const MAX_BYTES = 256 * 1024;

export class WhoisError extends Error {
  constructor(public readonly code: "timeout" | "connect" | "socket" | "too_large", message: string) {
    super(message);
    this.name = "WhoisError";
  }
}

/**
 * One query, one connection, one reply. WHOIS has no framing: the server answers and closes, so
 * "the response is complete" and "the socket ended" are the same event — which is exactly why a
 * read timeout is mandatory. A registry that accepts the connection and then says nothing would
 * otherwise hold the connection for as long as the process lives.
 */
export function whoisQuery(host: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let bytes = 0;
    let settled = false;

    const socket = net.createConnection({ host, port: 43 });
    socket.setEncoding("utf8");

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(readTimer);
      socket.destroy();
      fn();
    };

    const readTimer = setTimeout(
      () => finish(() => reject(new WhoisError("timeout", `whois ${host} read timeout`))),
      READ_TIMEOUT_MS,
    );
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      finish(() => reject(new WhoisError("timeout", `whois ${host} idle timeout`))),
    );

    socket.on("connect", () => {
      // CRLF, not LF. Several registry servers ignore a bare newline and then sit there, which
      // presents as a timeout on a server that is in fact fine.
      socket.write(`${query}\r\n`);
    });
    socket.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) {
        finish(() => reject(new WhoisError("too_large", `whois ${host} response over ${MAX_BYTES} bytes`)));
        return;
      }
      out += chunk;
    });
    socket.on("end", () => finish(() => resolve(out)));
    socket.on("close", () => finish(() => resolve(out)));
    socket.on("error", err =>
      finish(() => reject(new WhoisError("socket", `whois ${host}: ${err instanceof Error ? err.message : String(err)}`))),
    );
  });
}

const ianaCache = new Map<string, string>();

/**
 * The WHOIS server for a zone, asked of IANA and remembered.
 *
 * Cached for the life of the process because the answer changes on the timescale of a registry
 * transition, and asking IANA once per domain would make IANA the bottleneck for a sweep that
 * has nothing to do with it.
 */
export async function discoverWhoisHost(tld: string): Promise<string | null> {
  const key = tld.toLowerCase();
  const known = ianaCache.get(key);
  if (known) return known;
  try {
    const raw = await whoisQuery("whois.iana.org", key);
    const match = raw.match(/^whois:\s*([a-z0-9.-]+)\s*$/im);
    const host = match?.[1]?.trim();
    if (host) {
      ianaCache.set(key, host);
      return host;
    }
  } catch {
    // A zone IANA cannot place is a zone we do not guess at.
  }
  return null;
}
