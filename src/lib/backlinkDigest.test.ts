import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBacklinkDigest, detectLossAnomaly, dailyLossRates, lossCountsForEvent,
  ANOMALY_MIN_LOSSES, BASELINE_MIN_DAYS,
  type BacklinkBaselinePoint, type BacklinkEventInput, type SyncWindow,
} from "./backlinkDigest";

const DAY = 86_400_000;
const NOW = new Date("2026-08-24T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Ровная история: профиль `start`, каждый день уходит ровно `perDay` ссылок. */
const flatHistory = (days: number, start: number, perDay: number): BacklinkBaselinePoint[] =>
  Array.from({ length: days }, (_, i) => ({
    date: iso(ago(days - 1 - i)),
    backlinks: start - perDay * i,
  }));

const ev = (o: Partial<BacklinkEventInput> = {}): BacklinkEventInput => ({
  id: "e1", siteId: "s1", kind: "lost", origin: "api", createdAt: ago(1),
  favorite: false, urlFrom: "https://donor.com/post", domainFrom: "donor.com", ...o,
});

const sync = (o: Partial<SyncWindow> = {}): SyncWindow => ({
  siteId: "s1", kind: "api", status: "completed", complete: true,
  startedAt: ago(2), finishedAt: new Date(NOW), ...o,
});

// ─── Задача 2: детектор аномалии ──────────────────────────────────────────────

test("ровная история: потеря на уровне нормы не считается аномалией", () => {
  // 20 суток по 10 потерянных ссылок в день, профиль ~5000 → норма за 7 дней = 70.
  const v = detectLossAnomaly({ lost: 70, periodDays: 7, snapshots: flatHistory(20, 5000, 10) });
  assert.equal(v.baselineReady, true);
  assert.equal(v.usual, 70);
  assert.equal(v.anomalous, false);
  assert.equal(v.rule, "none");
});

test("всплеск втрое срабатывает", () => {
  const v = detectLossAnomaly({ lost: 210, periodDays: 7, snapshots: flatHistory(20, 5000, 10) });
  assert.equal(v.anomalous, true);
  assert.equal(v.rule, "rate");
  assert.equal(v.timesLabel, "3");
});

test("история короче двух недель — базовой линии нет, молчим", () => {
  const short = flatHistory(BASELINE_MIN_DAYS - 1, 5000, 10);
  const v = detectLossAnomaly({ lost: 5000, periodDays: 7, snapshots: short });
  assert.equal(v.baselineReady, false);
  assert.equal(v.anomalous, false);
});

test("потеря 6% профиля при ровной истории срабатывает, даже не дотянув до утроенной нормы", () => {
  // норма 28/сутки → 196 за 7 дней, утроенная = 588. 6% профиля (5000) = 300 < 588,
  // но правило про долю профиля судит строже и срабатывает само.
  const v = detectLossAnomaly({ lost: 300, periodDays: 7, snapshots: flatHistory(20, 5000, 28) });
  assert.equal(v.anomalous, true);
  assert.equal(v.rule, "share");
});

test("мелкая потеря на профиле, который никогда ничего не терял, не будит никого", () => {
  const still = flatHistory(20, 5000, 0);
  const quiet = detectLossAnomaly({ lost: ANOMALY_MIN_LOSSES - 1, periodDays: 7, snapshots: still });
  assert.equal(quiet.anomalous, false);
  const loud = detectLossAnomaly({ lost: ANOMALY_MIN_LOSSES, periodDays: 7, snapshots: still });
  assert.equal(loud.anomalous, true);
  assert.equal(loud.timesLabel, "∞");
});

test("пропущенный день в срезах не превращается во всплеск нормы", () => {
  const pts: BacklinkBaselinePoint[] = [
    { date: "2026-08-01", backlinks: 1000 },
    { date: "2026-08-04", backlinks: 970 },  // −30 за трое суток = 10/сутки
  ];
  assert.deepEqual(dailyLossRates(pts), [10]);
});

test("рост профиля даёт нулевую, а не отрицательную скорость потерь", () => {
  assert.deepEqual(dailyLossRates([
    { date: "2026-08-01", backlinks: 1000 },
    { date: "2026-08-02", backlinks: 1100 },
  ]), [0]);
});

// ─── Задача 3: молчать, пока нет полной выгрузки ──────────────────────────────

test("без завершённой полной выгрузки секция потерь пуста, а появления показываются", () => {
  const d = buildBacklinkDigest({
    events: [
      ev({ id: "a", kind: "appeared" }),
      ev({ id: "b", kind: "returned" }),
      ev({ id: "c", kind: "lost" }),
      ev({ id: "d", kind: "lost", favorite: true }),
    ],
    syncs: [sync({ complete: false, status: "completed" })],
    completeExportSites: [],
    snapshots: flatHistory(20, 5000, 10),
    periodDays: 7,
  }, NOW);

  assert.equal(d.lossesReported, false);
  assert.equal(d.lost, 0);
  assert.deepEqual(d.favoriteLost, []);
  assert.deepEqual(d.topLossDomains, []);
  assert.equal(d.anomaly, null);
  assert.equal(d.appeared, 2);
  assert.equal(d.net, 2);
});

test("события частичного прогона в подсчёт потерь не идут, а его появления идут", () => {
  const partial = sync({ complete: false, startedAt: ago(3), finishedAt: ago(2) });
  const full = sync({ complete: true, startedAt: ago(1), finishedAt: ago(0.5) });
  const d = buildBacklinkDigest({
    events: [
      ev({ id: "p1", kind: "lost", createdAt: ago(2.5) }),      // внутри частичного
      ev({ id: "p2", kind: "appeared", createdAt: ago(2.5) }),  // тоже, но появление
      ev({ id: "f1", kind: "lost", createdAt: ago(0.7) }),      // внутри полного
    ],
    syncs: [partial, full],
    completeExportSites: ["s1"],
    snapshots: flatHistory(20, 5000, 10),
    periodDays: 7,
  }, NOW);

  assert.equal(d.lost, 1);
  assert.equal(d.appeared, 1);
  assert.equal(lossCountsForEvent({ siteId: "s1", createdAt: ago(2.5) }, [partial, full], NOW), false);
  assert.equal(lossCountsForEvent({ siteId: "s1", createdAt: ago(0.7) }, [partial, full], NOW), true);
});

test("событие, чей прогон не найден, к потерям не приписывается", () => {
  assert.equal(lossCountsForEvent({ siteId: "s1", createdAt: ago(9) }, [sync()], NOW), false);
  assert.equal(lossCountsForEvent({ siteId: "other", createdAt: ago(1) }, [sync()], NOW), false);
});

// ─── Задача 1: избранные — поимённо ───────────────────────────────────────────

test("потеря одной избранной ссылки попадает в дайджест поимённо", () => {
  const d = buildBacklinkDigest({
    events: [
      ev({ id: "f", kind: "lost", favorite: true, urlFrom: "https://big.example/review", domainFrom: "big.example" }),
      ...Array.from({ length: 30 }, (_, i) => ev({ id: `n${i}`, kind: "lost", urlFrom: `https://cheap.example/${i}`, domainFrom: "cheap.example" })),
    ],
    syncs: [sync()],
    completeExportSites: ["s1"],
    snapshots: flatHistory(20, 5000, 10),
    periodDays: 7,
  }, NOW);

  assert.equal(d.lost, 31);
  assert.deepEqual(d.favoriteLost, [{ url: "https://big.example/review", domain: "big.example", what: "lost" }]);
  // Дорогая ссылка не утонула в агрегате даже при 30 дешёвых потерях рядом.
  assert.equal(d.topLossDomains[0].domain, "cheap.example");
});

test("порча избранной ссылки в nofollow идёт отдельной строкой и без фильтра полноты", () => {
  const d = buildBacklinkDigest({
    events: [
      ev({ id: "r", kind: "rel_downgraded", favorite: true, urlFrom: "https://big.example/review" }),
      ev({ id: "r2", kind: "rel_downgraded" }),
    ],
    syncs: [sync({ complete: false })],
    completeExportSites: ["s1"],
    snapshots: [],
    periodDays: 7,
  }, NOW);

  assert.equal(d.relDowngraded, 2);
  assert.deepEqual(d.favoriteDowngraded.map(l => l.url), ["https://big.example/review"]);
});

test("пустая секция помечается hasData=false и не рисуется", () => {
  const d = buildBacklinkDigest({
    events: [], syncs: [], completeExportSites: [], snapshots: [], periodDays: 7,
  }, NOW);
  assert.equal(d.hasData, false);
});
