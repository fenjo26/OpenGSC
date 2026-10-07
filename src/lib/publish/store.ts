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

import { prisma } from "@/lib/prisma";
import { normalizeBacklinkUrl, donorHostOf } from "@/lib/seo/backlinkImport";
import { backlinksNotMigrated } from "@/lib/backlinks/store";
import { mergeSources } from "@/lib/magiclinks/tracking";
import { outlineToMarkdown } from "@/lib/seo/outlineFormat";
import { fetchLLM } from "@/lib/llm";
import { adapterFor } from "./registry";
import { markdownToHtmlBody } from "./markdown";
import { respinPost, type RespinCreds } from "./respin";
import { platformDefById } from "./platforms";
import type { BlogCreds } from "./types";

// ─── connections ───────────────────────────────────────────────────────────────

export interface ConnectionRow {
  id: string;
  siteId: string;
  platform: string;
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
  id: string; siteId: string; platform: string; label: string; siteIdentifier: string;
  status: string; lastError: string; lastVerifiedAt: Date | null; createdAt: Date; credentials: string;
}): ConnectionRow {
  let creds: Record<string, unknown> = {};
  try { creds = typeof c.credentials === "string" && c.credentials ? JSON.parse(c.credentials) : {}; } catch { /* preview stays empty */ }
  const preview: Record<string, string> = {};
  for (const field of platformDefById(c.platform)?.fields ?? []) {
    const v = creds[field.key];
    preview[field.key] = typeof v === "string" ? maskSecret(v) : "";
  }
  return {
    id: c.id, siteId: c.siteId, platform: c.platform, label: c.label, siteIdentifier: c.siteIdentifier,
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
  siteId: string; platform: string; label: string; siteIdentifier: string; credentials: Record<string, string>;
}): Promise<ConnectionRow> {
  const site = await prisma.site.findFirst({ where: { id: input.siteId, userId }, select: { id: true } });
  if (!site) throw new Error("site_not_found");
  if (!platformDefById(input.platform)) throw new Error(`unknown_platform: ${input.platform}`);
  const label = String(input.label || "").trim();
  const siteIdentifier = String(input.siteIdentifier || "").trim();
  if (!label) throw new Error("label_required");
  if (!siteIdentifier) throw new Error("site_identifier_required");
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

// ─── article source ────────────────────────────────────────────────────────────

function firstHeading(markdown: string): string {
  return /^#{1,6}\s+(.+)$/m.exec(markdown || "")?.[1]?.trim() || "";
}

/**
 * SeoHistory.data is JSON.stringify(item.data): for `text` the article string itself, for
 * `landing` an object whose body is `text` (when the landing step wrote one) or an outline to
 * serialize. Returns null when the record carries no publishable body — the caller reports
 * that instead of publishing an empty post.
 */
export function extractPostFromHistory(row: { type: string; keyword: string; data: string }): { title: string; markdown: string } | null {
  let data: unknown;
  try { data = JSON.parse(row.data); } catch { return null; }
  if (row.type === "text" && typeof data === "string" && data.trim()) {
    return { title: firstHeading(data) || row.keyword, markdown: data };
  }
  if (row.type === "landing" && data && typeof data === "object") {
    const obj = data as { text?: unknown; outline?: unknown };
    let markdown = typeof obj.text === "string" && obj.text.trim() ? obj.text : "";
    if (!markdown && obj.outline) markdown = outlineToMarkdown(obj.outline);
    if (markdown.trim()) return { title: firstHeading(markdown) || row.keyword, markdown };
  }
  return null;
}

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
 * urlTo); an existing row only gains "self" in sources — it never touches check*/api*/tox*,
 * which belong to their own writers. Degrades to a no-op before `prisma db push` (the loop
 * simply has nothing to feed yet), same convention as the ledger.
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

export interface PublishRequest {
  siteId: string;
  /** SeoHistory.id to publish; the markdown/title come from the record. */
  historyId?: string;
  /** Manual override / fallback when the history row is not on the server yet. */
  title?: string;
  markdown?: string;
  connectionIds: string[];
  /** One respin (AI) call per platform when true. */
  respin: boolean;
  /** Explicit urlTo for the backlink row; otherwise derived from the post's links. */
  targetUrl?: string;
}

export interface PublishOutcome {
  posts: PostRow[];
  /** Connections that failed before anything was sent (no PublishedPost row exists). */
  failures: { connectionId: string; label: string; error: string }[];
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
}

export function toPostRow(p: {
  id: string; siteId: string; connectionId: string; title: string; status: string; remoteUrl: string;
  remoteId: string; respinUsed: boolean; error: string; publishedAt: Date | null; createdAt: Date; historyId: string | null;
}, connection?: { label: string; platform: string } | null): PostRow {
  return {
    id: p.id, siteId: p.siteId, connectionId: p.connectionId,
    connectionLabel: connection?.label ?? "", platform: connection?.platform ?? "",
    historyId: p.historyId, title: p.title, status: p.status,
    remoteUrl: p.remoteUrl, remoteId: p.remoteId, respinUsed: p.respinUsed,
    error: p.error, publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

async function loadSource(
  userId: string,
  req: PublishRequest,
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

/**
 * Publish one source to N connections of one site. Each connection is independent: a failure
 * (respin included) marks that connection failed and the loop continues — one bad credential
 * must not silently cancel the other three publishes the user asked for.
 */
export async function runPublish(
  userId: string,
  site: { id: string; url: string; siteId: string },
  req: PublishRequest,
  creds: RespinCreds,
): Promise<PublishOutcome> {
  const source = await loadSource(userId, req);
  const connections = await prisma.blogConnection.findMany({
    where: { id: { in: req.connectionIds }, siteId: site.id, site: { userId } },
  });
  if (!connections.length) throw new Error("no_connections: none of those connection ids belong to this site");

  const host = siteHostOf(site.url, site.siteId);
  const out: PublishOutcome = { posts: [], failures: [] };

  for (const connection of connections) {
    try {
      const adapter = adapterFor(connection.platform);
      let title = source.title;
      let markdown = source.markdown;
      let respinUsed = false;
      if (req.respin) {
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
      try {
        const result = await adapter.publish(
          JSON.parse(connection.credentials || "{}") as BlogCreds,
          connection.siteIdentifier,
          { title, markdown, html: markdownToHtmlBody(markdown), tags: [] },
        );
        post = await prisma.publishedPost.update({
          where: { id: post.id },
          data: { status: "published", remoteId: result.remoteId, remoteUrl: result.remoteUrl, error: "", publishedAt: new Date() },
        });
        // Success only: a failed publish has no donor page, and pretending it does would put
        // a dead URL into the checker's queue.
        const target = req.targetUrl?.trim()
          || firstMoneySiteLink(markdown, host)
          || (site.url ? site.url.replace(/\/+$/, "") : "");
        await recordSelfBacklink(site.id, result.remoteUrl, target);
      } catch (e) {
        post = await prisma.publishedPost.update({
          where: { id: post.id },
          data: { status: "failed", error: e instanceof Error ? e.message : String(e) },
        });
      }
      out.posts.push(toPostRow(post, connection));
    } catch (e) {
      // Pre-send failure (unknown platform, respin error): reported, not persisted — there is
      // no honest PublishedPost to show for a call that never left the building.
      out.failures.push({ connectionId: connection.id, label: connection.label, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Retry a failed post: re-send the stored title/markdown as-is (a respin, when one ran, is
 *  already baked into the stored markdown — re-adapting a finished adaptation would drift). */
export async function retryPost(userId: string, postId: string): Promise<PostRow> {
  const post = await prisma.publishedPost.findFirst({
    where: { id: postId, site: { userId } },
  });
  if (!post) throw new Error("post_not_found");
  if (post.status !== "failed") throw new Error("only_failed_posts_can_retry");
  const connection = await prisma.blogConnection.findUnique({ where: { id: post.connectionId } });
  if (!connection) throw new Error("connection_not_found");

  await prisma.publishedPost.update({ where: { id: post.id }, data: { status: "publishing", error: "" } });
  try {
    const adapter = adapterFor(connection.platform);
    const result = await adapter.publish(
      JSON.parse(connection.credentials || "{}") as BlogCreds,
      connection.siteIdentifier,
      { title: post.title, markdown: post.markdown, html: markdownToHtmlBody(post.markdown), tags: [] },
    );
    const updated = await prisma.publishedPost.update({
      where: { id: post.id },
      data: { status: "published", remoteId: result.remoteId, remoteUrl: result.remoteUrl, error: "", publishedAt: new Date() },
    });
    const site = await prisma.site.findUnique({ where: { id: post.siteId }, select: { url: true, siteId: true } });
    const host = site ? siteHostOf(site.url, site.siteId) : "";
    const target = firstMoneySiteLink(post.markdown, host) || (site?.url ? site.url.replace(/\/+$/, "") : "");
    if (site) await recordSelfBacklink(post.siteId, result.remoteUrl, target);
    return toPostRow(updated, connection);
  } catch (e) {
    const updated = await prisma.publishedPost.update({
      where: { id: post.id },
      data: { status: "failed", error: e instanceof Error ? e.message : String(e) },
    });
    return toPostRow(updated, connection);
  }
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
