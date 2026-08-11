import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isCurrentMcpToken, MCP_TOKEN_PREFIX } from "./mcpToken";

describe("MCP token version", () => {
  it("accepts the current token format", () => {
    assert.equal(
      isCurrentMcpToken(`${MCP_TOKEN_PREFIX}${"a".repeat(48)}`),
      true,
    );
  });

  it("rejects every legacy token", () => {
    assert.equal(isCurrentMcpToken(`ogsc_${"a".repeat(48)}`), false);
  });

  it("rejects malformed current tokens", () => {
    assert.equal(isCurrentMcpToken(`${MCP_TOKEN_PREFIX}${"a".repeat(47)}`), false);
    assert.equal(isCurrentMcpToken(`${MCP_TOKEN_PREFIX}${"z".repeat(48)}`), false);
  });
});
