import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";
import ClientSessionProvider from "@/components/ClientSessionProvider";
import DashboardShell from "@/components/DashboardShell";
import SeoKeysSync from "@/components/SeoKeysSync";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { PrivacyProvider } from "@/lib/PrivacyContext";
import { ThemeProvider } from "@/lib/ThemeContext";
import { LayoutProvider } from "@/lib/LayoutContext";

// N10 (docs/tasks/wave-nov/N10-pwa-push.md) — PWA plumbing through the Next Metadata API
// (Next 16: manifest + appleWebApp here, themeColor in the separate viewport export — the
// metadata.themeColor option is deprecated since v14, per node_modules/next/dist/docs).
export const metadata: Metadata = {
  title: "OpenGSC Dashboard",
  description: "Advanced Search Console Analytics without Limits",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
  // iOS standalone: without these an installed PWA opens in a Safari tab with no address
  // bar to remove, and web push stays unavailable (iOS 16.4+, installed-to-Home-Screen only).
  appleWebApp: {
    capable: true,
    title: "OpenGSC",
    statusBarStyle: "black-translucent",
  },
};

// theme_color from the theme tokens (globals.css): the dark canvas and Apple Parchment.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <ClientSessionProvider>
          <ThemeProvider>
            <LayoutProvider>
              <PrivacyProvider>
                <LanguageProvider>
                  <SeoKeysSync />
                  <ServiceWorkerRegister />
                  <DashboardShell>
                    {children}
                  </DashboardShell>
                </LanguageProvider>
              </PrivacyProvider>
            </LayoutProvider>
          </ThemeProvider>
        </ClientSessionProvider>
      </body>
    </html>
  );
}
