import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/team/workspace";

// Reading the provider call log back.
//
// Every other table in this schema is tenant-scoped by `userId`, and a `where: { userId }` is the
// whole of the access rule. This one is not, and the difference is deliberate: a call made with no
// established context is stored with `userId: null`, because inventing an owner would put somebody
// else's name on somebody else's spend. Those rows are real — `sync-cron` produces them by design
// — and they have to be readable by someone, or the log quietly hides the instance's own work.
//
// "Someone" is the instance owner and nobody else. A null row carries no tenant key, so showing it
// to *any* workspace owner would mean showing one instance-wide run — its endpoints, its costs,
// and with body capture on its prompts — to every workspace on the box. That is a cross-tenant
// leak dressed up as transparency. `User.isOwner` is the one flag that says "this account owns
// this deployment", and it is what the extra rows are gated on.
//
// The filters are validated against the values the log actually holds *for this caller*, rather
// than passed through. Two things fall out of that and both are wanted: nothing user-typed reaches
// a query, and a caller cannot use the filter as an oracle for what other workspaces have been
// calling — asking for a provider only another tenant used is a 400, not an empty list.

/** Rows per page when the caller does not say. */
export const PAGE_SIZE_DEFAULT = 50;
/**
 * The ceiling. Rows carry endpoints and error text, and the point of the screen is the most
 * recent calls, not all ninety days of them in one response.
 */
export const PAGE_SIZE_MAX = 100;

// Same loose handle as everywhere else this model is touched: until `prisma generate` re-runs the
// delegate is absent, and a settings screen should say "nothing recorded yet" rather than 500.
const providerCalls = () => (prisma as any).providerCall;

/** What the list shows. Deliberately without the bodies — see `rowWithBodies`. */
function dto(r: any) {
  return {
    id: r.id,
    at: r.at,
    userId: r.userId,
    feature: r.feature,
    provider: r.provider,
    model: r.model,
    endpoint: r.endpoint,
    status: r.status,
    ms: r.ms,
    attempt: r.attempt,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    // Passed through exactly as stored, null included. Nothing here defaults it to 0: null means
    // the provider stated no price, and a 0 on screen is a claim we cannot make.
    costUsd: r.costUsd,
    error: r.error,
    complete: r.complete,
    /** Whether opening this row would show anything. Cheaper than shipping the bodies to find out. */
    hasBodies: !!(r.requestBody || r.responseBody),
  };
}

/**
 * Whether this workspace's owner is the account that owns the deployment.
 *
 * Read straight off the User row rather than compared against `workspaceOwner()`, because the
 * question is about the flag, not about who happens to resolve first. An instance that predates
 * the column has it unset for everyone — in which case nobody sees the unattributed rows, which
 * is the right way for this particular uncertainty to fail. (In practice `getWorkspace()` has
 * already marked the owner by the time anyone can reach this route.)
 */
async function isInstanceOwner(userId: string): Promise<boolean> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { isOwner: true } });
    return !!u?.isOwner;
  } catch {
    return false;
  }
}

/** Every row this caller is allowed to see, and not one more. */
function scopeFor(ownerId: string, unattributed: boolean): Record<string, unknown> {
  return unattributed ? { OR: [{ userId: ownerId }, { userId: null }] } : { userId: ownerId };
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** The distinct non-null values of one column, within what this caller can see. */
async function facet(table: any, column: "provider" | "feature", scope: Record<string, unknown>): Promise<string[]> {
  const groups: any[] = await table.groupBy({ by: [column], where: scope });
  return groups.map(g => g[column]).filter((v: unknown): v is string => typeof v === "string" && v.length > 0).sort();
}

export async function GET(req: Request) {
  const guard = await requireWorkspace("manageSecrets");
  if (!guard.ok) return guard.response;
  const ownerId = guard.ws.ownerId;

  const table = providerCalls();
  if (!table) {
    return NextResponse.json({ rows: [], total: 0, providers: [], features: [], notMigrated: true });
  }

  const url = new URL(req.url);
  const unattributed = await isInstanceOwner(ownerId);
  const scope = scopeFor(ownerId, unattributed);

  try {
    // One row, with its bodies. Scoped exactly like the list, so an id guessed from someone else's
    // screen answers 404 rather than handing over a prompt.
    const id = url.searchParams.get("id");
    if (id) {
      const found = await table.findFirst({ where: { ...scope, id } });
      if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({
        row: { ...dto(found), requestBody: found.requestBody ?? null, responseBody: found.responseBody ?? null },
      });
    }

    const [providers, features] = await Promise.all([
      facet(table, "provider", scope),
      facet(table, "feature", scope),
    ]);

    // The allowlist is the facet list: a value this caller has actually produced. Anything else is
    // refused rather than quietly returning nothing, so a typo reads as a typo.
    const provider = url.searchParams.get("provider");
    if (provider && !providers.includes(provider)) {
      return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
    }
    const feature = url.searchParams.get("feature");
    if (feature && !features.includes(feature)) {
      return NextResponse.json({ error: "unknown_feature" }, { status: 400 });
    }

    const take = clampInt(url.searchParams.get("limit"), PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX);
    const skip = clampInt(url.searchParams.get("offset"), 0, 0, 100_000);
    const where = { ...scope, ...(provider ? { provider } : {}), ...(feature ? { feature } : {}) };

    const [rows, total] = await Promise.all([
      table.findMany({ where, orderBy: { at: "desc" }, take, skip }),
      table.count({ where }),
    ]);

    return NextResponse.json({
      rows: rows.map(dto),
      total,
      providers,
      features,
      limit: take,
      offset: skip,
      /** So the view can say why cron rows are there — or, for everyone else, why they are not. */
      unattributed,
    });
  } catch {
    // The table exists in the client but not in the database yet, or the database is unhappy. A
    // log that cannot be read is not a reason to break the settings screen it is read from.
    return NextResponse.json({ rows: [], total: 0, providers: [], features: [], notMigrated: true });
  }
}
