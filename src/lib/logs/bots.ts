/**
 * Who a user agent says it is. The claim only — whether a "Googlebot" really is Google is decided
 * by reverse DNS in verify.ts, for the families that publish a verifiable hostname.
 *
 * Pure.
 */

export type BotKind = "search" | "ai" | "seo" | "other";

export interface BotFamily {
  id: string;
  label: string;
  kind: BotKind;
  /** Hostname suffixes a genuine crawler's reverse DNS ends with; absent = cannot be verified. */
  rdns?: string[];
}

interface Rule { re: RegExp; family: BotFamily }

const F = (id: string, label: string, kind: BotKind, rdns?: string[]): BotFamily => ({ id, label, kind, rdns });

// Order matters: the first match wins, so specific agents come before the generic ones they
// contain (Googlebot-Image before Googlebot is fine — both are Google; "bot" is the last resort).
const RULES: Rule[] = [
  { re: /googlebot|google-inspectiontool|storebot-google|googleother|adsbot-google|mediapartners-google|google-safety/i, family: F("google", "Googlebot", "search", ["googlebot.com", "google.com"]) },
  { re: /bingbot|bingpreview|msnbot|adidxbot/i, family: F("bing", "Bingbot", "search", ["search.msn.com"]) },
  { re: /yandex(?:bot|images|metrika|mobilebot|accessibilitybot|renderresourcesbot)?/i, family: F("yandex", "YandexBot", "search", ["yandex.ru", "yandex.net", "yandex.com"]) },
  { re: /applebot/i, family: F("apple", "Applebot", "search", ["applebot.apple.com"]) },
  { re: /duckduckbot|duckassistbot/i, family: F("duckduckgo", "DuckDuckBot", "search") },
  { re: /baiduspider/i, family: F("baidu", "Baiduspider", "search") },
  { re: /petalbot/i, family: F("petal", "PetalBot", "search") },
  { re: /seznambot/i, family: F("seznam", "SeznamBot", "search") },
  { re: /gptbot/i, family: F("gptbot", "GPTBot (OpenAI training)", "ai") },
  { re: /oai-searchbot/i, family: F("oai-search", "OAI-SearchBot (ChatGPT search)", "ai") },
  { re: /chatgpt-user/i, family: F("chatgpt-user", "ChatGPT-User", "ai") },
  { re: /claudebot|claude-searchbot|claude-user|anthropic-ai/i, family: F("claude", "ClaudeBot / Claude", "ai") },
  { re: /perplexitybot|perplexity-user/i, family: F("perplexity", "Perplexity", "ai") },
  { re: /ccbot/i, family: F("ccbot", "CCBot (Common Crawl)", "ai") },
  { re: /bytespider/i, family: F("bytespider", "Bytespider (ByteDance)", "ai") },
  { re: /amazonbot/i, family: F("amazonbot", "Amazonbot", "ai") },
  { re: /meta-externalagent|meta-externalfetcher|facebookbot/i, family: F("meta", "Meta AI crawler", "ai") },
  { re: /mistralai-user/i, family: F("mistral", "MistralAI-User", "ai") },
  { re: /cohere-ai|cohere-training/i, family: F("cohere", "Cohere", "ai") },
  { re: /ahrefsbot|ahrefssiteaudit/i, family: F("ahrefs", "AhrefsBot", "seo") },
  { re: /semrushbot|siteauditbot|semrush/i, family: F("semrush", "SemrushBot", "seo") },
  { re: /mj12bot/i, family: F("majestic", "MJ12bot (Majestic)", "seo") },
  { re: /dotbot/i, family: F("moz", "DotBot (Moz)", "seo") },
  { re: /dataforseobot/i, family: F("dataforseo", "DataForSeoBot", "seo") },
  { re: /serpstatbot/i, family: F("serpstat", "SerpstatBot", "seo") },
  { re: /blexbot/i, family: F("blexbot", "BLEXBot", "seo") },
  { re: /screaming frog|sitebulb|opengsc-audit/i, family: F("audit-crawler", "SEO audit crawler", "seo") },
  { re: /facebookexternalhit|twitterbot|telegrambot|whatsapp|slackbot|discordbot|linkedinbot|viber/i, family: F("preview", "Link preview bots", "other") },
  { re: /bot\b|crawler|spider|crawl|python-requests|curl\/|wget|go-http-client|headlesschrome|scrapy/i, family: F("other", "Other bots & scripts", "other") },
];

/** The bot family a user agent claims, or null for an ordinary browser. */
export function classifyUserAgent(ua: string | null): BotFamily | null {
  if (!ua) return null;
  for (const rule of RULES) if (rule.re.test(ua)) return rule.family;
  return null;
}

export const VERIFIABLE_FAMILIES = new Set(RULES.filter(r => r.family.rdns).map(r => r.family.id));

export function familyById(id: string): BotFamily | undefined {
  return RULES.find(r => r.family.id === id)?.family;
}
