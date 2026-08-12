/**
 * Set or reset the password of any account on this instance, from the server console.
 *
 * This is the recovery path when nobody can sign in: a forgotten owner password, a member locked
 * out with their admin unavailable. Console access to the machine is the authority here, which is
 * the same authority that could read the database anyway.
 *
 *   node scripts/set-password.mjs --email person@example.com [--password '...']
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("../src/generated/prisma/index.js");

function arg(name) {
  const hit = process.argv.find(value => value === `--${name}` || value.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : process.argv[process.argv.indexOf(hit) + 1] ?? null;
}

const prisma = new PrismaClient();
try {
  const email = String(arg("email") ?? "").trim().toLowerCase();
  if (!email) { console.error("Usage: node scripts/set-password.mjs --email person@example.com [--password '...']"); process.exit(1); }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, isOwner: true } });
  if (!user) { console.error(`No account with that email. Existing accounts:`); 
    const all = await prisma.user.findMany({ select: { email: true, isOwner: true } });
    all.forEach(u => console.error(`  ${u.email}${u.isOwner ? "  (owner)" : ""}`));
    process.exit(1);
  }

  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const generated = !arg("password");
  const password = arg("password") ?? Array.from(randomBytes(18), b => alphabet[b % alphabet.length]).join("").replace(/^(.{6})(.{6})(.{6})$/, "$1-$2-$3");
  if (password.length < 12) { console.error("The password must be at least 12 characters."); process.exit(1); }

  await prisma.user.update({
    where: { id: user.id },
    // Set from the console, so there is no admin holding a copy: no forced change is imposed.
    data: { passwordHash: await bcrypt.hash(password, 12), mustChangePassword: false, passwordUpdatedAt: new Date() },
  });
  console.log(`\nPassword updated for ${user.email}${user.isOwner ? " (owner)" : ""}`);
  if (generated) console.log(`Password: ${password}\n`);
} catch (error) {
  console.error("Failed:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
