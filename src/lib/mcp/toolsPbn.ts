// MCP-зеркало PBN-модуля (та же логика, что роуты — агент и кнопка не расходятся).
// Чистое ядро в lib/pbn/*, стадия в lib/pbn/restore.ts; здесь — обёртки инструментов.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { McpTool } from "./shared";
import { assertConfirmed, confirmArg, resolveAiCreds } from "./shared";
import { fetchLLM } from "@/lib/llm";
import { makePbnFetch, prescanDomain, restoreSite, siteDiskDir, applyCampaignToSites, wipeDirIfNewSnapshot, renderPage, linksForPage, type CampaignSite, type GenerateSurrounding, type RenderLink } from "@/lib/pbn/restore";
import { seedFromString, type AnchorSpec, type AnchorShares } from "@/lib/pbn/anchors";
import type { Rel } from "@/lib/pbn/place";
import { buildZip, type ZipEntry } from "@/lib/pbn/zip";
import { residualFootprints } from "@/lib/pbn/clean";
import { createOrGetSite, getSite, listSites, listPages, listLinks, updateSite, replacePages, createCampaign, replaceLinks } from "@/lib/pbn/store";

const KIND = (k: unknown): AnchorSpec["kind"] => (["exact", "brand", "url", "generic"].includes(String(k)) ? (k as AnchorSpec["kind"]) : "generic");

export const PBN_TOOLS: McpTool[] = [
  {
    name: "pbn_prescan",
    cost: "net",
    idempotent: true,
    description: "Scan the Wayback Machine for a drop's snapshots and score them honestly for restore (content-weighted; foreign-brand and parking detected; a domain with no archive returns no_snapshot, never a fabricated score). Free, rides the proxy pool's web.archive.org zone.",
    inputSchema: { type: "object", properties: { domains: { type: "array", items: { type: "string" }, description: "up to 25 domains" } }, required: ["domains"] },
    handler: async (userId, args) => {
      const domains = (Array.isArray(args.domains) ? args.domains : []).filter((d): d is string => typeof d === "string").slice(0, 25);
      if (!domains.length) throw new Error("domains required");
      const fetch = await makePbnFetch(userId);
      const results = [];
      for (const domain of domains) {
        try { const { snapshots, best } = await prescanDomain(domain, fetch); results.push({ domain, best, snapshots }); }
        catch { results.push({ domain, error: "prescan_failed" }); }
      }
      return { results };
    },
  },
  {
    name: "pbn_restore",
    cost: "net",
    idempotent: false,
    description: "Restore one drop from a chosen snapshot to disk (clean HTML, strip trackers/foreign links/archive refs, no footprint markers). Resumable: runs bounded slices until done. Returns { siteId, pagesRestored, pagesFailed, done }.",
    inputSchema: { type: "object", properties: { domain: { type: "string" }, snapshotTimestamp: { type: "string", description: "YYYYMMDDhhmmss" }, pageCap: { type: "number", description: "max pages, default 100" } }, required: ["domain", "snapshotTimestamp"] },
    handler: async (userId, args) => {
      const domain = String(args.domain ?? "").trim().toLowerCase();
      const snapshotTimestamp = String(args.snapshotTimestamp ?? "");
      if (!domain || !/^\d{14}$/.test(snapshotTimestamp)) throw new Error("domain and 14-digit snapshotTimestamp required");
      const pageCap = Number(args.pageCap) || undefined;
      const site = await createOrGetSite(userId, domain);
      const diskDir = siteDiskDir(userId, domain);
      // Как POST /api/pbn/restore: другой снимок аннулирует прежнюю выкачку — чистим каталог,
      // иначе файлы прошлого снимка засчитаются как восстановленные.
      await wipeDirIfNewSnapshot(site.snapshotTimestamp, snapshotTimestamp, diskDir);
      await updateSite(userId, site.id, { status: "fetching", snapshotTimestamp });
      const fetch = await makePbnFetch(userId);
      // Несколько слайсов подряд, но под общим дедлайном — агент получает завершённый сайт чаще.
      const overall = Date.now() + 120_000;
      let last;
      do {
        last = await restoreSite(domain, snapshotTimestamp, diskDir, fetch, { pageCap, deadlineMs: 35_000 });
        await replacePages(site.id, last.pages);
        await updateSite(userId, site.id, {
          status: last.done ? (last.pagesRestored > 0 ? (last.pagesFailed.length ? "partial" : "ready") : "error") : "fetching",
          pagesRequested: last.pagesRequested, pagesRestored: last.pagesRestored,
          pagesFailed: JSON.stringify(last.pagesFailed), cleanedStats: JSON.stringify(last.cleanedStats), diskPath: diskDir,
        });
      } while (!last.done && Date.now() < overall);
      return { siteId: site.id, done: last.done, pagesRestored: last.pagesRestored, pagesFailed: last.pagesFailed, cleanedStats: last.cleanedStats };
    },
  },
  {
    name: "pbn_campaign_apply",
    cost: "paid",
    idempotent: false,
    description: "Apply a bulk money-link campaign to restored sites: anchors by kind-shares (not i%n), each link placed in real page content (never dumped at top of body); where no block fits, an AI sentence is generated in the page's language. PAID (AI credits) — needs confirm: true.",
    inputSchema: { type: "object", properties: {
      targetUrl: { type: "string" },
      anchors: { type: "array", items: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: ["exact", "brand", "url", "generic"] } } } },
      shares: { type: "object", description: "{exact,brand,url,generic} weights" },
      relShares: { type: "object", description: "{dofollow,nofollow,sponsored} weights" },
      siteIds: { type: "array", items: { type: "string" } },
      scope: { type: "string", enum: ["homepage_only", "sitewide_footer", "combo_both"] },
      confirm: confirmArg,
    }, required: ["targetUrl", "anchors", "siteIds"] },
    handler: async (userId, args) => {
      assertConfirmed(args, "pbn_campaign_apply");
      const targetUrl = String(args.targetUrl ?? "").trim();
      const anchors: AnchorSpec[] = (Array.isArray(args.anchors) ? args.anchors : []).map((a): AnchorSpec => ({ text: String((a as AnchorSpec)?.text ?? ""), kind: KIND((a as AnchorSpec)?.kind) })).filter(a => a.text);
      const shares = (args.shares && typeof args.shares === "object" ? args.shares : {}) as AnchorShares;
      const relShares = (args.relShares && typeof args.relShares === "object" ? args.relShares : {}) as Partial<Record<Rel, number>>;
      const siteIds = (Array.isArray(args.siteIds) ? args.siteIds : []).filter((s): s is string => typeof s === "string").slice(0, 500);
      const scope = typeof args.scope === "string" ? args.scope : "homepage_only";
      if (!targetUrl || !siteIds.length) throw new Error("targetUrl and siteIds required");

      const sites: CampaignSite[] = [];
      for (const id of siteIds) { const s = await getSite(userId, id); if (s?.diskPath) sites.push({ siteId: s.id, domain: s.domain, diskDir: siteDiskDir(userId, s.domain) }); }
      if (!sites.length) throw new Error("no restored sites");

      const creds = await resolveAiCreds(userId, args, "dropsHistory");
      let generate: GenerateSurrounding | undefined;
      if (creds.aiApiKey) {
        generate = async (pageText, anchor, lang) => {
          const prompt = `Write exactly ONE natural sentence in the SAME language as the page, containing the literal token {link} where the anchor "${anchor}" goes.${lang ? ` Page lang: ${lang}.` : ""} Reply with the sentence only.\n\n=== page ===\n${pageText.slice(0, 600)}`;
          const r = (await fetchLLM(prompt, creds.aiProvider, creds.aiApiKey, 120, creds.model, creds.aiBaseUrl))?.trim() ?? "";
          return r.includes("{link}") ? r : undefined;
        };
      }
      const campaignId = await createCampaign(userId, { targetUrl, anchors, shares, scope, relShares, siteIds });
      const applied = await applyCampaignToSites(sites, anchors, shares, targetUrl, relShares, seedFromString(campaignId), generate);
      const bySite = new Map<string, typeof applied>();
      for (const a of applied) { const l = bySite.get(a.siteId) ?? []; l.push(a); bySite.set(a.siteId, l); }
      for (const [siteId, links] of bySite) await replaceLinks(siteId, campaignId, links.map(l => ({ ...l, campaignId })));
      return { campaignId, placed: applied.filter(a => a.status === "placed").length, skipped: applied.filter(a => a.status === "skipped").map(a => ({ siteId: a.siteId, reason: a.skipReason })) };
    },
  },
  {
    name: "pbn_site",
    cost: "local",
    idempotent: true,
    description: "List restored PBN sites, or one site's pages and placed links. No argument lists all; { siteId } returns detail.",
    inputSchema: { type: "object", properties: { siteId: { type: "string" } } },
    handler: async (userId, args) => {
      const siteId = typeof args.siteId === "string" ? args.siteId : "";
      if (!siteId) return { sites: await listSites(userId) };
      const site = await getSite(userId, siteId);
      if (!site) throw new Error("site not found");
      return { site, pages: await listPages(siteId), links: await listLinks(siteId) };
    },
  },
  {
    name: "pbn_export_zip",
    cost: "local",
    idempotent: false,
    description: "Write a ready-to-host ZIP of a restored site with the campaign's links rendered into the HTML at export (exactly like the UI's ZIP button — disk files stay pristine), plus bot-shield .htaccess and robots.txt; refuses if any rendered page still carries a footprint (archive.org or injected markers). Returns the file path and size.",
    inputSchema: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] },
    handler: async (userId, args) => {
      const site = await getSite(userId, String(args.siteId ?? ""));
      if (!site?.diskPath) throw new Error("site not restored");
      const root = path.resolve(site.diskPath);
      const files: { rel: string; full: string }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await walk(full);
          else files.push({ rel: path.relative(root, full).split(path.sep).join("/"), full });
        }
      };
      await walk(root);
      // Зеркало /api/pbn/site/:id/zip: ссылки рендерятся в HTML при экспорте (диск чистый),
      // футпринт-гейт проверяет именно отрендеренный HTML. Фильтр linksForPage общий с роутом.
      const links = (await listLinks(String(args.siteId ?? ""))) as unknown as RenderLink[];
      const entries: ZipEntry[] = [];
      for (const f of files) {
        let data = await fs.readFile(f.full);
        if (/\.html?$/i.test(f.rel)) {
          const rendered = renderPage(data.toString("utf8"), linksForPage(links, f.rel));
          const found = residualFootprints(rendered);
          if (found.length) throw new Error(`footprint in ${f.rel}: ${found.join(", ")}`);
          data = Buffer.from(rendered, "utf8");
        }
        entries.push({ path: f.rel, data });
      }
      entries.push({ path: ".htaccess", data: Buffer.from("RewriteEngine On\nRewriteCond %{HTTP_USER_AGENT} (AhrefsBot|SemrushBot|MJ12bot|DotBot|rogerbot|BLEXBot) [NC]\nRewriteRule .* - [F,L]\n") });
      entries.push({ path: "robots.txt", data: Buffer.from("User-agent: AhrefsBot\nDisallow: /\nUser-agent: SemrushBot\nDisallow: /\nUser-agent: MJ12bot\nDisallow: /\n") });
      const zip = buildZip(entries);
      const outPath = path.join(root, "..", `${site.domain}.zip`);
      await fs.writeFile(outPath, zip);
      return { path: outPath, bytes: zip.length, files: entries.length };
    },
  },
];
