// Parsing of the doorway → /api/indexer/webhook body.
//
// The route has no session: the doorway authenticates with IndexerDomain.apiKey, and the key is
// looked up with `findFirst({ where: { apiKey } })`. Anything other than a plain string there is
// not a key — Prisma reads an object as a filter, which turns the lookup into "any domain at all".
// So the key, and every field written to the log, is checked for type and length here, before the
// route touches the database. The key is strict: anything but a bounded string is refused. The log
// fields are lenient on purpose, because doorway scripts already deployed on other hosts cannot be
// updated from here: an over-long value is cut to its limit, a non-string one is dropped to its
// default — but neither ever reaches a query as anything other than a plain string.

export const WEBHOOK_LIMITS = {
  apiKey: 128,
  url: 2048,
  ip: 64,
  userAgent: 512,
  referer: 2048,
  botType: 32,
} as const;

export interface WebhookInput {
  apiKey: string;
  url: string;
  ip: string;
  userAgent: string;
  referer: string | null;
  statusCode: number;
  isRedirect: boolean;
  botType: string;
}

export type WebhookParse = { ok: true; value: WebhookInput } | { ok: false; error: string };

/** A string cut to `max`, or undefined for absent / non-string values. */
function optString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function statusOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 200;
}

function flagOf(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export function parseWebhookBody(body: unknown): WebhookParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;

  if (typeof b.apiKey !== "string" || !b.apiKey.trim() || b.apiKey.length > WEBHOOK_LIMITS.apiKey) {
    return { ok: false, error: "invalid_api_key" };
  }

  const url = optString(b.url, WEBHOOK_LIMITS.url);
  const ip = optString(b.ip, WEBHOOK_LIMITS.ip);
  const userAgent = optString(b.userAgent, WEBHOOK_LIMITS.userAgent);
  const referer = optString(b.referer, WEBHOOK_LIMITS.referer);
  const botType = optString(b.botType, WEBHOOK_LIMITS.botType);

  return {
    ok: true,
    value: {
      apiKey: b.apiKey.trim(),
      url: url ?? "/",
      ip: ip ?? "0.0.0.0",
      userAgent: userAgent ?? "Unknown",
      referer: referer ?? null,
      statusCode: statusOf(b.statusCode),
      isRedirect: flagOf(b.isRedirect),
      botType: (botType ?? "").toLowerCase(),
    },
  };
}
