import test from "node:test";
import assert from "node:assert/strict";

import {
  isLostLink,
  lossFreshness,
  rankRecovery,
  recoveryAction,
  recoveryScore,
  type RecoveryInput,
} from "./recovery";

const NOW = new Date("2026-11-02T12:00:00Z");

function row(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    id: "r1",
    urlFrom: "https://donor.example/post",
    domainFrom: "donor.example",
    urlTo: "https://mine.example/money",
    apiAnchor: "best widgets",
    apiDr: 40,
    apiContent: true,
    apiDofollow: true,
    apiNofollow: false,
    apiSponsored: false,
    apiHttpCode: null,
    apiLost: true,
    checkStatus: "unchecked",
    checkNofollow: false,
    checkSponsored: false,
    checkTargetOk: null,
    pageStatus: "unknown",
    favorite: false,
    lostAt: null,
    relDowngraded: false,
    targetClicks28: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* что считается потерей                                                */
/* ------------------------------------------------------------------ */

test("потеря: apiLost, missing, retarget и даунгрейд rel", () => {
  assert.ok(isLostLink(row()));
  assert.ok(isLostLink(row({ apiLost: false, checkStatus: "missing" })));
  assert.ok(isLostLink(row({ apiLost: false, checkTargetOk: false })));
  assert.ok(isLostLink(row({ apiLost: false, relDowngraded: true })));
  // просто nofollow-ссылка без события даунгрейда — НЕ потеря, иначе таблица утонет
  assert.equal(isLostLink(row({ apiLost: false, apiNofollow: true, apiDofollow: false })), false);
});

/* ------------------------------------------------------------------ */
/* типы действий                                                        */
/* ------------------------------------------------------------------ */

test("page_alive_link_removed: страница жива, ссылки нет", () => {
  assert.equal(recoveryAction(row({ checkStatus: "missing", pageStatus: "alive" })), "page_alive_link_removed");
});

test("page_dead: 404 у донора или по нашей проверке", () => {
  assert.equal(recoveryAction(row({ pageStatus: "dead", checkStatus: "missing" })), "page_dead");
  assert.equal(recoveryAction(row({ apiHttpCode: 404, checkStatus: "missing", pageStatus: "alive" })), "page_dead");
});

test("nofollowed: ссылка на месте, но вес не передаёт", () => {
  assert.equal(
    recoveryAction(row({ apiLost: false, checkStatus: "found", checkNofollow: true })),
    "nofollowed",
  );
  assert.equal(recoveryAction(row({ apiLost: false, relDowngraded: true })), "nofollowed");
});

test("retargeted: ведёт не на ту страницу", () => {
  assert.equal(
    recoveryAction(row({ apiLost: false, checkStatus: "found", checkTargetOk: false })),
    "retargeted",
  );
});

test("unknown: Ahrefs говорит «потеряна», нашей проверки не было", () => {
  assert.equal(recoveryAction(row({})), "unknown");
});

/* ------------------------------------------------------------------ */
/* оценка                                                               */
/* ------------------------------------------------------------------ */

test("формула: DR-вес × dofollow × контент × ценность × свежесть × избранное", () => {
  // DR 40, dofollow, in-content, 0 кликов, потеря сегодня, не избранная → 0.4 × 1 × 1 × 1 × 1 × 1
  assert.equal(recoveryScore(row({ lostAt: NOW.toISOString() }), NOW), 0.4);
  // избранная ×1.5
  assert.equal(recoveryScore(row({ favorite: true, lostAt: NOW.toISOString() }), NOW), 0.6);
  // nofollow ×0.3
  assert.equal(
    recoveryScore(row({ apiNofollow: true, apiDofollow: false, lostAt: NOW.toISOString() }), NOW),
    0.12,
  );
  // вне контента ×0.5
  assert.equal(recoveryScore(row({ apiContent: false, lostAt: NOW.toISOString() }), NOW), 0.2);
  // ценность цели: 99 кликов за 28 дней → 1 + log10(100) = 3
  assert.equal(recoveryScore(row({ targetClicks28: 99, lostAt: NOW.toISOString() }), NOW), 1.2);
  // минимальный DR-вес 0.05 при null
  assert.equal(recoveryScore(row({ apiDr: null, lostAt: NOW.toISOString() }), NOW), 0.05);
});

test("свежесть: ≤30 дней — 1, ≤90 — 0.6, дальше — 0.3, неизвестно — 0.6", () => {
  const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  assert.equal(lossFreshness(iso(3), NOW), 1);
  assert.equal(lossFreshness(iso(70), NOW), 0.6);
  assert.equal(lossFreshness(iso(200), NOW), 0.3);
  assert.equal(lossFreshness(null, NOW), 0.6);
  assert.equal(lossFreshness("garbage", NOW), 0.6);
});

/* ------------------------------------------------------------------ */
/* порядок                                                              */
/* ------------------------------------------------------------------ */

test("порядок по оценке: свежая ссылка на денежную страницу выше старой футерной", () => {
  const ranked = rankRecovery(
    [
      row({ id: "old-footer", apiDr: 30, apiContent: false, lostAt: new Date("2025-01-01").toISOString() }),
      row({ id: "fresh-money", apiDr: 30, targetClicks28: 500, lostAt: NOW.toISOString() }),
      row({ id: "not-lost", apiLost: false }),
    ],
    NOW,
  );
  assert.deepEqual(ranked.map(r => r.id), ["fresh-money", "old-footer"]);
  assert.ok(ranked[0].score > ranked[1].score);
  // каждый ряд несёт свой тип действия
  assert.equal(ranked[0].action, "unknown");
  assert.equal(ranked[1].action, "unknown");
});

test("каждый тип действия встречается и сортировка стабильна по домену при равной оценке", () => {
  const ranked = rankRecovery(
    [
      row({ id: "removed", checkStatus: "missing", pageStatus: "alive", apiLost: false }),
      row({ id: "dead", pageStatus: "dead" }),
      row({ id: "nofollow", apiLost: false, relDowngraded: true, checkNofollow: true }),
      row({ id: "retarget", checkStatus: "found", checkTargetOk: false, apiLost: false }),
      row({ id: "verify", apiLost: true }),
    ],
    NOW,
  );
  const actions = ranked.map(r => r.action).sort();
  assert.deepEqual(actions, [
    "nofollowed",
    "page_alive_link_removed",
    "page_dead",
    "retargeted",
    "unknown",
  ]);
});
