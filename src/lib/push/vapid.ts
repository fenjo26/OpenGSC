// N10 — VAPID key resolution (docs/tasks/wave-nov/N10-pwa-push.md).
//
// Precedence: env (OPENGSC_VAPID_PUBLIC_KEY / OPENGSC_VAPID_PRIVATE_KEY / OPENGSC_VAPID_SUBJECT)
// → InstanceSetting rows vapid_public / vapid_private (generated once on first use) → generate
// and store. The private key never leaves the server: only /api/push/vapid's response and the
// subscribe flow expose the public half.
//
// The decision logic is resolveVapid() over an injected storage so the test suite can run it
// against a mock; getVapidKeys() is the prisma-backed wiring.

import webpush from "web-push";
import { prisma } from "@/lib/prisma";
import { pushSchemaMissing } from "./store";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** mailto: (or https:) contact the push service can reach — required by the VAPID spec. */
  subject: string;
}

export const VAPID_PUBLIC_KEY = "vapid_public";
export const VAPID_PRIVATE_KEY = "vapid_private";

/** The pure half: env beats storage, and a half-configured env is ignored rather than mixed. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): { publicKey: string; privateKey: string } | null {
  const publicKey = (env.OPENGSC_VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.OPENGSC_VAPID_PRIVATE_KEY ?? "").trim();
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

export function vapidSubjectFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.OPENGSC_VAPID_SUBJECT ?? "").trim();
  if (/^mailto:[^\s]+@[^\s]+$/i.test(raw) || /^https:\/\/\S+$/i.test(raw)) return raw;
  // Invalid/missing subject is IGNORED (never used as a hostname) — fall back to something
  // deterministic and syntactically valid for the spec.
  try {
    const host = env.NEXTAUTH_URL ? new URL(env.NEXTAUTH_URL).hostname : "localhost";
    return `mailto:opengsc@${host}`;
  } catch {
    return "mailto:opengsc@localhost";
  }
}

/** Storage seam for resolveVapid — the prisma-backed implementation is at the bottom. */
export interface VapidStorage {
  read(): Promise<{ publicKey: string; privateKey: string } | null>;
  /** Store one key; "exists" means a concurrent first request already wrote it. */
  write(key: string, value: string): Promise<"created" | "exists" | "unavailable">;
}

/**
 * Env wins outright. Without env: stored pair → reuse; nothing stored → generate once and keep
 * forever (two pairs would silently invalidate every subscription made against the loser).
 */
export async function resolveVapid(env: Record<string, string | undefined>, storage: VapidStorage): Promise<VapidKeys | null> {
  const subject = vapidSubjectFromEnv(env);
  const fromEnv = vapidFromEnv(env);
  if (fromEnv) return { ...fromEnv, subject };

  const stored = await storage.read();
  if (stored) return { ...stored, subject };

  const generated = webpush.generateVAPIDKeys();
  const results = [
    await storage.write(VAPID_PUBLIC_KEY, generated.publicKey),
    await storage.write(VAPID_PRIVATE_KEY, generated.privateKey),
  ];
  if (results.includes("unavailable")) return null; // table missing — notMigrated, not a 500
  // A lost race still ends with ONE pair: prefer whatever is actually stored now.
  const after = await storage.read();
  return after ? { ...after, subject } : { ...generated, subject };
}

const prismaStorage: VapidStorage = {
  async read() {
    try {
      const rows = await prisma.instanceSetting.findMany({
        where: { key: { in: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] } },
        select: { key: true, value: true },
      });
      const publicKey = rows.find(r => r.key === VAPID_PUBLIC_KEY)?.value ?? "";
      const privateKey = rows.find(r => r.key === VAPID_PRIVATE_KEY)?.value ?? "";
      return publicKey && privateKey ? { publicKey, privateKey } : null;
    } catch (e) {
      if (pushSchemaMissing(e)) return null;
      throw e;
    }
  },
  async write(key: string, value: string) {
    try {
      await prisma.instanceSetting.create({ data: { key, value } });
      return "created" as const;
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") return "exists" as const;
      if (pushSchemaMissing(e)) return "unavailable" as const;
      throw e;
    }
  },
};

/**
 * The one entry point the rest of the code uses. Throws only on a genuinely broken database —
 * a missing InstanceSetting table degrades to null (routes answer notMigrated, sends skip).
 */
export async function getVapidKeys(): Promise<VapidKeys | null> {
  try {
    return await resolveVapid(process.env, prismaStorage);
  } catch {
    return null;
  }
}
