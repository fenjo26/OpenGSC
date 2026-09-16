// Which A-Parser passwords the server may try, and in what order. Pure — no imports — so the
// ordering rule is unit-tested without a database or an instance.
//
// There are two places a password can live on the server: the deployment env var
// (OPENGSC_APARSER_PASSWORD) and the owner's settings mirror (User.seoSettings.seoKey_aparser,
// written by a green "Check connection" in Settings). They drift apart the moment someone rotates
// the password in A-Parser and re-tests it in Settings but forgets the .env file. /api/aparser
// already survived that by probing both; server-side consumers (SERP Monitor, Rank Tracker) used
// to take the env value blindly and failed every request with "Auth failed" while Settings and
// the console showed a healthy connection. This list is what both now probe, in the same order.

export type AparserCredSource = "env" | "settings";

export interface AparserPasswordCandidate {
  source: AparserCredSource;
  password: string;
}

/** env first (the deployment's declared intent), then settings; blanks dropped, duplicates collapsed. */
export function aparserPasswordCandidates(envPassword: string, settingsPassword: string): AparserPasswordCandidate[] {
  const out: AparserPasswordCandidate[] = [];
  const env = String(envPassword ?? "").trim();
  const settings = String(settingsPassword ?? "").trim();
  if (env) out.push({ source: "env", password: env });
  if (settings && settings !== env) out.push({ source: "settings", password: settings });
  return out;
}
