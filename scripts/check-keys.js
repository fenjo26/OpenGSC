const fs = require('fs');
const path = require('path');

const locales = ['en', 'ru', 'uk', 'fr', 'es', 'de', 'zh'];
const dictionaries = Object.fromEntries(locales.map(locale => {
  const file = path.resolve(__dirname, `../src/locales/${locale}.json`);
  return [locale, JSON.parse(fs.readFileSync(file, 'utf8'))];
}));

const keySets = Object.fromEntries(locales.map(locale => [locale, new Set(Object.keys(dictionaries[locale]))]));
const allKeys = new Set(locales.flatMap(locale => Object.keys(dictionaries[locale])));
let hasMismatch = false;

for (const locale of locales) {
  console.log(`${locale}.json has ${keySets[locale].size} keys.`);
}

for (const key of allKeys) {
  const missing = locales.filter(locale => !keySets[locale].has(key));
  if (missing.length) {
    hasMismatch = true;
    console.error(`Key "${key}" is missing from: ${missing.join(', ')}`);
  }
}

if (hasMismatch) {
  console.error('Locale key sets are not synchronized.');
  process.exitCode = 1;
} else {
  console.log(`All ${locales.length} locale files have identical key sets.`);
}
