export interface RelatedIntentMetric {
  query: string;
  url: string;
  date: Date | string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export type PageRole = "homepage" | "product" | "category" | "guide" | "landing" | "other";
export type IntentKind = "informational" | "commercial" | "transactional" | "local" | "mixed";
export type IntentRecommendation = "merge_review" | "differentiate" | "canonical_review" | "internal_linking";

export interface RelatedIntentGroup {
  id: string;
  siteId: string;
  siteName: string;
  primaryQuery: string;
  queries: string[];
  intent: IntentKind;
  confidence: number;
  confidenceLevel: "high" | "medium" | "low";
  recommendation: IntentRecommendation;
  totalImpressions: number;
  totalClicks: number;
  evidence: {
    querySimilarity: number;
    rankingUrlOverlap: number;
    sharedTokens: string[];
    flipFlops: number;
    positionGap: number;
  };
  pages: {
    url: string;
    fullUrl: string;
    role: PageRole;
    queries: string[];
    impressions: number;
    clicks: number;
    ctr: number;
    position: number;
    share: number;
  }[];
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with",
  "и", "в", "во", "на", "по", "для", "из", "от", "до", "как", "что", "це", "та", "у", "за",
  "le", "la", "les", "de", "des", "du", "et", "pour", "un", "une", "en",
  "el", "la", "los", "las", "de", "del", "y", "para", "un", "una", "con",
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "und", "fur", "mit", "von", "zu",
]);

const INTENT_TERMS: Record<Exclude<IntentKind, "mixed">, Set<string>> = {
  informational: new Set(["how", "what", "why", "guide", "tutorial", "learn", "examples", "как", "что", "гайд", "руководство", "comment", "quoi", "guide", "como", "guia", "wie", "ratgeber"]),
  commercial: new Set(["best", "top", "review", "reviews", "compare", "comparison", "versus", "vs", "лучший", "обзор", "сравнение", "meilleur", "avis", "comparatif", "mejor", "resena", "vergleich", "test"]),
  transactional: new Set(["buy", "price", "pricing", "order", "book", "hire", "shop", "купить", "цена", "заказать", "acheter", "prix", "comprar", "precio", "kaufen", "preis"]),
  local: new Set(["near", "nearby", "local", "map", "рядом", "поблизости", "cerca", "proche", "lokal", "nahe"]),
};

function cleanText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function intentTokens(query: string): string[] {
  const words = cleanText(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = words.filter(word => word.length > 1 && !STOPWORDS.has(word));
  // CJK queries often contain no spaces. Character bigrams preserve a useful lexical signal
  // without pretending to be a language model or requiring a new tokenizer dependency.
  for (const word of words) {
    if (!/\p{Script=Han}/u.test(word) || [...word].length < 3) continue;
    const chars = [...word];
    for (let index = 0; index < chars.length - 1; index++) tokens.push(chars.slice(index, index + 2).join(""));
  }
  return [...new Set(tokens)];
}

export function siteBrandTerms(siteUrl: string): string[] {
  const host = siteUrl.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];
  return host.split(".").slice(0, -1).map(cleanText).filter(term => term.length > 2);
}

function weightedJaccard(left: Set<string>, right: Set<string>, weights: Map<string, number>): number {
  const union = new Set([...left, ...right]);
  let intersectionWeight = 0;
  let unionWeight = 0;
  for (const token of union) {
    const weight = weights.get(token) ?? 1;
    unionWeight += weight;
    if (left.has(token) && right.has(token)) intersectionWeight += weight;
  }
  return unionWeight ? intersectionWeight / unionWeight : 0;
}

function setJaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / union.size;
}

function inferIntent(tokens: Set<string>): IntentKind {
  const scores = Object.entries(INTENT_TERMS).map(([intent, terms]) => ({
    intent: intent as Exclude<IntentKind, "mixed">,
    score: [...tokens].filter(token => terms.has(token)).length,
  })).sort((a, b) => b.score - a.score);
  return scores[0]?.score ? scores[0].intent : "mixed";
}

export function inferPageRole(url: string, queries: string[]): PageRole {
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = url.toLowerCase(); }
  if (path === "/" || path === "") return "homepage";
  const joined = `${path} ${queries.join(" ").toLowerCase()}`;
  if (/(\/blog\/|\/guide|\/guides|\/article|\/learn|\/resources|how-to|tutorial|руковод)/.test(joined)) return "guide";
  if (/(\/product|\/products|\/shop|\/store|\/buy|\/pricing|\/price|купить|цена)/.test(joined)) return "product";
  if (/(\/category|\/categories|\/catalog|\/collection|\/tag\/)/.test(joined)) return "category";
  if (/(\/landing|\/lp\/|\/service|\/solutions)/.test(joined)) return "landing";
  return "other";
}

type PageAggregate = { impressions: number; clicks: number; weightedPosition: number; weightedCtr: number; queries: Map<string, number> };
type Profile = {
  query: string;
  normalized: string;
  tokens: Set<string>;
  pages: Map<string, PageAggregate>;
  daily: Map<string, Map<string, { impressions: number; position: number }>>;
  totalImpressions: number;
  totalClicks: number;
};
type Edge = { left: string; right: string; lexical: number; urlOverlap: number; sharedTokens: string[] };

class UnionFind {
  private parent = new Map<string, string>();
  add(value: string) { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    const parent = this.parent.get(value) ?? value;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
  union(left: string, right: string) { this.parent.set(this.find(right), this.find(left)); }
}

function flipFlops(profile: Profile): number {
  const dates = [...profile.daily.keys()].sort();
  let previous = "";
  let flips = 0;
  for (const date of dates) {
    const winner = [...(profile.daily.get(date)?.entries() ?? [])]
      .sort((a, b) => b[1].impressions - a[1].impressions || a[1].position - b[1].position)[0]?.[0] ?? "";
    if (winner && previous && winner !== previous) flips++;
    if (winner) previous = winner;
  }
  return flips;
}

function slugSimilarity(left: string, right: string): number {
  const tokens = (url: string) => {
    try { return new Set(intentTokens(new URL(url).pathname)); } catch { return new Set(intentTokens(url)); }
  };
  return setJaccard(tokens(left), tokens(right));
}

export function buildRelatedIntentGroups(
  metrics: RelatedIntentMetric[],
  options: { siteId: string; siteName: string; brandTerms?: string[]; minImpressions?: number; limit?: number },
): RelatedIntentGroup[] {
  const profiles = new Map<string, Profile>();
  const brands = (options.brandTerms ?? []).map(cleanText).filter(Boolean);

  for (const row of metrics) {
    if (!row.query || !row.url) continue;
    const normalized = cleanText(row.query);
    if (!normalized || brands.some(brand => normalized.includes(brand))) continue;
    let profile = profiles.get(normalized);
    if (!profile) {
      profile = { query: row.query.trim(), normalized, tokens: new Set(intentTokens(row.query)), pages: new Map(), daily: new Map(), totalImpressions: 0, totalClicks: 0 };
      profiles.set(normalized, profile);
    }
    const impressions = Math.max(0, row.impressions || 0);
    const clicks = Math.max(0, row.clicks || 0);
    const page = profile.pages.get(row.url) ?? { impressions: 0, clicks: 0, weightedPosition: 0, weightedCtr: 0, queries: new Map() };
    page.impressions += impressions;
    page.clicks += clicks;
    page.weightedPosition += (row.position || 0) * Math.max(1, impressions);
    page.weightedCtr += (row.ctr || 0) * Math.max(1, impressions);
    page.queries.set(profile.query, (page.queries.get(profile.query) ?? 0) + impressions);
    profile.pages.set(row.url, page);
    profile.totalImpressions += impressions;
    profile.totalClicks += clicks;

    const date = new Date(row.date).toISOString().slice(0, 10);
    const daily = profile.daily.get(date) ?? new Map();
    const dailyPage = daily.get(row.url) ?? { impressions: 0, position: 0 };
    const previousWeight = Math.max(1, dailyPage.impressions);
    dailyPage.position = dailyPage.impressions
      ? ((dailyPage.position * previousWeight) + ((row.position || 0) * Math.max(1, impressions))) / (previousWeight + Math.max(1, impressions))
      : row.position || 0;
    dailyPage.impressions += impressions;
    daily.set(row.url, dailyPage);
    profile.daily.set(date, daily);
  }

  const active = [...profiles.values()].filter(profile => profile.totalImpressions >= 3 && profile.tokens.size > 0);
  const documentFrequency = new Map<string, number>();
  const tokenIndex = new Map<string, string[]>();
  const urlIndex = new Map<string, string[]>();
  for (const profile of active) {
    for (const token of profile.tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      const list = tokenIndex.get(token) ?? [];
      list.push(profile.normalized);
      tokenIndex.set(token, list);
    }
    for (const url of profile.pages.keys()) {
      const list = urlIndex.get(url) ?? [];
      list.push(profile.normalized);
      urlIndex.set(url, list);
    }
  }
  const weights = new Map([...documentFrequency].map(([token, count]) => [token, Math.log((active.length + 1) / (count + 1)) + 1]));
  const profileById = new Map(active.map(profile => [profile.normalized, profile]));
  const candidateKeys = new Set<string>();
  const addCandidateList = (ids: string[]) => {
    if (ids.length > 200) return;
    for (let left = 0; left < ids.length; left++) for (let right = left + 1; right < ids.length; right++) {
      const pair = [ids[left], ids[right]].sort();
      candidateKeys.add(`${pair[0]}\u0000${pair[1]}`);
    }
  };
  for (const ids of tokenIndex.values()) addCandidateList(ids);
  for (const ids of urlIndex.values()) addCandidateList(ids);

  const edges: Edge[] = [];
  for (const key of candidateKeys) {
    const [leftId, rightId] = key.split("\u0000");
    const left = profileById.get(leftId);
    const right = profileById.get(rightId);
    if (!left || !right) continue;
    const lexical = weightedJaccard(left.tokens, right.tokens, weights);
    const urlOverlap = setJaccard(new Set(left.pages.keys()), new Set(right.pages.keys()));
    const sharedTokens = [...left.tokens].filter(token => right.tokens.has(token));
    if (!(lexical >= 0.45 || (lexical >= 0.2 && urlOverlap >= 0.25) || (sharedTokens.length > 0 && urlOverlap >= 0.66))) continue;
    edges.push({ left: leftId, right: rightId, lexical, urlOverlap, sharedTokens });
  }

  const union = new UnionFind();
  for (const edge of edges) { union.add(edge.left); union.add(edge.right); union.union(edge.left, edge.right); }
  const clusters = new Map<string, Set<string>>();
  for (const edge of edges) {
    const root = union.find(edge.left);
    const cluster = clusters.get(root) ?? new Set<string>();
    cluster.add(edge.left); cluster.add(edge.right);
    clusters.set(root, cluster);
  }

  const groups: RelatedIntentGroup[] = [];
  for (const ids of clusters.values()) {
    const clusterProfiles = [...ids].map(id => profileById.get(id)!).filter(Boolean)
      .sort((a, b) => b.totalImpressions - a.totalImpressions).slice(0, 12);
    if (clusterProfiles.length < 2) continue;
    const selectedIds = new Set(clusterProfiles.map(profile => profile.normalized));
    const totalImpressions = clusterProfiles.reduce((sum, profile) => sum + profile.totalImpressions, 0);
    if (totalImpressions < (options.minImpressions ?? 30)) continue;

    const pageMap = new Map<string, PageAggregate>();
    for (const profile of clusterProfiles) for (const [url, page] of profile.pages) {
      const aggregate = pageMap.get(url) ?? { impressions: 0, clicks: 0, weightedPosition: 0, weightedCtr: 0, queries: new Map() };
      aggregate.impressions += page.impressions;
      aggregate.clicks += page.clicks;
      aggregate.weightedPosition += page.weightedPosition;
      aggregate.weightedCtr += page.weightedCtr;
      aggregate.queries.set(profile.query, (aggregate.queries.get(profile.query) ?? 0) + page.impressions);
      pageMap.set(url, aggregate);
    }
    const pages = [...pageMap.entries()].map(([url, page]) => ({
      url,
      page,
      share: totalImpressions ? page.impressions / totalImpressions : 0,
      position: page.weightedPosition / Math.max(1, page.impressions),
    })).filter(item => item.share >= 0.08).sort((a, b) => b.page.impressions - a.page.impressions);
    if (pages.length < 2) continue;
    const positionGap = Math.abs(pages[0].position - pages[1].position);
    if (positionGap > 25) continue;

    const clusterEdges = edges.filter(edge => selectedIds.has(edge.left) && selectedIds.has(edge.right));
    const querySimilarity = Math.max(...clusterEdges.map(edge => edge.lexical), 0);
    const rankingUrlOverlap = Math.max(...clusterEdges.map(edge => edge.urlOverlap), 0);
    const sharedTokens = [...new Set(clusterEdges.flatMap(edge => edge.sharedTokens))].slice(0, 12);
    const flips = clusterProfiles.reduce((sum, profile) => sum + flipFlops(profile), 0);
    const balance = Math.min(1, pages[1].share / Math.max(0.01, pages[0].share));
    const positionProximity = Math.max(0, 1 - positionGap / 25);
    const confidence = Math.max(0, Math.min(100, Math.round(querySimilarity * 45 + rankingUrlOverlap * 20 + balance * 15 + positionProximity * 10 + Math.min(1, flips / 3) * 10)));
    if (confidence < 40) continue;

    // Intent markers such as "what" / «как» are stop words for similarity, but meaningful here.
    // Classify from the unfiltered normalized words so removing noise from clustering does not
    // erase the evidence used to explain the cluster.
    const classificationTokens = new Set(clusterProfiles.flatMap(profile => profile.normalized.split(/\s+/).filter(Boolean)));
    const intent = inferIntent(classificationTokens);
    const pageResults = pages.map(({ url, page, share, position }) => {
      const queries = [...page.queries.entries()].sort((a, b) => b[1] - a[1]).map(([query]) => query);
      return {
        url: (() => { try { return new URL(url).pathname || "/"; } catch { return url; } })(),
        fullUrl: url,
        role: inferPageRole(url, queries),
        queries,
        impressions: page.impressions,
        clicks: page.clicks,
        ctr: Math.round((page.weightedCtr / Math.max(1, page.impressions)) * 1000) / 10,
        position: Math.round(position * 10) / 10,
        share: Math.round(share * 1000) / 10,
      };
    });
    const roleSet = new Set(pageResults.slice(0, 3).map(page => page.role));
    const topShare = pageResults[0]?.share ?? 0;
    const similarSlugs = slugSimilarity(pageResults[0].fullUrl, pageResults[1].fullUrl) >= 0.65;
    const recommendation: IntentRecommendation = roleSet.size > 1
      ? "differentiate"
      : querySimilarity >= 0.78 && similarSlugs
        ? "canonical_review"
        : querySimilarity >= 0.72 && balance >= 0.55
          ? "merge_review"
          : topShare >= 65 && flips === 0
            ? "internal_linking"
            : "differentiate";

    const primary = clusterProfiles[0].query;
    groups.push({
      id: `${options.siteId}:${clusterProfiles.map(profile => profile.normalized).sort().join("|")}`,
      siteId: options.siteId,
      siteName: options.siteName,
      primaryQuery: primary,
      queries: clusterProfiles.map(profile => profile.query),
      intent,
      confidence,
      confidenceLevel: confidence >= 75 ? "high" : confidence >= 55 ? "medium" : "low",
      recommendation,
      totalImpressions,
      totalClicks: clusterProfiles.reduce((sum, profile) => sum + profile.totalClicks, 0),
      evidence: {
        querySimilarity: Math.round(querySimilarity * 100),
        rankingUrlOverlap: Math.round(rankingUrlOverlap * 100),
        sharedTokens,
        flipFlops: flips,
        positionGap: Math.round(positionGap * 10) / 10,
      },
      pages: pageResults,
    });
  }

  return groups.sort((left, right) => right.confidence - left.confidence || right.totalImpressions - left.totalImpressions)
    .slice(0, Math.max(1, options.limit ?? 60));
}
