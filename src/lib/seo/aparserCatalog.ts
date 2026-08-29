// The slice of A-Parser's catalogue OpenGSC has a use for.
//
// Pure data, in its own file, so a client component can import it without dragging the transport
// (and its `process.env` reads) into the browser bundle — the same reason `lib/team/roles.ts` is
// separated from the resolver that uses it.

// ─── Parsers this app cares about ────────────────────────────────────────────

/**
 * The subset of the catalogue OpenGSC has a use for, so the /aparser screen can answer
 * "what can MY instance do for this app" instead of listing 138 names.
 *
 * `availableParsers` from `info` is the authority: 138 is what a stock build ships with, not a
 * guarantee, and a feature gated on hope fails at the worst moment. Anything here that is
 * missing from that list must be disabled in the UI, not merely unmentioned.
 */
export interface AparserCapability { parser: string; useKey: string; wired: boolean }

export const APARSER_CAPABILITIES: AparserCapability[] = [
  // SERP — wired once the provider branch lands in lib/seo/serp.ts.
  { parser: "SE::Google", useKey: "aparserCapGoogle", wired: false },
  { parser: "SE::Bing", useKey: "aparserCapBing", wired: false },
  { parser: "SE::Yandex", useKey: "aparserCapYandex", wired: false },
  // Rank Tracker — the purpose-built position parsers.
  { parser: "SE::Google::Position", useKey: "aparserCapGooglePos", wired: false },
  { parser: "SE::Bing::Position", useKey: "aparserCapBingPos", wired: false },
  { parser: "SE::Yandex::Position", useKey: "aparserCapYandexPos", wired: false },
  // Not wired yet, listed because knowing they are installed is what decides whether the
  // follow-ups in the spec are worth building for this user. WordStat is the one that closes a
  // gap rather than saving money: DataForSEO refuses RU/CIS location codes outright.
  { parser: "SE::Yandex::WordStat", useKey: "aparserCapWordstat", wired: false },
  { parser: "SE::Google::Suggest", useKey: "aparserCapSuggest", wired: false },
  { parser: "SE::Google::KeywordPlanner::SearchVolume", useKey: "aparserCapKeywordPlanner", wired: false },
  { parser: "Check::BackLink", useKey: "aparserCapBacklink", wired: false },
  { parser: "Rank::CMS", useKey: "aparserCapCms", wired: false },
];
