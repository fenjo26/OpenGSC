"use client";

// Standalone home for metric imports. The component itself is prop-free and self-contained,
// so if this turns out to belong inside Striking Distance or a site page instead, only the
// placement moves — not the logic.

import MetricsImport from "@/components/MetricsImport";

export default function MetricsImportPage() {
  return <MetricsImport />;
}
