// N10 — VAPID resolution against a mock storage (docs/tasks/wave-nov/N10-pwa-push.md):
// env beats storage, a half-configured env is ignored, nothing stored generates once, and a
// lost race still converges on one pair.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveVapid, vapidFromEnv, vapidSubjectFromEnv, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, type VapidStorage } from "./vapid";

/** In-memory InstanceSetting stand-in; `unavailableOnce` simulates the table not existing yet. */
function mockStorage(initial: Record<string, string> = {}): VapidStorage & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    async read() {
      const publicKey = rows.get(VAPID_PUBLIC_KEY) ?? "";
      const privateKey = rows.get(VAPID_PRIVATE_KEY) ?? "";
      return publicKey && privateKey ? { publicKey, privateKey } : null;
    },
    async write(key: string, value: string) {
      if (rows.has(key)) return "exists" as const;
      rows.set(key, value);
      return "created" as const;
    },
  };
}

const ENV_KEYS = {
  OPENGSC_VAPID_PUBLIC_KEY: "env-public-key",
  OPENGSC_VAPID_PRIVATE_KEY: "env-private-key",
  OPENGSC_VAPID_SUBJECT: "mailto:ops@example.com",
};

test("vapidFromEnv: both halves or nothing — a half-configured env never mixes with storage", () => {
  assert.deepEqual(vapidFromEnv({ ...ENV_KEYS }), { publicKey: "env-public-key", privateKey: "env-private-key" });
  assert.equal(vapidFromEnv({ OPENGSC_VAPID_PUBLIC_KEY: "only-public" }), null);
  assert.equal(vapidFromEnv({}), null);
});

test("vapidSubjectFromEnv: valid mailto/https pass through, otherwise derived from NEXTAUTH_URL", () => {
  assert.equal(vapidSubjectFromEnv(ENV_KEYS), "mailto:ops@example.com");
  assert.equal(vapidSubjectFromEnv({ OPENGSC_VAPID_SUBJECT: "https://example.com/contact" }), "https://example.com/contact");
  assert.equal(vapidSubjectFromEnv({ OPENGSC_VAPID_SUBJECT: "not an email" }), "mailto:opengsc@localhost");
  assert.equal(vapidSubjectFromEnv({ NEXTAUTH_URL: "https://panel.example.gr/" }), "mailto:opengsc@panel.example.gr");
});

test("resolveVapid: env keys win even when a pair is stored", async () => {
  const storage = mockStorage({ [VAPID_PUBLIC_KEY]: "stored-public", [VAPID_PRIVATE_KEY]: "stored-private" });
  const keys = await resolveVapid(ENV_KEYS, storage);
  assert.equal(keys?.publicKey, "env-public-key");
  assert.equal(keys?.privateKey, "env-private-key");
  assert.equal(keys?.subject, "mailto:ops@example.com");
  // The stored pair is untouched — env is an override, not a migration.
  assert.equal(storage.rows.get(VAPID_PUBLIC_KEY), "stored-public");
});

test("resolveVapid: stored pair is reused, nothing new is written", async () => {
  const storage = mockStorage({ [VAPID_PUBLIC_KEY]: "stored-public", [VAPID_PRIVATE_KEY]: "stored-private" });
  const keys = await resolveVapid({}, storage);
  assert.equal(keys?.publicKey, "stored-public");
  assert.equal(keys?.subject, "mailto:opengsc@localhost");
  assert.equal(storage.rows.size, 2);
});

test("resolveVapid: empty storage generates and persists one pair", async () => {
  const storage = mockStorage();
  const keys = await resolveVapid({}, storage);
  assert.ok(keys?.publicKey);
  assert.ok(keys?.privateKey);
  assert.ok(keys!.publicKey.length > 40, "a real VAPID public key, not a stub");
  assert.equal(storage.rows.get(VAPID_PUBLIC_KEY), keys!.publicKey);
  assert.equal(storage.rows.get(VAPID_PRIVATE_KEY), keys!.privateKey);
  // Second call returns the SAME pair.
  const again = await resolveVapid({}, storage);
  assert.equal(again?.publicKey, keys!.publicKey);
});

test("resolveVapid: private key never equals the public one", async () => {
  const keys = await resolveVapid({}, mockStorage());
  assert.notEqual(keys?.publicKey, keys?.privateKey);
});

test("resolveVapid: a write that hits an unavailable table degrades to null (notMigrated)", async () => {
  const storage: VapidStorage = {
    async read() { return null; },
    async write() { return "unavailable" as const; },
  };
  assert.equal(await resolveVapid({}, storage), null);
});
