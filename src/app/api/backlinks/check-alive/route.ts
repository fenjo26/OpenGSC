import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import { safeFetch } from '@/lib/security/safeFetch';

// POST { siteDbId, ids?: string[] }  — checks if backlink pages return 2xx
// If ids is empty/omitted, checks ALL unchecked links (or all if forceAll=true)
//
// Two robustness passes vs. the original single-fetch version:
//
//   1. Retry on transient failures (429 / 408 / 5xx / network drops / timeouts). A link is only
//      recorded as dead once every attempt has failed the same way — a server that replied 503
//      for one second no longer produces a false "dead" that sends the user to fix a link that
//      was never broken. Same retryable rule as src/lib/llm.ts, deliberately duplicated here
//      because the LLM client and the link checker answer different questions and must not
//      share a call surface.
//
//   2. A third status, "blocked", for answers that don't tell us anything about the link.
//      Cloudflare and other WAFs return 403/429 to a crawler's User-Agent while serving the
//      page fine to a real browser. Recording those as "dead" (the old behaviour, since the old
//      check only knew alive/dead) is exactly the false positive this whole change exists to
//      remove. "blocked" is not a death — it is a refusal to answer — so it is kept separate
//      from both and shown amber in the UI.

const UA = 'Mozilla/5.0 (compatible; OpenGSC-BacklinkCheck/1.0)';
const ATTEMPTS = 3;
const BACKOFF_MS = [0, 1_200, 3_500]; // mirrors the LLM client's "shorter for cheap checks" intent

// Same predicate shape as retryableStatus() in llm.ts.
const retryable = (s: number) => s === 429 || s === 408 || s >= 500;
// A response that means "I won't let you look", not "this page is gone".
const blockedStatus = (s: number) => s === 401 || s === 403 || s === 429;

type Outcome = { alive: boolean; dead: boolean; blocked: boolean; title: string | null };

async function checkOnce(url: string): Promise<Outcome> {
  // HEAD first; some servers reject it with 405, which is not a verdict on the page — fall
  // through to GET below. We do NOT treat a 405 as blocked or dead: it just means "try GET".
  let status = 0;
  let headDenied = false;
  try {
    const res = await safeFetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      timeoutMs: 8_000,
      maxBytes: 1,
      headers: { 'User-Agent': UA },
    });
    status = res.status;
    if (status === 405) headDenied = true;
  } catch {
    // A network error on HEAD might be transient — let the GET attempt below have the final say.
    headDenied = true;
    status = 0;
  }

  // HEAD returned a clear answer without needing the body.
  if (!headDenied && status !== 0) {
    if (blockedStatus(status)) return { alive: false, dead: false, blocked: true, title: null };
    const ok = status >= 200 && status < 400;
    if (!ok && !retryable(status)) return { alive: false, dead: true, blocked: false, title: null };
  }

  // GET — needed either because HEAD was disallowed, or because the only verdict so far is a
  // retryable one and we re-fetch the body anyway to extract the title.
  const gr = await safeFetch(url, {
    timeoutMs: 8_000,
    // Generous on purpose: only the <title> is needed, but a page over the cap raises
    // response_too_large, and the caller records an unreachable link as "blocked". A heavy page
    // is not a blocked page.
    maxBytes: 8 * 1024 * 1024,
    redirect: 'follow',
    headers: { 'User-Agent': UA },
  });
  const gStatus = gr.status;
  if (blockedStatus(gStatus)) return { alive: false, dead: false, blocked: true, title: null };
  const ok = gStatus >= 200 && gStatus < 400;

  let title: string | null = null;
  if (ok) {
    try {
      const html = await gr.text();
      const m = html.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
      title = m ? m[1].trim() : null;
    } catch { /* title is best-effort */ }
  }
  return { alive: ok, dead: !ok, blocked: false, title };
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const ids: string[] = body.ids ?? [];
  const forceAll: boolean = body.forceAll ?? false;

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  // Pick which links to check
  const where: any = { siteId: siteDbId };
  if (ids.length > 0) {
    where.id = { in: ids };
  } else if (!forceAll) {
    where.isAlive = null; // only unchecked
  }

  const links = await prisma.backlink.findMany({ where, take: 200, select: { id: true, url: true } });
  if (links.length === 0) return NextResponse.json({ ok: true, checked: 0, alive: 0, dead: 0, blocked: 0 });

  let alive = 0, dead = 0, blocked = 0;

  await Promise.allSettled(
    links.map(async (link: any) => {
      let outcome: Outcome | null = null;
      // Retry only the transient class. A firm 404 / blocked stays — re-asking a page that
      // returned 404 three times wastes three requests to learn the same thing.
      for (let i = 0; i < ATTEMPTS; i++) {
        try {
          outcome = await checkOnce(link.url);
          // A settled verdict (alive / dead / blocked) is final. Only keep going when GET itself
          // threw — checkOnce rethrows nothing, so reaching here means we have a verdict.
          break;
        } catch {
          // Network drop / timeout / DNS — retryable. The final verdict when all attempts throw
          // is "blocked" (below), not "dead", because a link we couldn't reach isn't a dead link.
          if (i < ATTEMPTS - 1) await new Promise(r => setTimeout(r, BACKOFF_MS[i + 1] + Math.random() * 400));
        }
      }

      // Every attempt threw (network down, DNS, repeated timeout): that is not "dead" and not
      // "blocked" — it is "could not reach". We record it as blocked rather than dead, because a
      // link we could not reach is not a link that is gone, and a false "dead" is the failure
      // this change exists to prevent. The user can re-run later.
      if (!outcome) outcome = { alive: false, dead: false, blocked: true, title: null };

      // isAlive stays in sync for the old path, but maps blocked → null (unknown) so it never
      // reads as a death downstream: legacy code counting "dead = isAlive===false" stays honest.
      const isAliveSync = outcome.blocked ? null : outcome.alive;
      await prisma.backlink.update({
        where: { id: link.id },
        data: {
          isAlive: isAliveSync,
          aliveStatus: outcome.blocked ? 'blocked' : outcome.alive ? 'alive' : 'dead',
          aliveChecked: new Date(),
          ...(outcome.title ? { title: outcome.title } : {}),
        },
      });
      if (outcome.blocked) blocked++;
      else if (outcome.alive) alive++;
      else dead++;
    }),
  );

  // Log operation
  await prisma.indexingOperation.create({
    data: {
      siteId: siteDbId,
      type: 'backlink_check_alive',
      result: 'success',
      detail: `alive: ${alive}, dead: ${dead}, blocked: ${blocked}`,
      urlCount: links.length,
    },
  });

  return NextResponse.json({ ok: true, checked: links.length, alive, dead, blocked });
}
