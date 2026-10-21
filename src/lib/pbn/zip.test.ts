import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "./zip";

test("builds a buffer with zip signatures", () => {
  const z = buildZip([{ path: "index.html", data: Buffer.from("<html>hi</html>") }, { path: "a/b.txt", data: Buffer.from("x".repeat(500)) }]);
  assert.ok(Buffer.isBuffer(z));
  assert.equal(z.readUInt32LE(0), 0x04034b50);                  // local header
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);      // end of central dir
  assert.equal(z.readUInt16LE(z.length - 22 + 10), 2);          // 2 entries
});
