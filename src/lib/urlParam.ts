// URL-addressable page state (tabs, wizard steps): read on mount, mirror back on change.
// history.replaceState keeps the history stack free of clicks and never triggers navigation
// work for what is only an address-bar update, so a refresh or a copied link reproduces the
// view the user left. window is guarded, so importing from a client component is safe under
// SSR too. Other params on the URL (period, shareToken, ...) ride along untouched.

export function readUrlParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function writeUrlParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const sp = new URLSearchParams(window.location.search);
  if (value === null) sp.delete(key);
  else sp.set(key, value);
  const qs = sp.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
}
