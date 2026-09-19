import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_GLUE_FINDINGS } from "./validate";
import { KNOWN_GLUE_NOTES } from "./generate";

/**
 * The finding/note codes are translated by dynamically built keys
 * (`dropsGlueFinding_<code>`, `dropsGlueNote_<code>`) — a typo in either direction renders
 * a bare key in the UI, and a code renamed in code without its key strands the translation.
 * This test pins both lists to all seven locale files, both directions, the same way
 * check:i18n pins the key sets to each other.
 */

const LOCALES = ["en", "ru", "uk", "fr", "es", "de", "zh"];
const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALE_DIR = join(HERE, "../../../locales");

function keysOf(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), "utf8"));
}

test("каждый код находки переведён во всех семи локалях", () => {
  for (const locale of LOCALES) {
    const dict = keysOf(locale);
    for (const code of KNOWN_GLUE_FINDINGS) {
      const key = `dropsGlueFinding_${code}`;
      assert.equal(
        typeof dict[key], "string", `${locale}: нет ключа ${key}`,
      );
      assert.notEqual((dict[key] as string).trim(), "", `${locale}: пустой ${key}`);
    }
  }
});

test("каждый код нота генератора переведён во всех семи локалях", () => {
  for (const locale of LOCALES) {
    const dict = keysOf(locale);
    for (const code of KNOWN_GLUE_NOTES) {
      const key = `dropsGlueNote_${code}`;
      assert.equal(
        typeof dict[key], "string", `${locale}: нет ключа ${key}`,
      );
      assert.notEqual((dict[key] as string).trim(), "", `${locale}: пустой ${key}`);
    }
  }
});

test("обратное направление: нет ключей без кода", () => {
  const findings = new Set(KNOWN_GLUE_FINDINGS.map(c => `dropsGlueFinding_${c}`));
  const notes = new Set(KNOWN_GLUE_NOTES.map(c => `dropsGlueNote_${c}`));
  for (const locale of LOCALES) {
    for (const key of Object.keys(keysOf(locale))) {
      if (key.startsWith("dropsGlueFinding_")) {
        assert.ok(findings.has(key), `${locale}: ключ ${key} без кода в KNOWN_GLUE_FINDINGS`);
      }
      if (key.startsWith("dropsGlueNote_")) {
        assert.ok(notes.has(key), `${locale}: ключ ${key} без кода в KNOWN_GLUE_NOTES`);
      }
    }
  }
});
