"use client";

// Stub from the wave foundation (T0). T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file:
// the dashboard status dot. Renders null until then — a dot that always shows one colour
// would lie about a status nobody has checked.

import type { UptimeBadge } from "@/lib/uptime/types";

export default function UptimeDot({ badge, size = 10 }: { badge: UptimeBadge | null; size?: number }) {
  void badge; void size;
  return null;
}
