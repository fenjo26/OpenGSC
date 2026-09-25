import { NextResponse } from "next/server";

// POST /api/seo/meta-fit — T1 (docs/tasks/wave-oct/T1-meta-fit.md) implements the body.
// Stub answer until then: a stable 501 the UI can translate.

export async function POST() {
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
