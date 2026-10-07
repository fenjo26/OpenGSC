// The publishing store — DB + orchestration shared by the API routes and the MCP tools.
// One implementation on purpose: the MCP tool and the route must run the same flow (same
// statuses, same backlink write), and a second copy would drift the first time one of them
// got a fix the other didn't.
//
// The loop closer lives here too: every SUCCESSFUL publish writes a SiteBacklink row with
// source "self", mirroring the purchased-placement import in lib/magiclinks/tracking.ts
// (same normalization helpers, same create-or-merge rule on the unique key) so our own
// satellite posts join the same verification pipeline as bought links. tracking.ts does not
// export its insert — its rows carry purchase provenance we don't have — so the logic is
// mirrored here against the same helpers it uses (normalizeBacklinkUrl, donorHostOf,
// mergeSources, backlinksNotMigrated).
//
// R+ hardening, all SERVER-side so every surface (UI route, MCP tool, scheduler) gets it
// from the same place:
//   - connection types gate respin: only external_platform may adapt (see CONNECTION_TYPES);
//   - the uniqueness gate (gate.ts) runs at SEND time against the whole instance;
//   - a spread window defers posts as "scheduled" with a fixed random offset;
//   - per-connection sources (items[]) let each own satellite carry its own post.

import { prisma } from "@/lib/prisma";
import { normalizeBacklinkUrl, donorHostOf } from "@/lib/seo/backlinkImport";
import { backlinksNotMigrated } from "@/lib/backlinks/store";
import { mergeSources } from "@/lib/magiclinks/tracking";
import { fetchLLM } from "@/lib/llm";
import { adapterFor } from "./registry";
import { markdownToHtmlBody } from "./markdown";
import { respinPost, type RespinCreds } from "./respin";
import { platformDefById } from "./platforms";
import { extractPostFromHistory, firstHeading } from "./historySource";
import { uniquenessVerdict, blockedError, GATE_COMPARE_CAP } from "./gate";
import { anchorDistribution, reviewBatch, type AnchorSummary, type BatchWarnings } from "./review";
import type { BlogCreds } from "./types";

// Re-exported for every existing importer: the pure history extraction lives in
// historySource.ts (so read-only tools can share it without importing prisma).
export { extractPostFromHistory, firstHeading };

// ─── connection types ───────────────────────────────────────────────────────────

/**
 * What a destination IS in the network — the respin gate reads exactly this.
 *
 * The gate is formulated as a WHITELIST ("respin only for external_platform"), not a
 * blacklist ("not for own_satellite"): if a fourth type ever appears (a web2.0 farm, a new
 * platform), respin must not silently reach it.
 *   own_satellite     — the user's own satellite blog. Each post is generated FOR this site;
 *                       adapting one canonical text onto N own satellites is a ready-made
 *                       footprint (one facture, one link target, one publication moment).
 *   money_site        — the money site's own CMS. Respinning the money site's own canonical
 *                       onto itself is pointless churn, so it is out of the whitelist too.
 *   external_platform — a third-party publishing platform the user does not control. There a
 *                       tone adaptation is legitimate (and the uniqueness gate still applies).
 */
export const CONNECTION_TYPES = ["own_satellite", "money_site", "external_platform"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** Fail-closed parse: anything unknown is an error, never a silent default to something permissive. */
export function parseConnectionType(v: unknown): ConnectionType {
  const s = String(v ?? "").trim();
  if ((CONNECTION_TYPES as readonly string[]).includes(s)) return s as ConnectionType;
  throw new Error(`unknown_connection_type: ${s || "(empty)"} — expected one of ${CONNECTION_TYPES.join(" | ")}`);
}

// ─── connections ───────────────────────────────────────────────────────────────

export interface ConnectionRow {
  id: string;
  siteId: string;
  platform: string;
  connectionType: ConnectionType;
  label: string;
  siteIdentifier: string;
  status: string;
  lastError: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  /** Masked preview of each credential field — the secret never leaves the server whole. */
  credentialPreview: Record<string, string>;
}

/**
 * First 3 chars + "…" (minimum 1 char) — enough to recognize WHICH key this is, not enough
 * to use it. Application passwords are 24-character capability tokens; three characters of
 * one is a hint, not a credential.
 */
export function maskSecret(value: string): string {
  const v = String(value || "").trim();
  if (!v) return "";
  return v.length <= 3 ? v.slice(0, 1) + "…" : v.slice(0, 3) + "…";
}

export function toConnectionRow(c: {
  id: string; siteId: string; platform: string; connectionType: string; label: string; siteIdentifier: string;
  status: string; lastError: string; lastVerifiedAt: Date | null; createdAt: Date; credentials: string;
}): ConnectionRow {
  let creds: Record<string, unknown> = {};
  try { creds = typeof c.credentials === "string" && c.credentials ? JSON.parse(c.credentials) : {}; } catch { /* preview stays empty */ }
  const preview: Record<string, string> = {};
  for (const field of platformDefById(c.platform)?.fields ?? []) {
    const v = creds[field.key];
    preview[field.key] = typeof v === "string" ? maskSecret(v) : "";
  }
  // The type column is a convention-enum in the schema (string with values in a comment), so
  // an unexpected stored value surfaces as own_satellite here — fail-closed for the respin
  // gate, exactly the direction the default migration value chose.
  const connectionType = (CONNECTION_TYPES as readonly string[]).includes(c.connectionType)
    ? (c.connectionType as ConnectionType)
    : "own_satellite";
  return {
    id: c.id, siteId: c.siteId, platform: c.platform, connectionType, label: c.label, siteIdentifier: c.siteIdentifier,
    status: c.status, lastError: c.lastError,
    lastVerifiedAt: c.lastVerifiedAt ? c.lastVerifiedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    credentialPreview: preview,
  };
}

export async function listConnections(userId: string, siteId: string): Promise<ConnectionRow[]> {
  const rows = await prisma.blogConnection.findMany({
    where: { siteId, site: { userId } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toConnectionRow);
}

export async function createConnection(userId: string, input: {
  siteId: string; platform: string; connectionType?: string; label: string; siteIdentifier: string; credentials: Record<string, string>;
}): Promise<ConnectionRow> {
  const site = await prisma.site.findFirst({ where: { id: input.siteId, userId }, select: { id: true } });
  if (!site) throw new Error("site_not_found");
  if (!platformDefById(input.platform)) throw new Error(`unknown_platform: ${input.platform}`);
  const label = String(input.label || "").trim();
  const siteIdentifier = String(input.siteIdentifier || "").trim();
  if (!label) throw new Error("label_required");
  if (!siteIdentifier) throw new Error("site_identifier_required");
  // Absent type = own_satellite (the schema's own fail-closed default); a PRESENT but wrong
  // value is rejected by parseConnectionType rather than quietly rewritten.
  const connectionType = input.connectionType == null || input.connectionType === ""
    ? "own_satellite"
    : parseConnectionType(input.connectionType);
  // Only the fields the platform declares are kept — anything else the client sent is dropped
  // here, so a stray key can never sit in the credentials blob unreviewed.
  const creds: Record<string, string> = {};
  for (const f of platformDefById(input.platform)!.fields) {
    const v = String(input.credentials?.[f.key] || "").trim();
    if (!v) throw new Error(`${f.key}_required`);
    creds[f.key] = v;
  }
  const created = await prisma.blogConnection.create({
    data: {
      siteId: input.siteId,
      platform: input.platform,
      connectionType,
      label,
      siteIdentifier,
      credentials: JSON.stringify(creds),
      status: "unverified", // honest start: nothing has been checked yet
    },
  });
  return toConnectionRow(created);
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  // Scoped through site.userId — deleting by bare id would let any workspace member of
  // another owner's site (a compromised session) drop rows they never owned.
  const existing = await prisma.blogConnection.findFirst({
    where: { id, site: { userId } },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.blogConnection.delete({ where: { id } });
  return true;
}

/** Run adapter.verify and persist the honest outcome (ok / error + lastError + timestamp). */
export async function verifyConnection(userId: string, id: string): Promise<ConnectionRow> {
  const c = await prisma.blogConnection.findFirst({
    where: { id, site: { userId } },
  });
  if (!c) throw new Error("connection_not_found");
  let status = "ok";
  let lastError = "";
  try {
    await adapterFor(c.platform).verify(JSON.parse(c.credentials || "{}") as BlogCreds, c.siteIdentifier);
  } catch (e) {
    status = "error";
    lastError = e instanceof Error ? e.message : String(e);
  }
  const updated = await prisma.blogConnection.update({
    where: { id },
    data: { status, lastError, lastVerifiedAt: new Date() },
  });
  return toConnectionRow(updated);
}

// ─── money-site links ───────────────────────────────────────────────────────────

/** The money-site host out of a Site row (url or sc-domain: property), lowercase. */
export function siteHostOf(siteUrl: string, siteIdProp: string): string {
  const raw = siteUrl || siteIdProp || "";
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* fall through */ }
  return raw.replace(/^sc-domain:/i, "").replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0].toLowerCase();
}

/**
 * First markdown link whose target belongs to the money site (host equals it or a subdomain).
 * This is the fallback target for the backlink row when the caller did not name one — and it
 * is a FALLBACK, stated plainly: a post that links three of our pages records the first one,
 * which is a defensible default, not a promise about the post's most important link.
 * The full inventory (anchor distribution) lives in review.ts's linkInventory.
 */
export function firstMoneySiteLink(markdown: string, host: string): string {
  if (!host) return "";
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown || ""))) {
    try {
      const target = new URL(m[2]);
      const h = target.hostname.toLowerCase();
      if (h === host || h.endsWith(`.${host}`)) return target.href;
    } catch { /* not an absolute URL — cannot be the money-site link */ }
  }
  return "";
}

// ─── the backlink loop closer ──────────────────────────────────────────────────

/**
 * Write the published post into SiteBacklink as a donor with source "self". Mirrors
 * importPurchasedPlacements in lib/magiclinks/tracking.ts: identity is (site, urlFromNorm,
 * urlTo); an existing row only gains "self" in sources — it never touches the check-,
 * api- or tox- field groups, which belong to their own writers. Degrades to a no-op before
 * `prisma db push` (the loop simply has nothing to feed yet), same convention as the ledger.
 */
export async function recordSelfBacklink(siteId: string, remoteUrl: string, targetUrl: string): Promise<void> {
  const urlFromNorm = normalizeBacklinkUrl(remoteUrl);
  const urlTo = String(targetUrl || "").trim();
  if (!urlFromNorm || !urlTo || urlFromNorm === normalizeBacklinkUrl(urlTo)) return;
  try {
    const existing = await prisma.siteBacklink.findUnique({
      where: { siteId_urlFromNorm_urlTo: { siteId, urlFromNorm, urlTo } },
      select: { id: true, sources: true },
    });
    if (existing) {
      await prisma.siteBacklink.update({
        where: { id: existing.id },
        data: { sources: mergeSources(existing.sources ?? "", "self") },
      });
    } else {
      await prisma.siteBacklink.create({
        data: {
          siteId,
          urlFrom: remoteUrl,
          urlFromNorm,
          urlTo,
          domainFrom: donorHostOf(remoteUrl),
          source: "self",
          sources: "self",
        },
      });
    }
  } catch (e) {
    if (backlinksNotMigrated(e)) return; // not migrated — the loop has nothing to feed yet
    throw e;
  }
}

// ─── the publish flow ──────────────────────────────────────────────────────────

/** One per-connection source for the items[] form: a history entry OR a pasted draft. */
export interface PublishItem {
  connectionId: string;
  historyId?: string;
  title?: string;
  markdown?: string;
}

export interface PublishRequest {
  siteId: string;
  /** SeoHistory.id to publish (flat form: one source for every connection); the markdown/title come from the record. */
  historyId?: string;
  /** Manual override / fallback when the history row is not on the server yet (flat form). */
  title?: string;
  markdown?: string;
  connectionIds: string[];
  /** One respin (AI) call per external_platform connection when true. */
  respin: boolean;
  /** Explicit urlTo for the backlink row; otherwise derived from the post's links. */
  targetUrl?: string;
  /** Per-connection sources (own-satellite mode): each connection publishes its own post. */
  items?: PublishItem[];
  /** Defer the batch: posts are created as "scheduled" with a random offset within N hours. */
  windowHours?: number;
  /** Same, in days. Mutually exclusive with windowHours (one or neither, never both). */
  windowDays?: number;
}

export interface PostRow {
  id: string;
  siteId: string;
  connectionId: string;
  connectionLabel: string;
  platform: string;
  historyId: string | null;
  title: string;
  status: string;
  remoteUrl: string;
  remoteId: string;
  respinUsed: boolean;
  error: string;
  publishedAt: string | null;
  createdAt: string;
  /** R+: when a deferred post is due (status "scheduled"); null for immediate posts. */
  scheduledAt: string | null;
  /** R+: 1 − max similarity against the published set at send time (null = not yet measured). */
  uniquenessScore: number | null;
}

export interface PublishOutcome {
  posts: PostRow[];
  /** Connections that failed before anything was sent (no PublishedPost row exists). */
  failures: { connectionId: string; label: string; error: string }[];
  /** Anchor distribution across this batch's money-site links (planned sources). */
  anchorSummary: AnchorSummary;
  /** Honest footprint warnings for the batch — visible, never blocking. */
  warnings: BatchWarnings;
}

/** The PublishedPost columns the send path touches — exported for the scheduler's locals. */
export type PostDbRow = {
  id: string; siteId: string; connectionId: string; title: string; markdown: string; status: string; remoteUrl: string;
  remoteId: string; respinUsed: boolean; error: string; publishedAt: Date | null; createdAt: Date; historyId: string | null;
  scheduledAt: Date | null; uniquenessScore: number | null;
};

export function toPostRow(p: PostDbRow, connection?: { label: string; platform: string } | null): PostRow {
  return {
    id: p.id, siteId: p.siteId, connectionId: p.connectionId,
    connectionLabel: connection?.label ?? "", platform: connection?.platform ?? "",
    historyId: p.historyId, title: p.title, status: p.status,
    remoteUrl: p.remoteUrl, remoteId: p.remoteId, respinUsed: p.respinUsed,
    error: p.error, publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    scheduledAt: p.scheduledAt ? p.scheduledAt.toISOString() : null,
    uniquenessScore: p.uniquenessScore != null ? p.uniquenessScore : null,
  };
}

async function loadSource(
  userId: string,
  req: { historyId?: string; title?: string; markdown?: string },
): Promise<{ title: string; markdown: string; historyId: string | null }> {
  if (req.historyId) {
    const row = await prisma.seoHistory.findFirst({
      where: { id: req.historyId, userId },
      select: { type: true, keyword: true, data: true },
    });
    if (row) {
      const extracted = extractPostFromHistory(row);
      if (extracted) return { ...extracted, historyId: req.historyId };
      // A row that exists but carries no body (an outline record, an empty landing) is a
      // real error, not a fallback case — the user picked it precisely because it should.
      throw new Error("history_not_publishable: that history record has no article body (only text/landing records do)");
    }
    // Not on the server yet (local cache syncs on a ~2.5s debounce): fall through to the
    // caller-provided title/markdown, keeping the historyId so the link still lines up when
    // the row lands.
  }
  const markdown = String(req.markdown || "").trim();
  const title = String(req.title || "").trim();
  if (!markdown) throw new Error("no_content: pass historyId, or title + markdown");
  return { title: title || firstHeading(markdown) || "Untitled", markdown, historyId: req.historyId ?? null };
}

/** The comparison set for the gate: the latest published posts of the WHOLE instance. */
async function publishedComparisonSet(excludePostId?: string): Promise<{ id: string; title: string; markdown: string }[]> {
  // Instance-wide on purpose (plan 7.6-2): single-user instance, Google sees duplicates
  // across the whole network. Capped at GATE_COMPARE_CAP newest — see gate.ts for the
  // honest wording of what that cap does and does not promise.
  const rows = await prisma.publishedPost.findMany({
    where: { status: "published", ...(excludePostId ? { id: { not: excludePostId } } : {}) },
    orderBy: { publishedAt: "desc" },
    take: GATE_COMPARE_CAP,
    select: { id: true, title: true, markdown: true },
  });
  return rows;
}

/**
 * The one per-post send path: uniqueness gate, then adapter publish, then the backlink row.
 * Shared by the immediate publish loop, Retry and the scheduler — the gate must run at SEND
 * time in all three, and a second implementation would drift. Never throws: the outcome lands
 * on the post row (status/error), which is what every caller renders.
 */
export async function sendPostRow(
  post: PostDbRow,
  connection: { platform: string; credentials: string; siteIdentifier: string; label: string },
  site: { id: string; url: string; siteId: string },
  targetUrlOverride?: string,
): Promise<PostDbRow> {
  // The gate: ALWAYS at send time, against the whole instance's published set.
  const verdict = uniquenessVerdict(post.markdown, await publishedComparisonSet(post.id));
  if (verdict.level === "blocked") {
    // No override, no quiet pass: the twin is named, the number is stated, the post stays.
    return await prisma.publishedPost.update({
      where: { id: post.id },
      data: { status: "blocked", error: blockedError(verdict), uniquenessScore: verdict.uniquenessScore },
    });
  }
  try {
    const adapter = adapterFor(connection.platform);
    const result = await adapter.publish(
      JSON.parse(connection.credentials || "{}") as BlogCreds,
      connection.siteIdentifier,
      { title: post.title, markdown: post.markdown, html: markdownToHtmlBody(post.markdown), tags: [] },
    );
    const updated = await prisma.publishedPost.update({
      where: { id: post.id },
      data: { status: "published", remoteId: result.remoteId, remoteUrl: result.remoteUrl, error: "", publishedAt: new Date(), uniquenessScore: verdict.uniquenessScore },
    });
    // Success only: a failed publish has no donor page, and pretending it does would put
    // a dead URL into the checker's queue.
    const host = siteHostOf(site.url, site.siteId);
    const target = targetUrlOverride?.trim()
      || firstMoneySiteLink(post.markdown, host)
      || (site.url ? site.url.replace(/\/+$/, "") : "");
    await recordSelfBacklink(site.id, result.remoteUrl, target);
    return updated;
  } catch (e) {
    return await prisma.publishedPost.update({
      where: { id: post.id },
      data: { status: "failed", error: e instanceof Error ? e.message : String(e), uniquenessScore: verdict.uniquenessScore },
    });
  }
}

/**
 * Parse the spread window; returns milliseconds, or null when the request is immediate.
 * A present-but-non-positive value is an ERROR, not a silent "immediate": a caller that
 * asked to spread over -2 hours has a bug worth naming, and quietly publishing the batch as
 * one burst is exactly the footprint the window exists to avoid.
 */
export function parseWindowMs(req: { windowHours?: number; windowDays?: number }): number | null {
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const hasHours = isNum(req.windowHours);
  const hasDays = isNum(req.windowDays);
  if (hasHours && hasDays) throw new Error("window_conflict: pass windowHours or windowDays, not both");
  if (hasHours && (req.windowHours as number) <= 0) throw new Error("window_invalid: windowHours must be > 0");
  if (hasDays && (req.windowDays as number) <= 0) throw new Error("window_invalid: windowDays must be > 0");
  if (!hasHours && !hasDays) return null;
  return hasHours ? (req.windowHours as number) * 3_600_000 : (req.windowDays as number) * 86_400_000;
}

/**
 * Respin permission, one place: the whitelist the plan pinned. Formulated positively so a
 * future fourth connection type does not inherit respin by accident.
 */
export function respinAllowedFor(connectionType: string): boolean {
  return connectionType === "external_platform";
}

/**
 * Publish one source (flat form) or one source per connection (items form) to the
 * connections of one site. Each connection is independent: a failure (respin included)
 * marks that connection failed and the loop continues — one bad credential must not
 * silently cancel the other three publishes the user asked for.
 *
 * With a spread window nothing is sent at all: rows are created as "scheduled" with a
 * random offset inside the window (fixed at creation, visible and editable in the posts
 * table), and the scheduler sends them later through sendPostRow — respin and the
 * uniqueness gate run at SEND time, not at planning time.
 */
export async function runPublish(
  userId: string,
  site: { id: string; url: string; siteId: string },
  req: PublishRequest,
  creds: RespinCreds,
): Promise<PublishOutcome> {
  const windowMs = parseWindowMs(req);

  // Resolve sources per connection. items[] (own-satellite mode) names a source per
  // connection; the flat form shares one source across connectionIds.
  const connectionIds = req.items?.length
    ? req.items.map(i => i.connectionId)
    : req.connectionIds;
  const connections = await prisma.blogConnection.findMany({
    where: { id: { in: connectionIds }, siteId: site.id, site: { userId } },
  });
  if (!connections.length) throw new Error("no_connections: none of those connection ids belong to this site");
  const byId = new Map(connections.map(c => [c.id, c]));

  const sources = new Map<string, { title: string; markdown: string; historyId: string | null }>();
  if (req.items?.length) {
    for (const item of req.items) {
      if (!byId.has(item.connectionId)) continue; // filtered out of `connections` above
      sources.set(item.connectionId, await loadSource(userId, item));
    }
  } else {
    const shared = await loadSource(userId, req);
    for (const c of connections) sources.set(c.id, shared);
  }

  const host = siteHostOf(site.url, site.siteId);
  const out: PublishOutcome = {
    posts: [], failures: [],
    anchorSummary: anchorDistribution([...sources.values()].map(s => s.markdown), host),
    warnings: { skeletons: [], repeatedAnchors: [], clusters: [] },
  };

  // ── deferred branch: plan only ──
  if (windowMs != null) {
    const created: PostDbRow[] = [];
    for (const connection of connections) {
      const source = sources.get(connection.id);
      if (!source) continue;
      if (req.respin && !respinAllowedFor(connection.connectionType)) {
        // The respin gate applies at planning time too: planning an adaptation that can
        // never run would hide the refusal days later behind a scheduler error.
        out.failures.push({
          connectionId: connection.id, label: connection.label,
          error: `respin_not_allowed_for_own_satellite: connection "${connection.label}" is ${connection.connectionType}; respin is allowed only for external_platform connections`,
        });
        continue;
      }
      // Offset fixed at creation — the plan is visible and editable in the posts table;
      // re-rolling it on every read would be a hidden second plan.
      const offsetMs = Math.floor(Math.random() * (windowMs + 1));
      const row = await prisma.publishedPost.create({
        data: {
          siteId: site.id,
          connectionId: connection.id,
          historyId: source.historyId,
          title: source.title, markdown: source.markdown,
          // respinUsed doubles as the PLANNED-respin marker for scheduled posts: the
          // adaptation itself runs at send time and overwrites title/markdown then. The
          // posts UI labels this state explicitly rather than pretending it already ran.
          respinUsed: req.respin,
          status: "scheduled",
          scheduledAt: new Date(Date.now() + offsetMs),
        },
      });
      created.push(row);
      out.posts.push(toPostRow(row, connection));
    }
    out.warnings = reviewBatch(
      created.map(r => ({ title: r.title, markdown: r.markdown, scheduledAt: r.scheduledAt })),
      host,
      connections.map(c => c.siteIdentifier), // satellite labels fold into {x} — the swap a shared template performs
    );
    return out;
  }

  // ── immediate branch: respin (external only), gate, send ──
  const sent: PostDbRow[] = [];
  for (const connection of connections) {
    const source = sources.get(connection.id);
    if (!source) continue;
    try {
      let title = source.title;
      let markdown = source.markdown;
      let respinUsed = false;
      if (req.respin) {
        if (!respinAllowedFor(connection.connectionType)) {
          // Server-side gate, stated per connection: no post row is created for it at all.
          throw new Error(`respin_not_allowed_for_own_satellite: connection "${connection.label}" is ${connection.connectionType}; respin is allowed only for external_platform connections`);
        }
        // Respin per platform, before any row is created: a failed adaptation must not leave
        // a "failed" post row holding the UNADAPTED text, because Retry would then ship it.
        const result = await respinPost(
          { platform: connection.platform, sourceTitle: source.title, sourceMarkdown: source.markdown, projectDomain: host },
          creds,
          fetchLLM,
        );
        title = result.title;
        markdown = result.body;
        respinUsed = true;
      }

      let post = await prisma.publishedPost.create({
        data: {
          siteId: site.id,
          connectionId: connection.id,
          historyId: source.historyId,
          title, markdown, respinUsed,
          status: "publishing",
        },
      });
      post = await sendPostRow(post, connection, site, req.targetUrl);
      sent.push(post);
      out.posts.push(toPostRow(post, connection));
    } catch (e) {
      // Pre-send failure (unknown platform, respin gate, respin error): reported, not
      // persisted — there is no honest PublishedPost to show for a call that never left
      // the building.
      out.failures.push({ connectionId: connection.id, label: connection.label, error: e instanceof Error ? e.message : String(e) });
    }
  }
  out.warnings = reviewBatch(
    sent.map(r => ({ title: r.title, markdown: r.markdown, scheduledAt: r.scheduledAt })),
    host,
    connections.map(c => c.siteIdentifier),
  );
  return out;
}

/**
 * Pre-publish review WITHOUT creating anything: the same source resolution and the same
 * pure review runPublish would run, rendered before the operator commits. The uniqueness
 * gate is deliberately NOT here — it runs at send time, and a preview similarity number
 * would read as a promise the gate then has to keep against a set that changes.
 */
export async function previewPublish(
  userId: string,
  site: { id: string; url: string; siteId: string },
  req: PublishRequest,
): Promise<{
  planned: { connectionId: string; label: string; connectionType: string; title: string }[];
  anchorSummary: AnchorSummary;
  warnings: BatchWarnings;
  /** Respin will be refused for these planned connections (not external_platform). */
  respinRefusedFor: string[];
}> {
  const connectionIds = req.items?.length ? req.items.map(i => i.connectionId) : req.connectionIds;
  const connections = await prisma.blogConnection.findMany({
    where: { id: { in: connectionIds }, siteId: site.id, site: { userId } },
  });
  if (!connections.length) throw new Error("no_connections: none of those connection ids belong to this site");
  const byId = new Map(connections.map(c => [c.id, c]));

  const sources = new Map<string, { title: string; markdown: string }>();
  if (req.items?.length) {
    for (const item of req.items) {
      if (!byId.has(item.connectionId)) continue;
      const s = await loadSource(userId, item);
      sources.set(item.connectionId, { title: s.title, markdown: s.markdown });
    }
  } else {
    const shared = await loadSource(userId, req);
    for (const c of connections) sources.set(c.id, shared);
  }

  const host = siteHostOf(site.url, site.siteId);
  const planned = [...sources.entries()].map(([connectionId, s]) => {
    const c = byId.get(connectionId)!;
    return { connectionId, label: c.label, connectionType: c.connectionType, title: s.title };
  });
  return {
    planned,
    anchorSummary: anchorDistribution([...sources.values()].map(s => s.markdown), host),
    warnings: reviewBatch(
      [...sources.entries()].map(([, s]) => ({ title: s.title, markdown: s.markdown })),
      host,
      connections.map(c => c.siteIdentifier),
    ),
    respinRefusedFor: req.respin ? planned.filter(p => !respinAllowedFor(p.connectionType)).map(p => p.label) : [],
  };
}

/**
 * Retry a failed or blocked post: re-send the stored title/markdown as-is (a respin, when one
 * ran, is already baked into the stored markdown — re-adapting a finished adaptation would
 * drift). The uniqueness gate RE-RUNS: retrying a blocked post with unchanged text finds the
 * same twin and blocks again — that is the point. Fixing the text happens by publishing a
 * corrected post (edit the source, publish again); there is no in-place edit and no override.
 */
export async function retryPost(userId: string, postId: string): Promise<PostRow> {
  const post = await prisma.publishedPost.findFirst({
    where: { id: postId, site: { userId } },
  });
  if (!post) throw new Error("post_not_found");
  if (post.status !== "failed" && post.status !== "blocked") {
    throw new Error("only_failed_or_blocked_posts_can_retry");
  }
  const connection = await prisma.blogConnection.findUnique({ where: { id: post.connectionId } });
  if (!connection) throw new Error("connection_not_found");
  const site = await prisma.site.findUnique({ where: { id: post.siteId }, select: { id: true, url: true, siteId: true } });
  if (!site) throw new Error("site_not_found");

  await prisma.publishedPost.update({ where: { id: post.id }, data: { status: "publishing", error: "", scheduledAt: null } });
  try {
    const updated = await sendPostRow({ ...post, status: "publishing" }, connection, site);
    return toPostRow(updated, connection);
  } catch (e) {
    // sendPostRow does not throw for gate/adapter outcomes; this is a storage-level failure.
    const updated = await prisma.publishedPost.update({
      where: { id: post.id },
      data: { status: "failed", error: e instanceof Error ? e.message : String(e) },
    });
    return toPostRow(updated, connection);
  }
}

/**
 * The respin half of a deferred send, extracted so the scheduler owns WHEN and this owns
 * WHAT: re-check the connection-type gate against today's connection (it may have been
 * retyped since planning), run the adaptation, and bake the result into the stored row — the
 * post row must always hold what was actually sent. On failure the row is marked failed with
 * the honest error and respinUsed is reset: the stored text is the un-adapted source, and a
 * later Retry must not present it as an adaptation.
 */
export async function respinAtSend(
  post: PostDbRow,
  connection: { connectionType: string; platform: string; label: string },
  site: { url: string; siteId: string },
  creds: RespinCreds,
): Promise<{ ok: true; post: PostDbRow } | { ok: false; error: string }> {
  if (!respinAllowedFor(connection.connectionType)) {
    const error = `respin_not_allowed_for_own_satellite: connection "${connection.label}" is ${connection.connectionType} (retyped since planning?); respin is allowed only for external_platform connections`;
    await prisma.publishedPost.update({ where: { id: post.id }, data: { status: "failed", error, respinUsed: false } });
    return { ok: false, error };
  }
  try {
    const result = await respinPost(
      { platform: connection.platform, sourceTitle: post.title, sourceMarkdown: post.markdown, projectDomain: siteHostOf(site.url, site.siteId) },
      creds,
      fetchLLM,
    );
    const updated = await prisma.publishedPost.update({
      where: { id: post.id },
      data: { title: result.title, markdown: result.body },
    });
    // The refreshed row rides along: the caller's in-memory copy still holds the pre-respin
    // text, and sending that would ship the un-adapted source under a respin label.
    return { ok: true, post: updated };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.publishedPost.update({ where: { id: post.id }, data: { status: "failed", error, respinUsed: false } });
    return { ok: false, error };
  }
}

/**
 * Move a scheduled post's due time (the jitter offset is editable by design). Refused for
 * anything that already went through a send: "scheduled" is the only movable status.
 */
export async function reschedulePost(userId: string, postId: string, scheduledAt: Date): Promise<PostRow> {
  const post = await prisma.publishedPost.findFirst({ where: { id: postId, site: { userId } } });
  if (!post) throw new Error("post_not_found");
  if (post.status !== "scheduled") throw new Error("only_scheduled_posts_can_reschedule");
  if (!Number.isFinite(scheduledAt.getTime())) throw new Error("invalid_scheduled_at");
  const updated = await prisma.publishedPost.update({ where: { id: post.id }, data: { scheduledAt } });
  const connection = await prisma.blogConnection.findUnique({ where: { id: post.connectionId }, select: { label: true, platform: true } });
  return toPostRow(updated, connection);
}

// ─── posts list ────────────────────────────────────────────────────────────────

export async function listPosts(
  userId: string,
  siteId: string,
  page = 1,
  pageSize = 50,
): Promise<{ rows: PostRow[]; total: number; page: number; pageSize: number }> {
  const where = { siteId, site: { userId } };
  const [rows, total] = await Promise.all([
    prisma.publishedPost.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { connection: { select: { label: true, platform: true } } },
    }),
    prisma.publishedPost.count({ where }),
  ]);
  return {
    rows: rows.map(p => toPostRow(p, p.connection)),
    total, page, pageSize,
  };
}

/**
 * Anchor distribution across this site's PUBLISHED posts (the network panel on /publishing):
 * anchor → how many of our own posts link the money site with it → which URLs. Reads only
 * stored rows; the same pure aggregation the pre-publish review runs on a batch.
 */
export async function siteAnchorSummary(userId: string, siteId: string): Promise<AnchorSummary> {
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true, siteId: true } });
  if (!site) throw new Error("site_not_found");
  const host = siteHostOf(site.url, site.siteId);
  const posts = await prisma.publishedPost.findMany({
    where: { siteId, status: "published" },
    orderBy: { publishedAt: "desc" },
    take: 500,
    select: { markdown: true },
  });
  return anchorDistribution(posts.map(p => p.markdown), host);
}
