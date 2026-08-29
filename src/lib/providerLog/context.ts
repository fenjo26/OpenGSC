// Whose provider call is this?
//
// The hard part of logging provider calls is not the table, it is that `lib/llm.ts` — where every
// AI request funnels — has no idea who it is calling for. The word `userId` does not appear in
// it. A log row that cannot say whose call it was is not worth writing.
//
// So the answer travels out of band. The alternative was threading a `ctx` parameter through
// `fetchLLM*`, `runSerp` and a couple of dozen more signatures plus every caller — around a
// hundred edits in code that has nothing to do with logging, each one a chance to break
// something, and half those callers have no userId either, so the threading would carry on
// several levels further up.
//
// Nothing here ever invents an owner. A call made outside any context is logged with a null
// user, which is a visible gap; falling back to "the instance owner" would make every
// unattributed call look like somebody's, which is worse than admitting we do not know.

import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  userId: string | null;
  feature: string | null;
  /**
   * Whether request and response bodies are stored for calls made in this context.
   *
   * Resolved once, here, where the settings snapshot is already being read — the logger itself
   * is synchronous and must not go asking. A long-running job therefore keeps the value it
   * started with, which is the right trade for a switch turned on deliberately to chase one
   * problem, and is said out loud in the settings copy rather than left to be discovered.
   */
  captureBodies: boolean;
}

const EMPTY: CallContext = { userId: null, feature: null, captureBodies: false };
const storage = new AsyncLocalStorage<CallContext>();

/** Wrap work in a context. Used where there is no request to hang one off: schedulers, jobs. */
export function withCallContext<T>(ctx: CallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Set the context for the remainder of the current execution.
 *
 * A route handler cannot wrap itself, so this is what lets `workspaceUserId()` establish the
 * context for the 122 API routes that already call it, from one line, without touching any of
 * them. It is also the riskier of the two calls — `enterWith` is the part of AsyncLocalStorage
 * that can bleed between executions if a runtime reuses one — which is why the test beside this
 * file exercises it directly rather than testing `run` and hoping.
 */
export function enterCallContext(ctx: CallContext): void {
  storage.enterWith(ctx);
}

/** Whose call this is — or nobody's, which is a fact and not a licence to guess. */
export function currentCallContext(): CallContext {
  return storage.getStore() ?? EMPTY;
}
