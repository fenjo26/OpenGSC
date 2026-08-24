// Backlink digest + alert logic, kept free of Prisma on purpose.
//
// digest.ts and alertScheduler.ts do the querying and hand plain rows in, so every rule
// below is unit-testable without a database — which matters most for the two rules that
// decide whether the user gets told anything at all:
//
//   1. losses are only ever counted off a run that finished COMPLETE (CONTRACT §4), and
//   2. "this loss is unusual" is judged against the site's own baseline, not a fixed number.
//
// Nothing here reads the current SiteBacklink table to answer "how much is lost": that
// number is a running total and would be re-reported in every digest forever. Losses are
// always counted from SiteBacklinkEvent rows inside the digest window.

import type { BacklinkEventKind } from "@/lib/seo/backlinkTypes";

// ─── Thresholds ───────────────────────────────────────────────────────────────
// Все три числа — из ТЗ T6 («больше обычной за сопоставимый период втрое, или больше
// 5% профиля»; «если истории меньше двух недель, базовой линии нет»).

/** Во сколько раз потеря должна превысить обычную за сопоставимый период. */
export const ANOMALY_RATE_MULTIPLIER = 3;

/** Доля профиля, выше которой потеря аномальна сама по себе, без оглядки на базовую линию. */
export const ANOMALY_PROFILE_SHARE = 0.05;

/** Меньше стольких суточных срезов — базовой линии нет, молчим о аномалиях. */
export const BASELINE_MIN_DAYS = 14;

/** Сколько суток истории берём под базовую линию (нужно ≥ BASELINE_MIN_DAYS). */
export const BASELINE_WINDOW_DAYS = 30;

/** Пол шума. Не из ТЗ — см. отчёт: на профиле, который две недели не терял ничего,
 *  «втрое больше обычного» вырождается в ноль, и одна снятая ссылка становится алертом.
 *  Ниже этого числа потерь не тревожим никогда. */
export const ANOMALY_MIN_LOSSES = 5;

/** Сколько элементов держим в секции (аналог FULL в digest.ts). */
export const SECTION_LIMITS = { favorites: 50, lossDomains: 25 };

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** Суточный срез профиля — строка BacklinkSnapshot, суженная до нужного. */
export interface BacklinkBaselinePoint {
  date: string;            // YYYY-MM-DD
  backlinks: number | null;
}

/** Событие + те поля строки, которые дайджест показывает поимённо. */
export interface BacklinkEventInput {
  id: string;
  siteId: string;
  kind: BacklinkEventKind | string;
  origin: string;          // api | check
  createdAt: Date;
  favorite: boolean;
  urlFrom: string;
  domainFrom: string;
}

/** Прогон выгрузки/проверки — окно времени плюс флаг полноты. */
export interface SyncWindow {
  siteId: string;
  kind: string;            // api | verify
  status: string;          // running | completed | error
  complete: boolean;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface BacklinkDigestInput {
  /** События за окно дайджеста, уже склеенные со своей строкой SiteBacklink. */
  events: BacklinkEventInput[];
  /** Прогоны, пересекающие окно, — по ним определяется происхождение события. */
  syncs: SyncWindow[];
  /** Сайты, у которых есть хотя бы один завершённый полный прогон. */
  completeExportSites: Iterable<string>;
  /** Суточные срезы за BASELINE_WINDOW_DAYS, схлопнутые по дате. */
  snapshots: BacklinkBaselinePoint[];
  periodDays: number;
  limits?: { favorites: number; lossDomains: number };
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

export interface DigestBacklinkLink {
  url: string;
  domain: string;
  what: "lost" | "rel_downgraded" | "target_changed";
}

export interface LossAnomalyVerdict {
  anomalous: boolean;
  /** false — истории меньше двух недель, судить не по чему */
  baselineReady: boolean;
  lost: number;
  /** обычная потеря за сопоставимый период */
  usual: number;
  /** порог, который в итоге вынес вердикт */
  threshold: number;
  /** размер профиля на последнем срезе (0 — неизвестен) */
  profile: number;
  /** какое из двух правил сработало */
  rule: "none" | "rate" | "share" | "both";
  /** во сколько раз потеря выше обычной; "∞" когда обычная = 0 */
  timesLabel: string;
}

export interface DigestBacklinks {
  appeared: number;              // appeared + returned
  lost: number;                  // 0, пока потери считать нельзя
  net: number;
  relDowngraded: number;
  favoriteLost: DigestBacklinkLink[];
  favoriteDowngraded: DigestBacklinkLink[];
  topLossDomains: { domain: string; n: number }[];
  /** false → показываем dglNoFullExport вместо цифр потерь */
  lossesReported: boolean;
  baselineReady: boolean;
  anomaly: LossAnomalyVerdict | null;
  /** есть ли вообще о чём говорить — иначе секция не рисуется */
  hasData: boolean;
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Схлопывает срезы по дате (одна дата может прийти от нескольких провайдеров)
 *  и возвращает их по возрастанию даты. */
function orderedPoints(points: BacklinkBaselinePoint[]): { t: number; v: number }[] {
  const byDate = new Map<string, number>();
  for (const p of points) {
    if (typeof p.backlinks !== "number" || !Number.isFinite(p.backlinks)) continue;
    const t = Date.parse(`${p.date}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    byDate.set(p.date, p.backlinks);
  }
  return [...byDate.entries()]
    .map(([date, v]) => ({ t: Date.parse(`${date}T00:00:00Z`), v }))
    .sort((a, b) => a.t - b.t);
}

/** Суточная скорость потерь по срезам профиля. Рост даёт 0, а не отрицательное число:
 *  нас интересует, сколько ссылок обычно уходит, а не чистая дельта. Разрыв в датах
 *  делится на количество суток, иначе пропущенный день выглядит как всплеск. */
export function dailyLossRates(points: BacklinkBaselinePoint[]): number[] {
  const pts = orderedPoints(points);
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = Math.max(1, Math.round((pts[i].t - pts[i - 1].t) / DAY_MS));
    out.push(Math.max(0, pts[i - 1].v - pts[i].v) / gap);
  }
  return out;
}

/** Размер профиля на последнем срезе; 0 — если срезов нет. */
export function latestProfileSize(points: BacklinkBaselinePoint[]): number {
  const pts = orderedPoints(points);
  return pts.length ? pts[pts.length - 1].v : 0;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Аномальна ли потеря. Правило из ТЗ: «больше обычной за сопоставимый период втрое,
 * или больше 5% профиля — что жёстче».
 *
 * «Что жёстче» читается как «строже судит», а не «выше порог»: срабатывает любое из
 * двух правил, то есть эффективный порог — меньший из двух. Иначе критерий приёмки
 * «потеря 6% профиля при ровной истории → срабатывает» невыполним: при ровной истории
 * 6% профиля обычно не дотягивают до утроенной нормы, и правило про 5% никогда бы
 * не сработало — то есть существовало бы впустую.
 */
export function detectLossAnomaly(input: {
  lost: number;
  periodDays: number;
  snapshots: BacklinkBaselinePoint[];
}): LossAnomalyVerdict {
  const lost = Math.max(0, input.lost);
  const days = Math.max(1, input.periodDays);
  const profile = latestProfileSize(input.snapshots);
  const rates = dailyLossRates(input.snapshots);
  const historyDays = orderedPoints(input.snapshots).length;

  const idle: LossAnomalyVerdict = {
    anomalous: false, baselineReady: false, lost, usual: 0,
    threshold: 0, profile, rule: "none", timesLabel: "—",
  };
  // Меньше двух недель истории — базовой линии нет. Показываем числа, но молчим о аномалии.
  if (historyDays < BASELINE_MIN_DAYS || !rates.length) return idle;

  const usual = median(rates) * days;
  const rateThreshold = usual * ANOMALY_RATE_MULTIPLIER;
  const shareThreshold = profile * ANOMALY_PROFILE_SHARE;

  // ≥ для нормы («всплеск ровно втрое» из критериев приёмки — уже всплеск),
  // > для доли профиля («больше 5%»).
  const byRate = lost > 0 && lost >= rateThreshold;
  // Доля профиля — это пол для крупной потери, а не отдельный фиксированный порог:
  // сайт, который штатно теряет 7% профиля в неделю, не должен получать алерт каждую
  // неделю. Поэтому правило про 5% требует ещё и превышения собственной нормы.
  const byShare = profile > 0 && lost > shareThreshold && lost > usual;
  const anomalous = lost >= ANOMALY_MIN_LOSSES && (byRate || byShare);
  const rule = byRate && byShare ? "both" : byRate ? "rate" : byShare ? "share" : "none";
  const threshold = rule === "both" ? Math.min(rateThreshold, shareThreshold)
    : rule === "rate" ? rateThreshold
    : rule === "share" ? shareThreshold
    : profile > 0 ? Math.min(rateThreshold, shareThreshold) : rateThreshold;

  return {
    anomalous, baselineReady: true, lost, usual: round1(usual),
    threshold: round1(threshold), profile, rule: anomalous ? rule : "none",
    timesLabel: usual > 0 ? String(round1(lost / usual)) : "∞",
  };
}

// ─── Происхождение события ────────────────────────────────────────────────────

/**
 * Можно ли по этому событию делать вывод о потере.
 *
 * Прямой связи event → sync в схеме нет, поэтому прогон определяется по времени:
 * событие принадлежит прогону, в чьё окно [startedAt, finishedAt] попал его createdAt.
 * Событие, чей прогон не найден или оказался частичным, в подсчёт потерь не идёт —
 * ошибаться здесь надо в сторону молчания (CONTRACT §4).
 */
export function lossCountsForEvent(
  ev: { siteId: string; createdAt: Date },
  syncs: SyncWindow[],
  now: Date = new Date(),
): boolean {
  const t = ev.createdAt.getTime();
  for (const s of syncs) {
    if (s.siteId !== ev.siteId) continue;
    const from = s.startedAt.getTime();
    // Прогон ещё идёт — окно открыто до текущего момента. Секунда допуска на то,
    // что finishedAt проставляется после последней записи события.
    const to = (s.finishedAt ? s.finishedAt.getTime() : now.getTime()) + 1000;
    if (t >= from && t <= to) return s.complete;
  }
  return false;
}

// ─── Сборка секции ────────────────────────────────────────────────────────────

const APPEARED_KINDS = new Set(["appeared", "returned"]);

const domainOf = (ev: BacklinkEventInput): string => {
  if (ev.domainFrom) return ev.domainFrom;
  try { return new URL(ev.urlFrom).hostname.replace(/^www\./, ""); } catch { return ev.urlFrom; }
};

export function buildBacklinkDigest(input: BacklinkDigestInput, now: Date = new Date()): DigestBacklinks {
  const limits = input.limits ?? SECTION_LIMITS;
  const complete = new Set(input.completeExportSites);

  // Появления безопасны при любой полноте прогона: частичная выгрузка может добавить
  // строки, но не выдумать их. Потери — нет, поэтому у них два фильтра.
  const appearedEvents = input.events.filter(e => APPEARED_KINDS.has(String(e.kind)));
  const lostEvents = input.events.filter(e =>
    String(e.kind) === "lost"
    && complete.has(e.siteId)
    && lossCountsForEvent(e, input.syncs, now),
  );
  // Порча rel фильтром полноты не режется: downgrade рождается сравнением старого
  // значения с новым на уже существующей строке — частичный прогон его не выдумает.
  const downgradeEvents = input.events.filter(e => String(e.kind) === "rel_downgraded");

  const byDomain = new Map<string, number>();
  for (const e of lostEvents) {
    const d = domainOf(e);
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }

  const link = (e: BacklinkEventInput, what: DigestBacklinkLink["what"]): DigestBacklinkLink =>
    ({ url: e.urlFrom, domain: domainOf(e), what });

  const appeared = appearedEvents.length;
  const lost = lostEvents.length;
  const lossesReported = complete.size > 0;
  const anomaly = lossesReported
    ? detectLossAnomaly({ lost, periodDays: input.periodDays, snapshots: input.snapshots })
    : null;

  return {
    appeared,
    lost,
    net: appeared - lost,
    relDowngraded: downgradeEvents.length,
    favoriteLost: lostEvents.filter(e => e.favorite).map(e => link(e, "lost")).slice(0, limits.favorites),
    favoriteDowngraded: downgradeEvents.filter(e => e.favorite).map(e => link(e, "rel_downgraded")).slice(0, limits.favorites),
    topLossDomains: [...byDomain.entries()]
      .map(([domain, n]) => ({ domain, n }))
      .sort((a, b) => b.n - a.n || a.domain.localeCompare(b.domain))
      .slice(0, limits.lossDomains),
    lossesReported,
    baselineReady: anomaly?.baselineReady ?? false,
    anomaly,
    hasData: input.events.length > 0 || input.syncs.length > 0 || lossesReported,
  };
}
