import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { parseProxyList, redactProxy, type ProxyEndpoint } from "@/lib/drops/proxies";
import { proxyConnector } from "@/lib/drops/proxyTransport";
import {
  addProxies, deleteProxy, listProxies, proxyEndpoints, recordProxyCheck, schemaMissing, setProxyEnabled,
} from "@/lib/drops/store";

export const dynamic = "force-dynamic";

/**
 * The proxy pool behind the availability stage.
 *
 * Passwords enter through POST and never come back out: every response carries `redactProxy`
 * output, and the redaction lives in the store's `listProxies` rather than here, so a field
 * added later cannot leak one by being selected in the wrong place.
 */

/** How a live check decides a proxy works: a real tunnel to a real registry host. */
const PROBE_HOST = "rdap.verisign.com";
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 8000;

export async function GET() {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const proxies = await listProxies(userId);
    return NextResponse.json({
      proxies,
      // The one fact that changes what the stage can do: WHOIS rides only on SOCKS5.
      hasSocks: proxies.some(p => p.enabled && p.kind === "socks5"),
    });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ proxies: [], hasSocks: false, notMigrated: true });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = String(body?.action ?? "add");

    if (action === "add") {
      const raw = typeof body?.raw === "string" ? body.raw : "";
      const { proxies, skipped } = parseProxyList(raw);
      if (!proxies.length) {
        return NextResponse.json({ error: "no_proxies", skipped }, { status: 400 });
      }
      const { added, updated } = await addProxies(userId, proxies);
      return NextResponse.json({ added, updated, skipped, proxies: await listProxies(userId) });
    }

    if (action === "toggle") {
      const id = typeof body?.id === "string" ? body.id : "";
      const enabled = body?.enabled !== false;
      if (!id || !(await setProxyEnabled(userId, id, enabled))) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ proxies: await listProxies(userId) });
    }

    if (action === "check") {
      // A real CONNECT to a real registry host, not a ping: a proxy that accepts the TCP
      // connection and then refuses to tunnel is the common failure, and it looks perfectly
      // alive to anything cheaper than this.
      const endpoints = await proxyEndpoints(userId);
      const results = await Promise.all(endpoints.map(async (p: ProxyEndpoint) => {
        const started = Date.now();
        try {
          const socket = await proxyConnector(p).connect(PROBE_HOST, PROBE_PORT, PROBE_TIMEOUT_MS);
          socket.destroy();
          return { kind: p.kind, host: p.host, port: p.port, label: redactProxy(p), ok: true, ms: Date.now() - started };
        } catch (e) {
          return {
            kind: p.kind, host: p.host, port: p.port, label: redactProxy(p), ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }));
      await recordProxyCheck(userId, results);
      return NextResponse.json({
        checked: results.length,
        alive: results.filter(r => r.ok).length,
        results,
        proxies: await listProxies(userId),
      });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id || !(await deleteProxy(userId, id))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ proxies: await listProxies(userId) });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
