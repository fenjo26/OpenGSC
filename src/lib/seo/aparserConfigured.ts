"use client";

/**
 * "Is A-Parser wired up?", answered for the browser.
 *
 * Two screens ask this — the nav item in DashboardShell and the /aparser page itself — and until
 * now both answered it from `localStorage` alone. That is only ever true for the browser the
 * settings were typed into. An instance configured through `OPENGSC_APARSER_BASE_URL` and
 * `OPENGSC_APARSER_PASSWORD` (the deployment the module's own documentation recommends), or one
 * configured from a different machine, had a working A-Parser with no way into it.
 *
 * The local answer is still checked first and used synchronously, so the common case renders
 * with no request and no flash of a missing menu item. The server is only asked when the local
 * answer is "no", and the reply is cached for the page's lifetime so the nav and the page do not
 * ask twice.
 */

const KEY_BASE = "seoBaseUrl_aparser";
const KEY_PASSWORD = "seoKey_aparser";

let serverAnswer: boolean | null = null;
let inflight: Promise<boolean> | null = null;

/** The synchronous half: what this browser knows on its own. Never throws. */
export function aparserConfiguredLocally(): boolean {
  try {
    return !!localStorage.getItem(KEY_BASE) && !!localStorage.getItem(KEY_PASSWORD);
  } catch {
    // Private mode, or storage blocked. Not knowing is not the same as "not configured" — the
    // server is asked next, which is the whole point of this module.
    return false;
  }
}

/**
 * The full answer. Resolves `true` as soon as either source says so.
 *
 * A failed request resolves `false` rather than rejecting: the caller is deciding whether to
 * show a menu entry, and a network blip must not surface as an error to the user.
 */
export async function isAparserConfigured(): Promise<boolean> {
  if (aparserConfiguredLocally()) return true;
  if (serverAnswer !== null) return serverAnswer;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch("/api/aparser", { cache: "no-store" });
      if (!res.ok) return false;
      const body = await res.json();
      return !!body?.configured;
    } catch {
      return false;
    } finally {
      inflight = null;
    }
  })().then(value => {
    serverAnswer = value;
    return value;
  });

  return inflight;
}

/**
 * Drop the cached server answer.
 *
 * Called when the settings are saved or restored, so turning A-Parser on does not require a
 * reload before the menu entry appears.
 */
export function resetAparserConfiguredCache(): void {
  serverAnswer = null;
  inflight = null;
}
