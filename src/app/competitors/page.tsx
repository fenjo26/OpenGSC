"use client";

// Moved: Competitors now lives under SEO Tools (/seo-tools/competitors), next to Demand.
// Both buy data from outside the instance, which is the line SEO Tools draws — everything in
// the main nav reads what OpenGSC already holds. This route keeps old links and bookmarks
// working, the same way /seo-tools/settings redirects into the main Settings screen.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CompetitorsRedirectPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/seo-tools/competitors"); }, [router]);
  return null;
}
