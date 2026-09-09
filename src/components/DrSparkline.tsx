"use client";

// The DR history sparkline: an inline monthly polyline next to wherever a single DR number is
// already shown (drops DR cell, site header chip). Hand-rolled SVG like PosSparkline in
// RankTracker — a recharts ResponsiveContainer at this size costs more than the chart is worth.

export interface DrPoint {
  month: string; // YYYY-MM
  dr: number;
}

export function DrSparkline({ points, width = 56, height = 18 }: { points: DrPoint[]; width?: number; height?: number }) {
  if (!points || points.length < 2) return null;
  const pad = 2;
  const min = Math.min(...points.map(p => p.dr));
  const max = Math.max(...points.map(p => p.dr));
  const span = Math.max(1, max - min);
  const xy = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (width - pad * 2);
    const y = pad + ((p.dr - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  // The line's colour reads the trend, not the verdict: falling red, everything else green.
  // The verdict (≥5-point fall = penalty flag) is the call site's warning icon and tooltip.
  const falling = points[points.length - 1].dr < points[0].dr;
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden>
      <polyline points={xy.join(" ")} fill="none"
        stroke={falling ? "#EF4444" : "#10B981"} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One line per stored month, oldest first — the series behind a sparkline tooltip. */
export function drSeriesText(points: DrPoint[]): string {
  return points.map(p => `${p.month}: ${p.dr}`).join("\n");
}
