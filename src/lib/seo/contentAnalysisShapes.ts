// What a content-analysis result looks like — no calls, no imports, safe in a browser.
//
// Split out of `contentAnalysis.ts` for the same reason `metricsPricing.ts` was split out of
// `metrics.ts`: the Citations page renders one column per emotion and so needs this list, while
// the module that fetches the citations now opens its request through the provider log and
// reaches the Prisma client. A page importing a constant must not import a database driver.

export type Polarity = "positive" | "neutral" | "negative";
export const EMOTIONS = ["anger", "happiness", "love", "sadness", "share", "fun"] as const;
export type Emotion = typeof EMOTIONS[number];

export interface Citation {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  polarity: Polarity;
  emotions: Record<Emotion, number>;
  topEmotion?: Emotion;
  date: string;
  score: number;
}
