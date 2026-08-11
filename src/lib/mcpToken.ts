export const MCP_TOKEN_PREFIX = "ogsc_v2_";

export function isCurrentMcpToken(token: string): boolean {
  return /^ogsc_v2_[0-9a-f]{48}$/.test(token);
}
