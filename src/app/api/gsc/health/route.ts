import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { assertSafeTarget } from "@/lib/security/safeFetch";
import * as tls from "tls";

// ─── SSL check ────────────────────────────────────────────────────────────────
async function checkSSL(hostname: string): Promise<{
  valid: boolean; daysLeft: number; issuer: string; subject: string;
  protocol: string; grade: string; error?: string;
}> {
  let address: { address: string; family: 4 | 6 };
  try {
    const target = await assertSafeTarget(`https://${hostname}`);
    address = target.addresses[0];
  } catch (error: any) {
    return { valid: false, daysLeft: 0, issuer: "", subject: hostname, protocol: "", grade: "F", error: error?.code || "unsafe_target" };
  }

  return new Promise(resolve => {
    let settled = false;
    let socket: tls.TLSSocket | null = null;
    const finish = (result: { valid: boolean; daysLeft: number; issuer: string; subject: string; protocol: string; grade: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish({ valid: false, daysLeft: 0, issuer: "", subject: hostname, protocol: "", grade: "F", error: "Timeout" });
    }, 8000);

    try {
      const connectedSocket = tls.connect(443, address.address, { servername: hostname, rejectUnauthorized: false }, () => {
        const cert = connectedSocket.getPeerCertificate(true);

        if (!cert || !cert.valid_to) {
          return finish({ valid: false, daysLeft: 0, issuer: "", subject: hostname, protocol: "", grade: "F", error: "No certificate" });
        }

        const expiry   = new Date(cert.valid_to);
        const now      = new Date();
        const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const valid    = daysLeft > 0;
        const rawIssuerO  = cert.issuer?.O;
        const rawIssuerCN = cert.issuer?.CN;
        const rawSubjectCN = cert.subject?.CN;
        const issuer   = (Array.isArray(rawIssuerO)  ? rawIssuerO[0]  : rawIssuerO)
                      ?? (Array.isArray(rawIssuerCN) ? rawIssuerCN[0] : rawIssuerCN)
                      ?? "Unknown";
        const subject  = (Array.isArray(rawSubjectCN) ? rawSubjectCN[0] : rawSubjectCN) ?? hostname;
        const protocol = connectedSocket.getProtocol() ?? "TLS";

        // Simple grade: A+ = valid + 60+ days, A = valid + 14+ days, B = valid, F = expired
        const grade = !valid ? "F" : daysLeft >= 60 ? "A+" : daysLeft >= 14 ? "A" : "B";

        finish({ valid, daysLeft, issuer, subject, protocol, grade });
      });
      socket = connectedSocket;

      connectedSocket.on("error", (err) => {
        finish({ valid: false, daysLeft: 0, issuer: "", subject: hostname, protocol: "", grade: "F", error: err.message });
      });
    } catch (err: any) {
      finish({ valid: false, daysLeft: 0, issuer: "", subject: hostname, protocol: "", grade: "F", error: err.message });
    }
  });
}

// ─── Safe Browsing check ──────────────────────────────────────────────────────
async function checkSafeBrowsing(domain: string, apiKey: string): Promise<{
  safe: boolean; threats: string[]; error?: string;
}> {
  if (!apiKey) return { safe: true, threats: [], error: "no_key" };
  try {
    const body = {
      client: { clientId: "opengsc", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: [{ url: `https://${domain}` }],
      },
    };
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    if (data.error) return { safe: true, threats: [], error: data.error.message };
    const threats = (data.matches ?? []).map((m: any) => m.threatType as string);
    return { safe: threats.length === 0, threats };
  } catch (err: any) {
    return { safe: true, threats: [], error: err.message };
  }
}

// ─── Core Web Vitals (PageSpeed Insights API) ─────────────────────────────────
async function checkVitals(domain: string, apiKey: string): Promise<{
  lcp: number | null; inp: number | null; cls: number | null; ttfb: number | null;
  score: number | null; category: string; error?: string;
}> {
  // INP replaced FID as a Core Web Vital in March 2024. Lighthouse exposed the old metric as the
  // "max-potential-fid" audit; the replacement is "interaction-to-next-paint". Pulling the old
  // audit name returns a deprecated number that no longer matches what Google ranks on, so a page
  // could look healthy here while failing the CWV assessment in Search Console.
  const empty = { lcp: null, inp: null, cls: null, ttfb: null, score: null, category: "unknown" };
  if (!apiKey) return { ...empty, error: "no_key" };
  try {
    const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${domain}&strategy=mobile&key=${apiKey}&category=PERFORMANCE`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const data = await res.json();
    if (data.error) return { ...empty, error: data.error.message };

    const lhr  = data.lighthouseResult;
    const score = lhr?.categories?.performance?.score != null
      ? Math.round(lhr.categories.performance.score * 100)
      : null;

    const audits = lhr?.audits ?? {};
    const lcp   = audits["largest-contentful-paint"]?.numericValue ?? null;
    const inp   = audits["interaction-to-next-paint"]?.numericValue ?? null;
    const cls   = audits["cumulative-layout-shift"]?.numericValue ?? null;
    const ttfb  = audits["server-response-time"]?.numericValue ?? null;

    const category = score == null ? "unknown" : score >= 90 ? "good" : score >= 50 ? "needs_improvement" : "poor";
    return { lcp: lcp ? Math.round(lcp) : null, inp: inp ? Math.round(inp) : null, cls: cls ? parseFloat(cls.toFixed(3)) : null, ttfb: ttfb ? Math.round(ttfb) : null, score, category };
  } catch (err: any) {
    return { ...empty, error: err.message };
  }
}

// ─── VirusTotal check ─────────────────────────────────────────────────────────
async function checkVirusTotal(domain: string, apiKey: string): Promise<{
  clean: boolean; malicious: number; suspicious: number; undetected: number; total: number; error?: string;
}> {
  const empty = { clean: true, malicious: 0, suspicious: 0, undetected: 0, total: 0 };
  if (!apiKey) return { ...empty, error: "no_key" };
  try {
    const res = await fetch(`https://www.virustotal.com/api/v3/domains/${domain}`, {
      headers: { "x-apikey": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { ...empty, error: "not_found" };
    if (!res.ok) return { ...empty, error: `HTTP ${res.status}` };
    const data = await res.json();
    const stats = data?.data?.attributes?.last_analysis_stats ?? {};
    const malicious   = stats.malicious ?? 0;
    const suspicious  = stats.suspicious ?? 0;
    const undetected  = stats.undetected ?? 0;
    const harmless    = stats.harmless ?? 0;
    const total       = malicious + suspicious + undetected + harmless;
    return { clean: malicious === 0 && suspicious === 0, malicious, suspicious, undetected, total };
  } catch (err: any) {
    return { ...empty, error: err.message };
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const userId = await workspaceUserId();
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId");
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });

  // Session OR a valid share token for this exact site (read-only guest dashboards).
  if (!userId) {
    const shareToken = searchParams.get("shareToken") ?? "";
    const shared = shareToken
      ? await prisma.site.findFirst({ where: { id: siteId, shareToken, shareEnabled: true } })
      : null;
    if (!shared) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const site = userId
    ? await (prisma as any).site.findFirst({ where: { id: siteId, userId }, include: { siteHealth: true } })
    : await (prisma as any).site.findUnique({ where: { id: siteId }, include: { siteHealth: true } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Return cached result if less than 24 h old
  const cached = site.siteHealth;
  if (cached) {
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    if (age < 24 * 60 * 60 * 1000) {
      return NextResponse.json({
        cached: true,
        checkedAt: cached.checkedAt,
        ssl:          cached.sslData      ? JSON.parse(cached.sslData)      : null,
        safeBrowsing: cached.safeBrowsing ? JSON.parse(cached.safeBrowsing) : null,
        vitals:       cached.vitals       ? JSON.parse(cached.vitals)       : null,
        virusTotal:   cached.virusTotal   ? JSON.parse(cached.virusTotal)   : null,
      });
    }
  }

  return NextResponse.json({ cached: false, checkedAt: null, ssl: null, safeBrowsing: null, vitals: null, virusTotal: null });
}

export async function POST(req: NextRequest) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { siteId, safeBrowsingKey = "", googleApiKey = "", virusTotalKey = "" } = body;
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });

  const site = await (prisma as any).site.findFirst({ where: { id: siteId, userId } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Extract clean hostname
  const rawSiteId = String(site.siteId || site.url || "");
  let hostname = rawSiteId.replace(/^sc-domain:/, "");
  try { hostname = new URL(rawSiteId).hostname; } catch { hostname = hostname.split("/")[0]; }

  // Run all checks in parallel
  const [ssl, safeBrowsing, vitals, virusTotal] = await Promise.all([
    checkSSL(hostname),
    checkSafeBrowsing(hostname, safeBrowsingKey),
    checkVitals(hostname, googleApiKey),
    checkVirusTotal(hostname, virusTotalKey),
  ]);

  // Upsert to DB
  await (prisma as any).siteHealth.upsert({
    where:  { siteId },
    update: {
      checkedAt:    new Date(),
      sslData:      JSON.stringify(ssl),
      safeBrowsing: JSON.stringify(safeBrowsing),
      vitals:       JSON.stringify(vitals),
      virusTotal:   JSON.stringify(virusTotal),
    },
    create: {
      siteId,
      sslData:      JSON.stringify(ssl),
      safeBrowsing: JSON.stringify(safeBrowsing),
      vitals:       JSON.stringify(vitals),
      virusTotal:   JSON.stringify(virusTotal),
    },
  });

  return NextResponse.json({
    cached: false,
    checkedAt: new Date().toISOString(),
    ssl, safeBrowsing, vitals, virusTotal,
  });
}
