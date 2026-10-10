// Article languages the purchase services accept. Geo from GSC (ESP, FRA, ARG) is not a
// language, and the services' docs forbid guessing outright: unknown is better asked than
// assumed. So this list is only a suggestion-by-TLD, and the choice always stays with the
// operator.
//
// Adapted from gsc-hub (https://github.com/izzipizzy/gsc-hub, MIT).

// `label` is what the operator reads in the picker (the language's own name). `apiName` is what
// 369Team's API takes in OrderRow.language — its spec (v1.1) spells it "English, German,
// Dutch, Русский": English exonyms, except Russian in Cyrillic. The service publishes no full
// list, so names beyond those four follow the same pattern; an unknown one is refused with a
// 400 for the whole order (nothing is charged), never silently guessed.
export const LANGUAGE_OPTIONS: { code: string; label: string; apiName: string }[] = [
  { code: "en", label: "English", apiName: "English" },
  { code: "ru", label: "Русский", apiName: "Русский" },
  { code: "uk", label: "Українська", apiName: "Ukrainian" },
  { code: "es", label: "Español", apiName: "Spanish" },
  { code: "pt", label: "Português", apiName: "Portuguese" },
  { code: "el", label: "Ελληνικά", apiName: "Greek" },
  { code: "fi", label: "Suomi", apiName: "Finnish" },
  { code: "nl", label: "Nederlands", apiName: "Dutch" },
  { code: "de", label: "Deutsch", apiName: "German" },
  { code: "fr", label: "Français", apiName: "French" },
  { code: "fr-ca", label: "Français (CA)", apiName: "French" },
  { code: "kk", label: "Қазақша", apiName: "Kazakh" },
];

export const LANGUAGE_CODES = new Set(LANGUAGE_OPTIONS.map(l => l.code));

/** The display name of a language by code (the picker's label). */
export function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find(l => l.code === code)?.label ?? "";
}

/** The name 369Team's API expects for a code — throwing, because this runs at the pay
 *  boundary where an unknown code must stop the order rather than ride into it as "". */
export function languageNameFor(code: string): string {
  const name = LANGUAGE_OPTIONS.find(l => l.code === code)?.apiName ?? "";
  if (!name) throw new Error(`language "${code}" is not on the service list`);
  return name;
}

// Only TLDs whose country language is unambiguous. .com/.net/.org are absent on purpose: they
// host Spanish, Portuguese and English sites with equal success.
const TLD_LANGUAGE: Record<string, string> = {
  es: "es",
  fr: "fr",
  de: "de",
  nl: "nl",
  fi: "fi",
  gr: "el",
  ua: "uk",
  ru: "ru",
  kz: "kk",
  pt: "pt",
  br: "pt",
  mx: "es",
  ar: "es",
  it: "en",
};

/** Suggested language for a host, or null when the TLD says nothing. English as the fallback
 *  would be a guess dressed as an answer; the modal leaves the choice open instead. */
export function defaultLanguageForHost(host: string): string | null {
  const tld = host.split(".").pop()?.toLowerCase() ?? "";
  return TLD_LANGUAGE[tld] ?? null;
}
