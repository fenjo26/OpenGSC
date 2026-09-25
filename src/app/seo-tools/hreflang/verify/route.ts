import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import {
  mergeHreflangEntries, parseHreflangHead, parseHreflangLinkHeader, normalizeHreflangUrl,
  type HreflangEntry,
} from "@/lib/audit/hreflang";
import { diffHreflangPage } from "@/lib/hreflang";

// POST /seo-tools/hreflang/verify — «Check on the site» (N1). For up to 50 pages: fetch the page
// (safeFetch — user-supplied URLs, same SSRF discipline as everywhere), read its CURRENT hreflang
// from the two places a response can carry it (<head> tags + the Link header), and diff against
// the set the generator says should be there. NET: it leaves the server, which the page's badge
// says; "act" because a button that fires 50 outbound requests is not a plain read.

const MAX_PAGES = 50;
const MAX_ENTRIES = 30;

interface PageInput { url: string; expected: HreflangEntry[] }

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { pages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const pages: PageInput[] = [];
  for (const raw of Array.isArray(body.pages) ? body.pages : []) {
    const p = raw as { url?: unknown; expected?: unknown };
    const url = String(p?.url ?? "").trim();
    const expected = Array.isArray(p?.expected)
      ? (p.expected as unknown[]).slice(0, MAX_ENTRIES).map(e => {
          const entry = e as { lang?: unknown; href?: unknown };
          return { lang: String(entry?.lang ?? ""), href: String(entry?.href ?? "") };
        }).filter(e => e.lang && e.href)
      : [];
    if (!url || !expected.length) continue;
    if (normalizeHreflangUrl(url) === "") return NextResponse.json({ error: "bad_url", url }, { status: 400 });
    pages.push({ url, expected });
    if (pages.length >= MAX_PAGES) break;
  }
  if (!pages.length) return NextResponse.json({ error: "no_pages" }, { status: 400 });

  const fetchOne = async (page: PageInput) => {
    try {
      const res = await safeFetch(page.url, { maxBytes: 2_000_000, timeoutMs: 20_000 });
      const html = await res.text();
      const linkHeader = res.headers.get("link") ?? "";
      const found = mergeHreflangEntries(parseHreflangHead(html), parseHreflangLinkHeader(linkHeader));
      const diff = diffHreflangPage(page.expected, found);
      return {
        url: page.url,
        httpStatus: res.status,
        reachable: true,
        ...diff,
        foundCount: found.length,
      };
    } catch (error) {
      return {
        url: page.url,
        httpStatus: 0,
        reachable: false, // unknown, not an error — offline is not a diff verdict
        matches: false,
        missing: page.expected,
        extra: [],
        error: error instanceof SafeFetchError ? error.code : "network_error",
        foundCount: 0,
      };
    }
  };

  // Bounded parallelism (the same 4-wide convention the generator's scrape pool uses).
  const results: unknown[] = [];
  for (let i = 0; i < pages.length; i += 4) {
    const batch = await Promise.all(pages.slice(i, i + 4).map(fetchOne));
    results.push(...batch);
  }
  return NextResponse.json({ results });
}
