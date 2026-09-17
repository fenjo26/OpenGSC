// Rank Tracker carriers, shared by the settings card (Settings → SEO Tools) and the quick
// switch on the Positions tab. Kept as data rather than derived from the app-wide SERP list:
// GoAnyAPI serves the content tools but is refused by the tracker (cached SERPs, no depth or
// language control), and A-Parser is tracker-eligible without being an app-wide SERP source.

export const RANK_PROVIDER_LIST: readonly (readonly [string, string])[] = [
  ["serper", "Serper.dev"],
  ["dataforseo", "DataForSEO"],
  ["scrapingrobot", "ScrapingRobot"],
  ["aparser", "A-Parser"],
];

/** Display name for a provider id, falling back to the raw id. */
export function rankProviderName(id: string): string {
  return RANK_PROVIDER_LIST.find(([p]) => p === id)?.[1] ?? id;
}
