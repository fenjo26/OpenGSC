export type MentionSource = "news" | "wikipedia" | "wikidata";
export type MentionKind = "mention" | "link" | "entity";
export type MentionLinkStatus = "unchecked" | "linked" | "unlinked" | "unreachable";

export interface MentionTerm {
  term: string;                 // exact phrase, searched quoted
  mustInclude: string[];        // at least one must also appear (context words); empty = none
}

export interface MentionSettings {
  on: boolean;
  terms: MentionTerm[];         // empty → derived from Site.brandedKeywords + host
  exclude: string[];            // drop results whose title/snippet contain any of these
  sources: MentionSource[];     // default all three
  lang: string;                 // ISO-639-1, default from site market
  country: string;              // gl, default Site.market or "us"
  notify: boolean;              // daily batch to notify channels (event "mention")
  lastRunAt?: string | null;
}

export const DEFAULT_MENTION_SOURCES: MentionSource[] = ["news", "wikipedia", "wikidata"];

export interface MentionHit {
  source: MentionSource;
  kind: MentionKind;
  term: string;
  url: string;
  title: string;
  snippet: string;
  publisher: string;
  lang: string;
  publishedAt: string | null;   // ISO
}

export interface MentionRow extends MentionHit {
  id: string;
  firstSeenAt: string;
  linkStatus: MentionLinkStatus;
  reviewed: boolean;
  dismissed: boolean;
}

export interface MentionQuery {
  source?: MentionSource | "all";
  state?: "new" | "reviewed" | "dismissed" | "all";
  linkStatus?: MentionLinkStatus | "all";
  q?: string;
  limit?: number;               // clamp 1..200, default 50
  offset?: number;
}
