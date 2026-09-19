import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_TOX_SIGNALS } from "./classify";

/**
 * Signal codes are translated by dynamically built keys (`dropsToxSignal_<code>`) — the same
 * contract the glue findings hold: every code must have its key in all seven locales, and no
 * key may exist without its code, or a renamed signal strands its translation.
 */
const LOCALES = ["en", "ru", "uk", "fr", "es", "de", "zh"];
const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALE_DIR = join(HERE, "../../../locales");

function keysOf(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), "utf8"));
}

test("каждый код сигнала переведён во всех семи локалях", () => {
  for (const locale of LOCALES) {
    const dict = keysOf(locale);
    for (const code of KNOWN_TOX_SIGNALS) {
      const key = `dropsToxSignal_${code}`;
      assert.equal(typeof dict[key], "string", `${locale}: нет ключа ${key}`);
      assert.notEqual((dict[key] as string).trim(), "", `${locale}: пустой ${key}`);
    }
  }
});

test("обратное направление: нет ключей без кода", () => {
  const known = new Set(KNOWN_TOX_SIGNALS.map(c => `dropsToxSignal_${c}`));
  for (const locale of LOCALES) {
    for (const key of Object.keys(keysOf(locale))) {
      if (key.startsWith("dropsToxSignal_")) {
        assert.ok(known.has(key), `${locale}: ключ ${key} без кода в KNOWN_TOX_SIGNALS`);
      }
    }
  }
});
