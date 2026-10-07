// Publishing wave (P1) — the adapter contract every platform implements.
//
// One adapter per platform, looked up through registry.ts. The rest of the publishing stack
// (API routes, the /publishing page, the MCP tools) talks ONLY to this interface, so wave P2's
// Dev.to / HashNode adapters are new files plus one registry line — nothing else moves.

/** What the publishing pipeline hands an adapter. `html` is pre-rendered from `markdown`
 *  by src/lib/publish/markdown.ts; platforms that want native markup can re-parse. */
export interface PublishPostInput {
  title: string;
  markdown: string;
  html: string;
  tags: string[];
}

export interface PublishResult {
  remoteId: string;
  remoteUrl: string;
}

/**
 * WordPress (P1's only platform): a user with an Application Password and the REST API
 * enabled. Stored as the BlogConnection.credentials JSON string. No OAuth — an application
 * password scopes to one blog, revokes in one click, and is the only credential a
 * self-hosted WordPress can issue without a plugin.
 */
export interface WordPressCreds {
  username: string;
  appPassword: string;
}

// Later waves append here (DevToCreds = { apiKey }, HashNodeCreds = { token }…). Keeping the
// union narrow instead of `Record<string, string>` means a typo'd field fails at the type,
// not as a 401 from the platform an hour later.
export type BlogCreds = WordPressCreds;

export interface BlogAdapter {
  /** Platform id — matches BlogConnection.platform and the registry key. */
  platform: string;
  /**
   * Check the connection is usable. Resolves on success; throws an Error whose message
   * names the real cause (bad credentials, unreachable host, REST API missing) — the route
   * stores that text verbatim in BlogConnection.lastError, so it is user-facing.
   */
  verify(creds: BlogCreds, siteIdentifier: string): Promise<void>;
  /**
   * Create the post. Throws on any failure; never resolves with an empty remoteId/remoteUrl —
   * a "successful" publish the loop cannot link back to is worse than an honest failure.
   */
  publish(creds: BlogCreds, siteIdentifier: string, post: PublishPostInput): Promise<PublishResult>;
}
