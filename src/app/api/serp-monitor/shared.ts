// Handlers shared by every serp-monitor route. Kept beside the routes (this file is not a route —
// only route.ts files are) so the error contract lives in exactly one place: an instance without
// the tables reads as `{ notMigrated: true }` with empty data, a validation throw as 400 with its
// code, anything else as a plain 500.
import { NextResponse } from "next/server";
import { InputError, schemaMissing } from "@/lib/serpmon/store";

/**
 * A pasted keyword list is not small. 8 MB of text is far more than the 5 000-keyword cap can
 * use and still well below what would hurt the process; anything larger is refused with a
 * message instead of being parsed into an out-of-memory crash.
 */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export function notFound(error = "not_found"): NextResponse {
  return NextResponse.json({ error }, { status: 404 });
}

export function tooLarge(): NextResponse {
  return NextResponse.json({ error: "Import too large — split it into several parts" }, { status: 413 });
}

/**
 * The one catch-all. `empty` is the route's response shape with every list set to empty, spread
 * under `notMigrated: true` so the page can say "run npx prisma db push" instead of a 500.
 */
export function serpmonError(e: unknown, empty: Record<string, unknown> = {}): NextResponse {
  if (schemaMissing(e)) return NextResponse.json({ notMigrated: true, ...empty });
  if (e instanceof InputError) return NextResponse.json({ error: e.code }, { status: 400 });
  console.error("[serpmon-api]", e);
  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** Parse a JSON body, tolerating absent/invalid ones (callers validate the shape themselves). */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** Query-string number that must be a positive integer, else undefined. */
export function positiveInt(sp: URLSearchParams, key: string): number | undefined {
  const n = Number(sp.get(key));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
