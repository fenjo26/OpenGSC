// Which AI surfaces the LLM Mentions index covers, and what to call them on screen.
//
// A separate file for the same reason as `metricsPricing.ts` and `contentAnalysisShapes.ts`: this
// list is rendered by a client component, while the module that fetches the mentions now opens
// its request through the provider log and so reaches the Prisma client. A panel drawing two
// column headers must not pull a database driver into the browser bundle.

/** The only two surfaces DataForSEO indexes. Not an abbreviation of a longer list. */
export type LlmPlatform = "chat_gpt" | "google";
export const LLM_PLATFORMS: LlmPlatform[] = ["chat_gpt", "google"];

export const PLATFORM_LABEL: Record<LlmPlatform, string> = {
  chat_gpt: "ChatGPT",
  google: "Google AI Overview",
};
