/**
 * Create (or repair) the owner account from the server console.
 *
 * Identity and data are two different things in OpenGSC, and this script is where that separation
 * starts. A Google account is a data connection — it is how Search Console and Analytics numbers
 * get in. Who may sign in is a separate question, answered by an email and a password that the
 * server operator sets here, without Google being involved at all.
 *
 *   node scripts/create-owner.mjs --email you@example.com --password 'something long'
 *   node scripts/create-owner.mjs --email you@example.com                  # generates one
 *   node scripts/create-owner.mjs --email you@example.com --force          # reset an existing owner
 *
 * Running it on an instance that already has an owner is refused unless --force is given, so a
 * careless re-run during an update cannot hand the workspace to a new account.
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
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  return process.argv[process.argv.indexOf(hit) + 1] ?? null;
}

function generatePassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(18);
  const body = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  return `${body.slice(0, 6)}-${body.slice(6, 12)}-${body.slice(12, 18)}`;
}

const prisma = new PrismaClient();

try {
  const email = String(arg("email") ?? "").trim().toLowerCase();
  const force = process.argv.includes("--force");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: node scripts/create-owner.mjs --email you@example.com [--password '...'] [--force]");
    process.exit(1);
  }

  const generated = !arg("password");
  const password = arg("password") ?? generatePassword();
  if (password.length < 12) {
    console.error("The password must be at least 12 characters.");
    process.exit(1);
  }

  const existingOwner = await prisma.user.findFirst({ where: { isOwner: true } })
    ?? await prisma.user.findFirst({ orderBy: { id: "asc" } });

  if (existingOwner && !force) {
    const same = (existingOwner.email ?? "").toLowerCase() === email;
    console.error(
      same
        ? `This instance already has an owner (${existingOwner.email}). Re-run with --force to set a new password for it.`
        : `This instance already belongs to ${existingOwner.email}. Re-run with --force only if you mean to move ownership to ${email}.`,
    );
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  let owner;

  if (existingOwner && (existingOwner.email ?? "").toLowerCase() === email) {
    // The common case on an existing install: the owner already exists with all their sites and
    // Google connections, and only needs a password so they can stop signing in through Google.
    owner = await prisma.user.update({
      where: { id: existingOwner.id },
      data: { passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date(), isOwner: true },
    });
  } else if (existingOwner && force) {
    const target = await prisma.user.findUnique({ where: { email } });
    owner = target
      ? await prisma.user.update({ where: { id: target.id }, data: { passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date(), isOwner: true } })
      : await prisma.user.create({ data: { email, name: email.split("@")[0], passwordHash, passwordUpdatedAt: new Date(), isOwner: true } });
    if (owner.id !== existingOwner.id) {
      // Ownership means owning the rows. Moving the flag without moving the data would leave the
      // new owner staring at an empty dashboard, so this is refused rather than half-done.
      await prisma.user.update({ where: { id: existingOwner.id }, data: { isOwner: false } });
      console.warn(
        `\nNOTE: ${existingOwner.email} still owns every site and metric on this instance.\n` +
        `      Use Settings → Members → transfer ownership for a complete handover.\n`,
      );
    }
  } else {
    owner = await prisma.user.create({
      data: { email, name: email.split("@")[0], passwordHash, passwordUpdatedAt: new Date(), isOwner: true },
    });
  }

  console.log(`\nOwner ready: ${owner.email}`);
  if (generated) console.log(`Password:    ${password}`);
  console.log(`\nSign in at /login with "Team member? Sign in with a password".`);
  console.log(`Google stays connected in Settings → My Google Accounts, for Search Console and Analytics data only.\n`);
} catch (error) {
  console.error("Failed:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
