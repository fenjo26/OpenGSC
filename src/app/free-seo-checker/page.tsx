import type { Metadata } from "next";
import PublicSeoChecker from "@/components/PublicSeoChecker";

export const metadata: Metadata = {
  title: "Free SEO Checker — OpenGSC",
  description: "Check HTTPS, indexability, metadata, schema, security headers and basic performance facts without connecting Search Console.",
  robots: { index: true, follow: true },
};

export default function FreeSeoCheckerPage() {
  return <PublicSeoChecker turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ""} />;
}
