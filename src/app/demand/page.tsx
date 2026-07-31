"use client";

// Moved: Demand now lives under SEO Tools (/seo-tools/demand), next to Competitors.
// See the note in /competitors/page.tsx for why. This route only exists so links written
// while it lived at the top level keep working.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DemandRedirectPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/seo-tools/demand"); }, [router]);
  return null;
}
