"use client";

import { createContext, useContext, useState, useEffect } from "react";

export type LayoutMode = "wide" | "default";

interface LayoutCtx { layout: LayoutMode; setLayout: (v: LayoutMode) => void; }

const Ctx = createContext<LayoutCtx>({ layout: "wide", setLayout: () => {} });

// Layout is applied to the page via two CSS custom properties on :root, NOT by re-rendering the
// React tree. The properties are read by .main-content and the seo-tools/indexer layout wrappers,
// so the toggle reaches every page that uses those containers without each one subscribing to the
// context. Same document.documentElement style-mutation pattern as ThemeContext.
//
//   wide    → fills the viewport (max-width 100%, larger gutters)
//   default → centers content at 1280px with tighter gutters
const PAGE_WIDTH = { wide: "100%", default: "1280px" };
const PAGE_GUTTER = { wide: "32px", default: "24px" };

function applyLayout(layout: LayoutMode) {
  const root = document.documentElement;
  root.style.setProperty("--page-max-width", PAGE_WIDTH[layout]);
  root.style.setProperty("--page-padding", PAGE_GUTTER[layout]);
}

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [layout, setLayoutState] = useState<LayoutMode>("wide");

  useEffect(() => {
    const stored = localStorage.getItem("layout") as LayoutMode | null;
    const initial: LayoutMode = stored === "default" || stored === "wide" ? stored : "wide";
    setLayoutState(initial);
    applyLayout(initial);
  }, []);

  const setLayout = (v: LayoutMode) => {
    setLayoutState(v);
    localStorage.setItem("layout", v);
    applyLayout(v);
  };

  return <Ctx.Provider value={{ layout, setLayout }}>{children}</Ctx.Provider>;
}

export const useLayout = () => useContext(Ctx);

