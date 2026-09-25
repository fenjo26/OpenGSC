// N8 — live preview: the exact HTML that "Send now" would freeze, rendered on the fly and
// NOT stored (a preview must never leave a snapshot behind). Opened in a new tab by the
// dashboard; read capability.
import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { renderPreview, reportsSchemaMissing } from "@/lib/reports/store";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const res = await renderPreview(userId, id);
    if ("error" in res) {
      const status = res.error === "not_found" ? 404 : 400;
      return NextResponse.json({ error: res.error }, { status });
    }
    return new NextResponse(res.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // The preview carries real client data — it must not end up in a shared cache.
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (e) {
    if (reportsSchemaMissing(e)) return NextResponse.json({ error: "not_migrated" }, { status: 503 });
    console.warn("[reports] preview failed:", e);
    return NextResponse.json({ error: "reports_error" }, { status: 500 });
  }
}
