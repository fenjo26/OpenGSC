"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import en from "@/locales/en.json";
import ru from "@/locales/ru.json";
import uk from "@/locales/uk.json";
import fr from "@/locales/fr.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";
import zh from "@/locales/zh.json";

type Language = "en" | "ru" | "uk" | "fr" | "es" | "de" | "zh";
type Dictionary = typeof en;

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: keyof Dictionary) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const dictionaries: Record<Language, Dictionary> = { en, ru, uk, fr, es, de, zh };

// Languages we accept from localStorage, in priority order.
const KNOWN_LANGS: Language[] = ["en", "ru", "uk", "fr", "es", "de", "zh"];

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguageState] = useState<Language>("en");

  useEffect(() => {
    const saved = localStorage.getItem("language") as Language;
    if (KNOWN_LANGS.includes(saved)) {
      setLanguageState(saved);
    } else {
      // Browser language auto-detection. Walk the navigator languages in order
      // and pick the first whose primary subtag matches one we ship, else "en".
      const nav = navigator.language.toLowerCase();
      const primary = nav.split("-")[0];
      const browserLang: Language =
        primary === "uk" ? "uk"
        : primary === "ru" ? "ru"
        : primary === "zh" ? "zh"
        : primary === "fr" ? "fr"
        : primary === "es" ? "es"
        : primary === "de" ? "de"
        : "en";
      setLanguageState(browserLang);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("language", lang);
  };

  const t = (key: keyof Dictionary) => {
    return dictionaries[language][key] || key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};
