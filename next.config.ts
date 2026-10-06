import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The TypeScript check during `next build` needs >2 GB of heap, which OOMs on
  // small VPS instances. Types are checked during development instead — the
  // production build only compiles.
  typescript: { ignoreBuildErrors: true },
  async headers() {
    return [
      {
        // `/:path*` alone does not match `/`. The optional slash is the form the
        // self-hosting guide uses so the root document gets the same headers.
        source: "/:path*{/}?",
        headers: [
          // Six months. `includeSubDomains` applies to hosts under this one, not the parent.
          { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
          // Share tokens travel in the query string. A linked asset must not echo that URL.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // `/embed` and `/embed/*` are the audit widget, which other sites iframe.
        // `/embeddings` would still be framed-denied; nothing in the app uses that path.
        source: "/((?!embed(?:/|$)).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
};

export default nextConfig;
