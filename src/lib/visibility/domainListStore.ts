// R+, Wave A — storage side of the per-category domain lists the citation classifier consults
// as an overlay on its built-in defaults. The operator's main market is Greece; without local
// domains half the citations fall into "other", and the whole point of the classification cut
// is answering WHO crowds us out. The lists live in InstanceSetting under one JSON key
// (`aeo_domain_lists`) because 4–9 short lists do not justify a table, and a file in the repo
// would need a deploy per edit — editing without a deploy is the requirement (plan §7.4).
//
// Instance-wide, not per-site: the classifier's built-in defaults are global, and the overlay
// corrects the same blind spot (a national market) for every site on the instance.
//
// No schema change: the InstanceSetting table predates this wave, same as the sentiment toggle
// (sentimentStore.ts) this module mirrors — read gracefully before any data, sanitize on write.

import { prisma } from "@/lib/prisma";
import {
  OVERLAY_CATEGORIES, normalizeOverlayHost,
  type ExtraDomainLists,
} from "@/lib/seo/aeoCitationClassify";

const KEY = "aeo_domain_lists";
// A category's list is hand-curated market knowledge; past a hundred entries the operator is
// scraping, not curating, and every saved check would re-classify against all of them.
const MAX_PER_CATEGORY = 100;

/** Clean the lists the UI (or MCP) sends: each entry normalized exactly the way the classifier
 *  normalizes cited hosts (normalizeOverlayHost — same module, so the two cannot drift),
 *  invalid entries dropped, duplicates collapsed, unknown categories ignored. Pure, so the
 *  editor can preview the effect of a save and the test suite can pin the rules. */
export function sanitizeDomainLists(raw: unknown): ExtraDomainLists {
  const out: ExtraDomainLists = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const category of OVERLAY_CATEGORIES) {
    const list = source[category];
    if (!Array.isArray(list)) continue;
    const hosts: string[] = [];
    for (const item of list) {
      const host = normalizeOverlayHost(item);
      if (host && !hosts.includes(host)) hosts.push(host);
      if (hosts.length >= MAX_PER_CATEGORY) break;
    }
    if (hosts.length) out[category] = hosts;
  }
  return out;
}

/** The overlay the read/write classification paths pass into the classifier. Loaded ONCE per
 *  request/check, never per domain. Any failure (no table yet, corrupt JSON) reads as "no
 *  overlay" — classification then runs on the built-in defaults, which is a valid answer, not
 * an error worth failing a report over. */
export async function getAeoDomainLists(): Promise<ExtraDomainLists> {
  try {
    const row = await prisma.instanceSetting.findUnique({ where: { key: KEY } });
    if (!row?.value) return {};
    return sanitizeDomainLists(JSON.parse(row.value));
  } catch {
    return {};
  }
}

export async function saveAeoDomainLists(raw: unknown): Promise<ExtraDomainLists> {
  const clean = sanitizeDomainLists(raw);
  // "No lists" is stored as absence, not as "{}" — the same keep-the-table-small rule the
  // sentiment toggle follows. Deleting is also the reset path: clear every category, save.
  if (!Object.keys(clean).length) {
    await prisma.instanceSetting.deleteMany({ where: { key: KEY } });
    return clean;
  }
  await prisma.instanceSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(clean) },
    update: { value: JSON.stringify(clean) },
  });
  return clean;
}
