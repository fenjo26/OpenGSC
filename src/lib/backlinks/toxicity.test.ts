import test from "node:test";
import assert from "node:assert/strict";

import {
  BL_STRUCT_SIGNALS,
  classifyDonor,
  inOwnNiche,
  isExactCommercialAnchor,
  overOptimization,
  parseNiche,
  serializeNiche,
  suggestNicheFromText,
  type DonorInput,
  type DonorLink,
} from "./toxicity";

const SITE = { domainFrom: "spam-donor.example", siteDomain: "vladcasino.example" } as const;

function link(overrides: Partial<DonorLink> = {}): DonorLink {
  return {
    apiAnchor: "",
    checkAnchor: "",
    pageTitle: "",
    apiSnippet: "",
    apiDr: null,
    apiContent: true,
    ...overrides,
  };
}

function donor(links: DonorLink[], niche: readonly string[] = [], extra: Partial<DonorInput> = {}): DonorInput {
  return { domainFrom: SITE.domainFrom, siteDomain: SITE.siteDomain, ownNiche: niche, links, ...extra };
}

/* ------------------------------------------------------------------ */
/* ниша (CONTRACT §0.1 — главная ловушка волны)                         */
/* ------------------------------------------------------------------ */

test("элемент ниши покрывает группу целиком и как префикс до «_»", () => {
  assert.ok(inOwnNiche(["gambling"], "gambling_zh"));
  assert.ok(inOwnNiche(["gambling"], "gambling_id"));
  assert.ok(inOwnNiche(["gambling"], "gambling_generic"));
  assert.ok(inOwnNiche(["gambling"], "gambling"));
  assert.ok(inOwnNiche(["gambling_zh"], "gambling_zh"));
  assert.equal(inOwnNiche(["gambling_zh"], "gambling_id"), false);
  assert.equal(inOwnNiche(["gambling"], "pharma"), false);
  assert.equal(inOwnNiche([""], "pharma"), false);
});

test("parseNiche терпит мусор и не выдумывает нишу", () => {
  assert.deepEqual(parseNiche(null), []);
  assert.deepEqual(parseNiche(""), []);
  assert.deepEqual(parseNiche("not json"), []);
  assert.deepEqual(parseNiche('{"ownNiche":null}'), []);
  assert.deepEqual(parseNiche('{"ownNiche":["gambling"," adult ",""]}'), ["gambling", "adult"]);
  assert.deepEqual(parseNiche(serializeNiche(["gambling"])), ["gambling"]);
});

test("предложение ниши находит группы маркеров в тексте сайта", () => {
  const groups = suggestNicheFromText("Casino slots — jackpot φαρμακείο viagra");
  assert.ok(groups.includes("gambling_generic"), String(groups));
  assert.ok(groups.includes("pharma"), String(groups));
  assert.deepEqual(suggestNicheFromText("Plain local bakery"), []);
});

/* ------------------------------------------------------------------ */
/* классификация донора — своя ниша не токсичность                      */
/* ------------------------------------------------------------------ */

test("казино-анкор на гемблинг-сайте чистый, без ниши — токсичный", () => {
  const links = [link({ apiAnchor: "situs judi slot gacor", pageTitle: "Bandar Judi Online Togel" })];
  const withNiche = classifyDonor(donor(links, ["gambling"]));
  assert.equal(withNiche.level, "clean");
  assert.equal(withNiche.score, 0);
  assert.deepEqual(withNiche.signals, []);

  const withoutNiche = classifyDonor(donor(links));
  assert.equal(withoutNiche.level, "toxic");
  assert.ok(withoutNiche.signals.includes("anchor_gambling_id"), JSON.stringify(withoutNiche.signals));
  assert.ok(withoutNiche.signals.includes("gambling_id"), JSON.stringify(withoutNiche.signals));
});

test("anchor_-двойники групп ниши тоже подавляются", () => {
  const links = [link({ apiAnchor: "casino slots jackpot" })]; // gambling_generic (casino/slot/jackpot)
  const withNiche = classifyDonor(donor(links, ["gambling"]));
  assert.equal(withNiche.level, "clean");
  assert.ok(classifyDonor(donor(links)).signals.includes("anchor_gambling_generic"));
});

test("фарма-анкор на гемблинг-сайте токсичен", () => {
  const links = [link({ apiAnchor: "buy viagra cialis online" })];
  const verdict = classifyDonor(donor(links, ["gambling"]));
  assert.equal(verdict.level, "toxic");
  assert.ok(verdict.signals.includes("anchor_pharma"));
});

test("адалт-титул донора токсичен; ниша подавляет только свои группы", () => {
  const links = [link({ pageTitle: "Escort camgirl porn videos" })];
  assert.equal(classifyDonor(donor(links)).level, "toxic");
  // ниша «adult» подавляет adult-группу, но фарма остаётся: 45 в титулe → suspicious, анкор был бы toxic
  const pharma = classifyDonor(donor([link({ pageTitle: "Online pharmacy viagra" })], ["adult"]));
  assert.equal(pharma.level, "suspicious");
  assert.ok(pharma.signals.includes("pharma"));
  assert.equal(classifyDonor(donor([link({ pageTitle: "Escort porn" })], ["adult"])).level, "clean");
});

test("чужая письменность анкора относительно зоны сайта", () => {
  const cjkAnchor = classifyDonor(donor([link({ apiAnchor: "米乐老虎机官方" })], ["gambling"]));
  // китайские Gambling-слова подавлены нишей, но письменность остаётся чужой для .example-сайта
  assert.ok(cjkAnchor.signals.includes("anchor_alien_script"), JSON.stringify(cjkAnchor.signals));
  assert.equal(cjkAnchor.level, "suspicious");

  // а для сайта в китайской зоне та же письменность родная
  const native = classifyDonor(donor([link({ apiAnchor: "米乐老虎机官方" })], ["gambling"], { siteDomain: "casino.cn" }));
  assert.equal(native.level, "clean");
});

test("чужая письменность в титулe донора", () => {
  const verdict = classifyDonor(donor([link({ pageTitle: "Онлайн казино бесплатно" })], ["gambling"]));
  assert.ok(verdict.signals.includes("alien_script"), JSON.stringify(verdict.signals));
});

/* ------------------------------------------------------------------ */
/* структурные сигналы                                                  */
/* ------------------------------------------------------------------ */

test("sitewide-помойка: DR 2 и 40 ссылок → минимум suspicious", () => {
  const links = Array.from({ length: 40 }, () => link({ apiDr: 2, apiAnchor: "click" }));
  const verdict = classifyDonor(donor(links));
  assert.equal(verdict.level, "suspicious");
  assert.ok(verdict.signals.includes("sitewide_low_dr"));
});

test("DR 2 но мало ссылок — не помойка", () => {
  const verdict = classifyDonor(donor([link({ apiDr: 2, apiAnchor: "click" }), link({ apiDr: 2, apiAnchor: "here" })]));
  assert.equal(verdict.signals.includes("sitewide_low_dr"), false);
});

test("все ссылки вне контента и их ≥ 10", () => {
  const links = Array.from({ length: 12 }, () => link({ apiContent: false, apiAnchor: "visit" }));
  const verdict = classifyDonor(donor(links));
  assert.ok(verdict.signals.includes("out_of_content"));
});

test("домен-парковка по титулу", () => {
  const verdict = classifyDonor(donor([link({ pageTitle: "This domain is for sale", apiAnchor: "link" })]));
  assert.ok(verdict.signals.includes("donor_parked"));
  assert.equal(verdict.level, "suspicious");
});

/* ------------------------------------------------------------------ */
/* unknown ≠ clean                                                      */
/* ------------------------------------------------------------------ */

test("нет анкора и титула → unknown, а не clean", () => {
  const verdict = classifyDonor(donor([link({ apiDr: 30 })]));
  assert.equal(verdict.level, "unknown");
  assert.equal(verdict.score, 0);
  assert.deepEqual(verdict.signals, []);
});

test("структурный сигнал сам по себе — данные, verdict не unknown", () => {
  const links = Array.from({ length: 25 }, () => link({ apiDr: 1 }));
  const verdict = classifyDonor(donor(links));
  assert.equal(verdict.level, "suspicious");
});

/* ------------------------------------------------------------------ */
/* глубокая проверка                                                    */
/* ------------------------------------------------------------------ */

test("данные глубокой проверки участвуют в вердикте", () => {
  const links = [link({ apiAnchor: "read more" })]; // сам по себе чистый
  const local = classifyDonor(donor(links));
  assert.equal(local.level, "clean");
  const deep = classifyDonor(donor(links, [], { deepTitle: "Togel Gacor Maxwin Bandar" }));
  assert.equal(deep.level, "toxic");
  assert.ok(deep.signals.includes("gambling_id"));
});

test("список структурных сигналов зафиксирован", () => {
  assert.deepEqual([...BL_STRUCT_SIGNALS], ["sitewide_low_dr", "out_of_content", "donor_parked"]);
});

/* ------------------------------------------------------------------ */
/* переоптимизация профиля                                              */
/* ------------------------------------------------------------------ */

test("точный коммерческий анкор: эвристика", () => {
  assert.ok(isExactCommercialAnchor("buy cheap viagra", "site.example"));
  assert.ok(isExactCommercialAnchor("заказать доставку цветов", "site.example"));
  assert.equal(isExactCommercialAnchor("https://site.example/page", "site.example"), false);
  assert.equal(isExactCommercialAnchor("site.example", "site.example"), false);
  assert.equal(isExactCommercialAnchor("vladcasino best price", "vladcasino.example"), false); // бренд сайта
  assert.equal(isExactCommercialAnchor("read more", "site.example"), false);
});

test("переоптимизация: доля выше 30% и минимум анкоров", () => {
  const domain = "shop.example";
  const commercial = Array.from({ length: 5 }, () => "best price buy now");
  const neutral = Array.from({ length: 7 }, () => "read more here");
  const over = overOptimization([...commercial, ...neutral.slice(0, 5)], domain);
  assert.equal(over.checked, 10);
  assert.equal(over.exact, 5);
  assert.equal(over.pct, 50);
  assert.equal(over.over, true);

  // ровно 30% — порог «выше 30%», не «30 и выше»
  const atThirty = overOptimization([...commercial.slice(0, 3), ...neutral], domain);
  assert.equal(atThirty.checked, 10);
  assert.equal(atThirty.pct, 30);
  assert.equal(atThirty.over, false);
  assert.equal(overOptimization(["best price"], domain).over, false); // мало анкоров — не судим
});
