// Catch a broken install before the build does, and say which of the two things went wrong.
//
// npm 12 blocks dependency lifecycle scripts unless the root package lists them in
// `allowScripts`. better-sqlite3 builds its native binding in exactly such a script, so a
// blocked install leaves a package that is present on disk and unusable. Nothing fails at
// install time. The failure arrives later, at boot, as a module that cannot be loaded.
//
// The entries in `allowScripts` are pinned to exact versions, which is the point of them, but it
// also means a dependency bump silently stops matching. This script compares the two files and
// then tries the load for real, because the comparison explains a likely cause while the load is
// the thing that actually matters.
//
// Run by update.sh and install.sh after npm install. Plain .mjs so it needs nothing installed to
// run, which matters when the whole question is whether the install worked.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));

const problems = [];

// ── 1. Do the allowScripts pins still match what the lockfile installs? ──────────────────────
let pkg, lock;
try {
  pkg = read("package.json");
  lock = read("package-lock.json");
} catch (err) {
  console.error(`[deps] could not read package.json / package-lock.json: ${err.message}`);
  process.exit(1);
}

const installed = (name) => {
  const entry = Object.entries(lock.packages ?? {}).find(([path]) => path.endsWith(`node_modules/${name}`));
  return entry?.[1]?.version ?? null;
};

for (const spec of Object.keys(pkg.allowScripts ?? {})) {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at);
  const pinned = spec.slice(at + 1);
  const actual = installed(name);

  if (actual === null) {
    problems.push(`allowScripts lists ${spec}, but ${name} is not in package-lock.json at all.`);
  } else if (actual !== pinned) {
    problems.push(
      `allowScripts pins ${spec}, but the lockfile installs ${name}@${actual}. ` +
      `Under npm 12 that package's install script will not run — change the key to ${name}@${actual}.`,
    );
  }
}

// ── 2. Does the one native dependency actually load? ─────────────────────────────────────────
// This is the failure the check exists for. It can happen for reasons other than allowScripts —
// a missing compiler, a prebuild that does not exist for this platform — so it is tested rather
// than inferred.
try {
  createRequire(join(root, "package.json"))("better-sqlite3");
} catch (err) {
  problems.push(
    `better-sqlite3 is installed but will not load, so the app cannot open its database:\n` +
    `    ${String(err?.message ?? err).split("\n")[0]}\n` +
    `    Usually its native build was skipped. Try: npm rebuild better-sqlite3`,
  );
}

if (problems.length) {
  console.error("\n[deps] the install finished but is not usable:\n");
  for (const p of problems) console.error(`  • ${p}\n`);
  process.exit(1);
}

console.log("[deps] allowScripts matches the lockfile, better-sqlite3 loads");
