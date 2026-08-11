// Background, resumable rewriting of many pages — the job form of rewrite.ts.
//
// Why this exists. `rewriteContent()` takes minutes for one page: a scrape, then an LLM
// call producing up to 8000 tokens, then a scoped repair pass when the value audit fails,
// then optionally a snippet pass. The per-call ceiling in lib/llm.ts is 280 seconds.
// MCP clients cut a tool call off at 30–60, and the browser has its own limits.
//
// The failure that follows is worse than a timeout, and it is the reason this file exists
// rather than a bigger timeout somewhere. When the caller gives up, the server does not:
// the model call completes, the money is spent, and the result is returned to a caller
// that is no longer listening — so it is written nowhere. Every abandoned attempt is a
// paid rewrite thrown away. Retrying makes it worse, because the retry pays again.
//
// So the result is persisted before anyone asks for it. Each page is written into the job
// row the moment it finishes, which means a client timeout, a closed tab, a PM2 restart
// or a crash costs at most the single page that was in flight — everything already paid
// for stays retrievable. The incremental write also keeps `updatedAt` moving, so the
// 20-minute staleness sweep in /api/seo/jobs cannot mistake a long batch for a dead one.

import { prisma } from "@/lib/prisma";
import { rewriteContent, type RewriteBody } from "./rewrite";
import { driftSeverity } from "./factDrift";

const jobs = () => (prisma as any).seoJob;

export interface RewriteBatchItem {
  /** Page to fetch and rewrite. Mutually exclusive with `text`. */
  url?: string;
  /** Literal text to rewrite, when the caller already has the content. */
  text?: string;
  /** Optional label for the progress report; defaults to the url. */
  label?: string;
}

export interface RewritePageResult {
  url: string;
  status: "completed" | "error";
  error?: string;
  uniquenessPercent?: number;
  words?: number;
  factDrift?: {
    severity: "clean" | "warn" | "danger";
    numbersAdded: string[];
    numbersLost: string[];
    identifiersAdded: string[];
    identifiersLost: string[];
  };
  structureOk?: boolean | null;
  repaired?: boolean;
  snippet?: unknown;
  content?: string;
  finishedAt: string;
}

export interface RewriteBatchState {
  total: number;
  completed: number;
  failed: number;
  startedAt: string;
  pages: RewritePageResult[];
  /** The page currently being worked on, so a poll mid-run is informative. */
  inProgress: string | null;
}

/** Human-readable reasons, so a poller does not have to decode rewrite.ts's error codes. */
const explain = (code: string): string => {
  if (code === "no_ai_key") return "No AI key configured for the selected provider.";
  if (code === "no_content") return "Nothing to rewrite — the page yielded no article body, or the text was empty.";
  if (code === "boilerplate_only") return "The fetch returned navigation and chrome, not an article. The URL may be a listing page, or it may need JavaScript to render.";
  return code;
};

/**
 * Run the batch, persisting after every page. Never throws: a failure on one page is
 * recorded against that page and the run continues, because stopping the batch would
 * discard the pages after it for a reason that may be specific to one URL.
 *
 * Not awaited by its caller — it is started fire-and-forget, exactly like `runJob` in
 * /api/seo/jobs, and reports its own terminal state.
 */
export async function runRewriteBatch(
  jobId: string,
  items: RewriteBatchItem[],
  opts: Omit<RewriteBody, "text" | "url">,
): Promise<void> {
  const state: RewriteBatchState = {
    total: items.length,
    completed: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    pages: [],
    inProgress: null,
  };

  const persist = async (status?: "completed" | "error", error?: string) => {
    try {
      const finished = state.completed + state.failed;
      const progress = state.total > 0 ? Math.round((finished / state.total) * 100) : 100;
      await jobs().update({
        where: { id: jobId },
        data: {
          result: JSON.stringify(state),
          heartbeatAt: new Date(),
          stage: status === "completed" ? "completed" : status === "error" ? "error" : "rewrite",
          progress: status ? 100 : progress,
          checkpoint: JSON.stringify({
            completed: state.completed,
            failed: state.failed,
            lastFinished: state.pages.at(-1)?.url ?? null,
          }),
          ...(status ? { status } : {}),
          ...(error ? { error } : {}),
        },
      });
    } catch {
      // The row is gone (user deleted the job) or the table is unmigrated. Either way the
      // batch has nowhere to report, so there is nothing useful to do but keep going —
      // throwing here would lose the pages still to come as well.
    }
  };

  for (const item of items) {
    const label = item.label || item.url || "(pasted text)";
    state.inProgress = label;
    await persist();

    try {
      const r = await rewriteContent({ ...opts, url: item.url, text: item.text });
      if (!r.ok || !r.data) {
        state.failed++;
        state.pages.push({ url: label, status: "error", error: explain(String(r.error ?? "unknown")), finishedAt: new Date().toISOString() });
      } else {
        // One variant per page in batch mode — the caller asked for many pages, not many
        // drafts of one page, and each extra variant is another paid call.
        const v = r.data.variants[0];
        state.completed++;
        state.pages.push({
          url: label,
          status: "completed",
          uniquenessPercent: v.uniqueness,
          words: v.words,
          factDrift: {
            severity: driftSeverity(v.drift),
            numbersAdded: v.drift.numbers.added,
            numbersLost: v.drift.numbers.lost,
            identifiersAdded: v.drift.identifiers.added,
            identifiersLost: v.drift.identifiers.lost,
          },
          structureOk: v.structure?.ok ?? null,
          repaired: v.repaired ?? false,
          snippet: r.data.snippet ?? null,
          content: v.content,
          finishedAt: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      state.failed++;
      state.pages.push({ url: label, status: "error", error: String(e?.message ?? e), finishedAt: new Date().toISOString() });
    }

    state.inProgress = null;
    await persist();
  }

  // A batch where nothing succeeded is an error the poller should see as one. A batch with
  // some successes is "completed" even so — the successful pages were paid for and must
  // stay reachable, and `failed` reports the rest.
  const allFailed = state.completed === 0 && state.total > 0;
  await persist(
    allFailed ? "error" : "completed",
    allFailed ? (state.pages[0]?.error ?? "every page failed") : undefined,
  );
}
