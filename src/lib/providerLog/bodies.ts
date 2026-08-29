// Whether this call's prompt and completion are kept.
//
// The answer is a per-user setting, and the setting lives in an asynchronous snapshot
// (`User.seoSettings`, the mirror SeoKeysSync backs up out of the browser). The logger, meanwhile,
// is synchronous and sits inside every provider call in the app — it cannot go and ask. So the
// question is asked once, where a `CallContext` is built, and the answer travels on the context.
//
// Three consequences, all deliberate:
//
//   - **A long job keeps the value it started with.** A forty-minute generation resolves this at
//     the start and does not notice the switch being turned off halfway. That is the right trade
//     for a flag switched on deliberately to chase one problem, and the settings copy says so
//     rather than leaving it to be discovered by someone wondering why bodies kept appearing.
//   - **A run with no user captures nothing.** `sync-cron` is one instance-wide run serving every
//     due user; it has no owner whose setting could govern it, and reading one of the due users'
//     settings would be inventing consent on everybody else's behalf. Null user, no capture —
//     unless the operator has said otherwise instance-wide, below.
//   - **A read that fails captures nothing.** Storing payloads is the side an error must never
//     fall on.
//
// The raw-SQL read is the same one `rank.ts`, `digest.ts`, `aeoTracker.ts` and `mcp/shared.ts`'s
// `getUserSettings` all make, for the reason they all state: the column may not exist on an
// instance that has not run `prisma db push`, and the answer to that is "not configured", not a
// 500 in the middle of a provider call.

import { rawQuery } from "@/lib/db/raw";

/**
 * The settings key, in the browser and in the mirrored snapshot alike.
 *
 * Exported because three places have to agree on it — the toggle that writes it, SeoKeysSync's
 * mirror list that carries it to the server, and this reader — and a fourth spelling of a string
 * literal is how a setting comes to be written but never read.
 */
export const BODY_CAPTURE_SETTING = "seoProviderLogBodies";

/** The instance-wide override, for a deployment with no browser to click the toggle in. */
export const BODY_CAPTURE_ENV = "OPENGSC_LOG_BODIES";

/**
 * What the operator decided for the whole instance, if anything.
 *
 * Both directions are honoured. "On" is what makes capture reachable at all on a headless
 * deployment — including for the userless runs, where an explicit operator decision is the only
 * consent there could be. "Off" is what lets an operator hold a shared instance shut, so a
 * decision that this deployment never stores prompts cannot be undone from a settings screen.
 * Anything else — unset, or a value that means neither — leaves the question to the user.
 */
export function bodyCaptureOverride(): boolean | null {
  const raw = String(process.env[BODY_CAPTURE_ENV] ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

function enabledIn(settings: Record<string, unknown>): boolean {
  const v = settings[BODY_CAPTURE_SETTING];
  return v === true || v === "1" || v === "true";
}

/**
 * Resolve the switch for one context. Call this where the context is created — never from the
 * logger, which has no `await` to spend on it and no business knowing where settings live.
 */
export async function resolveCaptureBodies(userId: string | null | undefined): Promise<boolean> {
  const override = bodyCaptureOverride();
  if (override !== null) return override;
  if (!userId) return false;
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.seoSettings;
    return raw ? enabledIn(JSON.parse(raw)) : false;
  } catch {
    return false; // not migrated, or the database is unhappy. Either way: capture nothing.
  }
}
