"use client";

import { createContext, useContext, useState, useEffect } from "react";

interface PrivacyCtx { blur: boolean; setBlur: (v: boolean) => void; }

const Ctx = createContext<PrivacyCtx>({ blur: false, setBlur: () => {} });

// Blur is applied to the DOM via a data-attribute on :root (data-privacy="on"/"off"), NOT by
// re-rendering. The CSS rule in globals.css targets value-bearing leaves inside any element marked
// `.privacy-sensitive`, and only fires when this attribute is "on". Same documentElement mutation
// pattern as ThemeContext (data-theme) and LayoutContext (--page-*). Default is off so the first
// paint is sharp — there is never a flash of blurred content on load.
function applyPrivacy(on: boolean) {
  document.documentElement.setAttribute("data-privacy", on ? "on" : "off");
}

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const [blur, setBlurState] = useState(false);

  // Persist across page navigations (sessionStorage — clears on tab close)
  useEffect(() => {
    const stored = sessionStorage.getItem("privacy_blur");
    const on = stored === "1";
    setBlurState(on);
    applyPrivacy(on);
  }, []);

  const setBlur = (v: boolean) => {
    setBlurState(v);
    sessionStorage.setItem("privacy_blur", v ? "1" : "0");
    applyPrivacy(v);
  };

  return <Ctx.Provider value={{ blur, setBlur }}>{children}</Ctx.Provider>;
}

export const usePrivacy = () => useContext(Ctx);

