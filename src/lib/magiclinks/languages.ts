// Article languages the purchase services accept. Geo from GSC (ESP, FRA, ARG) is not a
// language, and the services' docs forbid guessing outright: unknown is better asked than
// assumed. So this list is only a suggestion-by-TLD, and the choice always stays with the
// operator.
//
// Adapted from gsc-hub (https://github.com/izzipizzy/gsc-hub, MIT).

export const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "uk", label: "Українська" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "el", label: "Ελληνικά" },
  { code: "fi", label: "Suomi" },
  { code: "nl", label: "Nederlands" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "fr-ca", label: "Français (CA)" },
  { code: "kk", label: "Қазақша" },
];

export const LANGUAGE_CODES = new Set(LANGUAGE_OPTIONS.map(l => l.code));

/** The human name of a language by code — the 369Team API takes names, not codes. */
export function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find(l => l.code === code)?.label ?? "";
}

/** The same, but throwing — used at the pay boundary where an unknown code must stop the
 *  order rather than ride into it as an empty string. */
export function languageNameFor(code: string): string {
  const label = languageLabel(code);
  if (!label) throw new Error(`language "${code}" is not on the service list`);
  return label;
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
