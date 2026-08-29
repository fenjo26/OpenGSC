// What the log is allowed to keep.
//
// A body capture that reproduces the operator's own credentials is a worse problem than the one
// it was switched on to solve: debugging a provider call should not mean handing every reader of
// the log the same key the call itself used. Two passes catch what one cannot — a field whose
// NAME is shaped like a credential is caught regardless of its value, and a value whose SHAPE
// looks like a vendor key is caught even sitting under a field like `note` that gave no warning.
// Ordinary content is left alone, because a log nobody can read to debug with is not worth
// writing either.
//
// The field-name check was originally anchored to six exact words (`^(...)$`), which missed
// `x-api-key` — the literal header `llm.ts` sends for Anthropic and for zai in Anthropic-compatible
// mode — because a hyphenated prefix is not an exact match for `api[-_]?key`. It also missed the
// plural `cookies`. Both are now shape checks: "contains api-key in some spelling" and "is one of
// a short list of exact names (singular or plural)", rather than one rigid word list. The vendor
// shape list was missing z-api (Z.AI's own key format — see settings' `z-api-...` placeholder)
// and Google's `AIza` prefix, so a real key in either shape survived under an innocent field name
// even when the field-name check was fixed. Anthropic's own `sk-ant-…` only ever looked covered
// by the field-name gap because `sk-` happened to already be in the vendor list.
//
// The failure mode on the other side is real too: `promptTokens` and `completionTokens` are
// numbers this feature exists to record, and a careless "contains token" check would swallow
// them. The field-name shape check requires a `-`/`_` immediately before `token` for the suffix
// form, which those two names do not have, so they are left alone — tested explicitly below.

export const BODY_MAX_CHARS = 8_000;

// The `error` column is smaller than a body by nature — a status line and a sentence — and is
// read on screen in a table cell rather than expanded. A cap well under the body's leaves room
// for the longest message this codebase composes (llm.ts's two-levers advice on a discarded
// generation, around 500 characters) without letting a provider that answers a failure with its
// whole HTML error page write it all down.
export const TEXT_MAX_CHARS = 2_000;

// A field name is credential-shaped if it contains "api key" in any of its usual spellings
// anywhere in the name (catches `x-api-key`, `X-API-KEY`, `apiKey`, `api_key`, …), OR is exactly
// one of a short list of full field names (case-insensitive, singular and plural where a plural
// is common), OR ends in `-token`/`_token` with the separator present — deliberately excluding a
// bare "...Token" suffix so `promptTokens` / `completionTokens` are not caught by it.
const KEY_FIELD = /api[-_]?key|^(authorization|password|secret|cookie|cookies|token)$|[-_]token$/i;

// Vendor key shapes, matched wherever they sit in the JSON — under a redacted field name or not.
// `sk-…` (OpenAI/Anthropic), `xai-…`, `pplx-…`, `fc-…`, `gsk-…`, `z-api-…` (Z.AI) and `Bearer …`
// all use a prefix-then-separator-then-body shape; Google's `AIza…` keys have no separator, so
// they get their own alternative.
const VENDOR_SHAPE = /\b(?:(?:sk|xai|pplx|fc|gsk|z-api|Bearer)[-_ ][A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,})\b/g;

export function redact(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, (key, v) => (KEY_FIELD.test(key) ? "[redacted]" : v)) ?? "null";
  } catch {
    json = String(value);
  }
  json = json.replace(VENDOR_SHAPE, "[redacted]");
  if (json.length > BODY_MAX_CHARS) {
    json = `${json.slice(0, BODY_MAX_CHARS)}…[truncated]`;
  }
  return json;
}

// Plain text — the `error` column — is a different problem from a body, and `redact` cannot be
// pointed at it: it JSON-serialises, so it would return a quoted string with every inner quote
// escaped, and its field-name pass sees exactly one field name (none) because the text is one
// opaque value. What text needs instead is to be read the way a human reads it, for the three
// shapes a credential actually arrives in when a provider quotes our own request back at us.
//
// The name shape below is the body pass's `KEY_FIELD` widened by the names that only ever appear
// in text: a bare `key` (how Gemini's and XML River's credentials are spelled in a query string),
// `apikey`, `auth`, and a `-key`/`-secret` suffix. Widening is safe in this direction because a
// text pair only ever blanks the VALUE next to the name — unlike the body pass, where a
// too-broad name would swallow whole fields the log exists to show.
const KEY_NAME_IN_TEXT =
  /api[-_]?key|^(?:authorization|auth|password|passwd|secret|cookie|cookies|token|key|apikey)$|[-_](?:token|key|secret)$/i;

// A URL anywhere in the text, up to the first character that cannot be part of one. Everything
// from its "?" onward goes: that is where Gemini's key travels, and XML River's, and it is the
// half of a URL that is never worth reading in a log.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]}]+/g;

// `name=value`, as it appears in an echoed query string or a form body. The value runs to the
// next separator a query string or a sentence would use.
const PAIR_EQUALS = /([A-Za-z0-9_.[\]-]{1,64})(\s*=\s*)(?:"([^"]*)"|'([^']*)'|[^&\s"',;)\]}]+)/g;

// `"name": "value"`, as it appears when a provider echoes the JSON it rejected. The unquoted
// alternative is deliberately narrow — a scalar only — so a value that is an object or an array
// is left whole rather than half-eaten and the surrounding text left unbalanced.
const PAIR_JSON = /"([A-Za-z0-9_. -]{1,64})"(\s*:\s*)(?:"([^"]*)"|[A-Za-z0-9_.+/=-]+)/g;

/**
 * Sanitize a plain-text string — an error message — for storage.
 *
 * Same vendor-shape pass as `redact`, plus the two pair shapes and the URL query strip, then a
 * cap. Ordinary provider prose passes through unchanged, which is the whole point: an `error`
 * nobody can read says nothing about why a call failed.
 */
export function redactText(s: string): string {
  let text = String(s);
  text = text.replace(URL_IN_TEXT, url => url.split("?")[0]);
  text = text.replace(PAIR_EQUALS, (whole, name: string, sep: string) =>
    KEY_NAME_IN_TEXT.test(name) ? `${name}${sep}[redacted]` : whole);
  text = text.replace(PAIR_JSON, (whole, name: string, sep: string) =>
    KEY_NAME_IN_TEXT.test(name) ? `"${name}"${sep}"[redacted]"` : whole);
  text = text.replace(VENDOR_SHAPE, "[redacted]");
  if (text.length > TEXT_MAX_CHARS) {
    text = `${text.slice(0, TEXT_MAX_CHARS)}…[truncated]`;
  }
  return text;
}

export function safeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}
