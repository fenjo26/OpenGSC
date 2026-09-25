// N9 — CSV export of the lead inbox, under the same filter the table shows (drops/export
// convention: server-side, the whole selection, not the page the browser happens to hold).

import { workspaceUserId } from "@/lib/team/workspace";
import { leadsToCsv } from "@/lib/leads/csv";
import { listLeads } from "@/lib/leads/store";
import type { LeadListItem } from "@/lib/leads/types";

export const dynamic = "force-dynamic";

const PAGE = 200;
const MAX_ROWS = 10_000;

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const p = new URL(req.url).searchParams;
  const filter = {
    status: p.get("status") ?? undefined,
    q: p.get("q") ?? undefined,
  };

  const all: LeadListItem[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await listLeads(userId, { ...filter, limit: PAGE, offset });
    all.push(...page.leads);
    if (all.length >= page.total || page.leads.length === 0) break;
  }

  return new Response(leadsToCsv(all), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="opengsc-leads.csv"`,
    },
  });
}
