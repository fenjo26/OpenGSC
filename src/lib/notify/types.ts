// wave-nov (CONTRACT.md §2): "lead" (new lead from the audit widget, N9), "local" (map-pack
// changes + GBP reviews, N3/N4), "trend" (rising queries, N5). "test" stays a filter-only
// value and deliberately not in NOTIFY_EVENTS (types.test.ts asserts this).
export type NotifyEvent = "alert" | "digest" | "uptime" | "index" | "mention" | "lead" | "local" | "trend" | "test";

export const NOTIFY_EVENTS: NotifyEvent[] = ["alert", "digest", "uptime", "index", "mention", "lead", "local", "trend"];

// wave-nov (CONTRACT.md §2): "webpush" is the PWA push channel (N10). N0 only widens the union
// and patches the exhaustive switches it breaks with a not_implemented stub; N10 owns delivery.
export type NotifyChannelId = "telegram" | "slack" | "discord" | "teams" | "email" | "webhook" | "webpush";

export interface NotifyChannelBase {
  on: boolean;
  events: NotifyEvent[];       // empty = all events
  lastOkAt?: string | null;    // ISO, written by delivery
  lastError?: string | null;
}

export interface NotifyChannelsConfig {
  discord?: NotifyChannelBase & { url: string };
  teams?:   NotifyChannelBase & { url: string };
  webhook?: NotifyChannelBase & { url: string; secret: string };   // HMAC-SHA256 of the raw body → X-OpenGSC-Signature: sha256=<hex>
  email?:   NotifyChannelBase & {
    host: string; port: number; secure: boolean; user: string; pass: string;
    from: string; to: string[];
  };
  /** Event filters for the two channels whose credentials live in their own User columns. */
  telegramEvents?: NotifyEvent[];
  slackEvents?: NotifyEvent[];
}

/** What the settings UI receives: secrets replaced by masks, never the raw values. */
export interface NotifyChannelView {
  id: NotifyChannelId;
  configured: boolean;
  on: boolean;
  events: NotifyEvent[];
  target: string | null;       // masked URL / "user@host → a@b.c"
  lastOkAt: string | null;
  lastError: string | null;
}

export interface NotifyOptions {
  event?: NotifyEvent;         // default "alert"
  title?: string;              // subject for e-mail / card title; default = first line of text
}

export interface NotifyDelivery {
  channel: NotifyChannelId;
  ok: boolean;
  error?: string;
}
