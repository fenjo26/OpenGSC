// N11 (docs/tasks/wave-nov/N11-browser-extension.md) owns src/lib/ext/** — token auth for
// /api/ext/**, URL→portfolio matching, CORS decisions by extension id, rate limiting.
// The pure decisions live in urlMatch.ts / token.ts / origin.ts / rateLimit.ts (unit-tested,
// no Prisma); auth.ts is the server glue; index.ts re-exports the surface the routes use.

export * from "./urlMatch";
export * from "./token";
export * from "./origin";
export * from "./rateLimit";
export { extAuth, extPreflight, extTablesMissing, newExtToken, EXT_TOKEN_PREFIX, isExtTokenFormat } from "./auth";
