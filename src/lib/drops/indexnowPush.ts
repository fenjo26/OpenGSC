// IndexNow push of one activation asset's legacy URLs — the server-side half of what
// the generic /api/indexing/indexnow route does per request, done here in chunks and
// recorded once per run. Testable without a network or a database: the fetch and the
// store call are seams.
//
// Honest scope: IndexNow reaches Bing and Yandex (plus minor engines such as Seznam
// and Naver). Google does NOT read it and never has — a push here is never a
// "submitted to Google" step, and nothing this module returns may imply it. What
// Google actually does with the asset is measured by the crawl-log route (T6).
//
// Contract: docs/tasks/drops-activation/CONTRACT.md; task docs/tasks/drops-activation/T3-indexnow.md.

import { INDEXNOW_BATCH } from "./activation";
import { recordIndexnowPush } from "./activationStore";

/// The shared endpoint: one POST is redistributed to every participating engine
/// (Bing, Yandex, …). Google is not among them.
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export type IndexnowFetch = typeof fetch;
export type IndexnowRecord = typeof recordIndexnowPush;

export interface IndexnowPushResult {
  /** URLs in chunks IndexNow accepted (200/202) — exactly what gets recorded. */
  pushed: number;
  /** Chunks attempted: INDEXNOW_BATCH URLs each, the last one the remainder. */
  chunks: number;
  /** "ok" when every chunk was accepted; "422" when any chunk was; else the HTTP code. */
  status: string;
  keyLocation: string;
  /** Present whenever status ≠ "ok". */
  hint?: string;
}

export async function pushIndexnow(
  userId: string,
  assetId: string,
  input: { domain: string; key: string; urls: string[] },
  opts?: { fetch?: IndexnowFetch; record?: IndexnowRecord },
): Promise<IndexnowPushResult> {
  const { domain, key, urls } = input;
  if (!urls.length) throw new Error("no_urls");

  const keyLocation = `https://${domain}/${key}.txt`;
  const doFetch = opts?.fetch ?? fetch;
  const record = opts?.record ?? recordIndexnowPush;

  let pushed = 0;
  let status = "ok";
  // Worst outcome wins, and 422 wins over any other failure: it is IndexNow's answer
  // to a key/keyLocation problem — the one rejection with a fix on our side of the wire.
  const worse = (next: string) => {
    if (status === "ok") status = next;
    else if (next === "422" && status !== "422") status = next;
  };

  for (let i = 0; i < urls.length; i += INDEXNOW_BATCH) {
    const urlList = urls.slice(i, i + INDEXNOW_BATCH);
    let res: Response;
    try {
      // Same request shape as the generic route: JSON body, one POST per batch.
      res = await doFetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: domain, key, keyLocation, urlList }),
      });
    } catch {
      // A chunk that never reached the endpoint has no HTTP code to report, but it
      // still has to surface: "ok" would claim URLs were accepted that were never sent.
      worse("network_error");
      continue;
    }
    if (res.status === 200 || res.status === 202) {
      pushed += urlList.length;
      continue;
    }
    // Drain the body of a rejected chunk, as the generic route does for its error
    // text; leaving the stream unread serves nothing.
    await res.text().catch(() => {});
    worse(String(res.status));
  }

  const chunks = Math.ceil(urls.length / INDEXNOW_BATCH);
  // Once per run, with what was actually accepted. Re-running re-records — that is
  // the whole idempotency story: IndexNow dedupes on its side, our side accumulates.
  await record(userId, assetId, { count: pushed, status });

  const out: IndexnowPushResult = { pushed, chunks, status, keyLocation };
  if (status !== "ok") {
    out.hint =
      `nginx must serve /${key}.txt BEFORE the catch-all 301 — after it the key file redirects away ` +
      "and IndexNow rejects the push silently (the NGINX_SNIPPET in the activation bundle pins this order). " +
      "IndexNow reaches Bing/Yandex and minor engines only; Google does not read it.";
  }
  return out;
}
