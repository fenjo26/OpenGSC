// Adapter registry (server side). The UI's platform list lives in platforms.ts (client-safe
// pure data); this module is the only place that maps a platform id to a live adapter, so
// adding P2's Dev.to/HashNode is one import plus one entry — every caller (routes, MCP tools)
// keeps going through adapterFor().

import { wordpressAdapter } from "./adapters/wordpress";
import type { BlogAdapter } from "./types";

const ADAPTERS: Record<string, BlogAdapter> = {
  wordpress: wordpressAdapter(),
};

export function adapterFor(platform: string): BlogAdapter {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`Unknown publishing platform: "${platform}". Supported: ${Object.keys(ADAPTERS).join(", ")}.`);
  return adapter;
}
