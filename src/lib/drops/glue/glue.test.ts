import test from "node:test";
import assert from "node:assert/strict";

import { buildGluePlan } from "./generate";
import { parsePage } from "./parse";
import { validateCluster } from "./validate";
import { checkLocale, sameUrl } from "./locale";
import type { GluePage, PageFetch } from "./types";

const DROP = "https://justrentaroom.co.uk/";
const MONEY = "https://betninja.sbs/betninja-gb/";

function head(page: GluePage): string {
  return `<html lang="${page.htmlLang}"><head>${page.head}</head><body></body></html>`;
}

function fetched(url: string, html: string, over: Partial<PageFetch> = {}): PageFetch {
  return { requestedUrl: url, finalUrl: url, status: 200, html, ...over };
}

/* ------------------------------------------------------------------ */
/* locale                                                              */
/* ------------------------------------------------------------------ */

test("коды локалей: регион приводится к верхнему регистру", () => {
  assert.equal(checkLocale("en-gb").value, "en-GB");
  assert.equal(checkLocale("ZH-hans-cn").value, "zh-Hans-CN");
});

test("типовые ошибки распознаются с подсказкой", () => {
  assert.equal(checkLocale("en-UK").suggestion, "en-GB");
  assert.equal(checkLocale("gr").suggestion, "el");
  assert.equal(checkLocale("jp").suggestion, "ja");
  assert.equal(checkLocale("ua").suggestion, "uk");
});

test("x-default валиден, мусор — нет", () => {
  assert.equal(checkLocale("x-default").valid, true);
  assert.equal(checkLocale("english").valid, false);
  assert.equal(checkLocale("").valid, false);
});

test("sameUrl игнорирует хвостовой слэш и хеш, но не www", () => {
  assert.equal(sameUrl("https://a.com/x", "https://a.com/x/#top"), true);
  assert.equal(sameUrl("https://a.com", "https://www.a.com"), false);
  assert.equal(sameUrl("https://a.com/x", "http://a.com/x"), false);
});

/* ------------------------------------------------------------------ */
/* generate                                                            */
/* ------------------------------------------------------------------ */

test("funnel: канoникал мани-страницы ведёт на дроп, дроп каноничен сам себе", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [{ hreflang: "en-gb", url: MONEY }],
  });
  const [drop, money] = plan.pages;
  assert.equal(drop.role, "drop");
  assert.equal(drop.canonical, DROP);
  assert.equal(drop.htmlLang, "en");
  assert.equal(money.canonical, DROP);
  assert.equal(money.htmlLang, "en-GB");
  assert.ok(plan.notes.some((n) => n.code === "funnel_mode"));
});

test("cluster: каждая страница каноничена сама себе", () => {
  const plan = buildGluePlan({
    mode: "cluster",
    dropUrl: DROP,
    alternates: [{ hreflang: "en-GB", url: MONEY }],
  });
  assert.equal(plan.pages[1].canonical, MONEY);
});

test("набор alternate одинаков на всех страницах и содержит self-ссылку", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [
      { hreflang: "en-GB", url: MONEY },
      { hreflang: "el-GR", url: "https://betninja.sbs/betninja-gr/" },
    ],
  });
  const sets = plan.pages.map((p) => p.alternates.map((a) => `${a.hreflang}|${a.url}`).join(","));
  assert.equal(new Set(sets).size, 1);
  for (const page of plan.pages.filter((p) => p.role === "money")) {
    assert.ok(page.alternates.some((a) => sameUrl(a.url, page.url)));
  }
});

test("дубль локали — блокер, вторая запись не попадает в план", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [
      { hreflang: "en-GB", url: MONEY },
      { hreflang: "en-gb", url: "https://betninja.sbs/other/" },
    ],
  });
  assert.ok(plan.notes.some((n) => n.code === "locale_duplicate" && n.severity === "blocker"));
  assert.equal(plan.pages.length, 2);
});

test("относительный URL отвергается", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [{ hreflang: "en-GB", url: "/betninja-gb/" }],
  });
  assert.ok(plan.notes.some((n) => n.code === "url_not_absolute"));
});

test("gr правится на el и попадает в план уже исправленным", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [{ hreflang: "gr", url: "https://betninja.sbs/gr/" }],
  });
  assert.equal(plan.pages[1].alternates[0].hreflang, "el");
  assert.ok(plan.notes.some((n) => n.code === "locale_fixed"));
});

/* ------------------------------------------------------------------ */
/* parse                                                               */
/* ------------------------------------------------------------------ */

test("парсер достаёт lang, canonical, alternate и robots", () => {
  const facts = parsePage(
    fetched(
      MONEY,
      `<html lang="en-GB"><head>
        <link rel="canonical" href="${DROP}" />
        <link rel='alternate' hreflang='en-GB' href='${MONEY}'>
        <link rel="alternate" hreflang="x-default" href="${DROP}" />
        <meta name="robots" content="noindex, follow">
      </head></html>`,
    ),
  );
  assert.equal(facts.htmlLang, "en-GB");
  assert.equal(facts.canonical, DROP);
  assert.equal(facts.alternates.length, 2);
  assert.deepEqual(facts.robots, ["noindex", "follow"]);
});

test("закомментированные теги и футер не читаются", () => {
  const facts = parsePage(
    fetched(
      MONEY,
      `<html><head><!-- <link rel="canonical" href="https://evil.tld/" /> --></head>
       <body><link rel="alternate" hreflang="de" href="https://x.tld/de/" /></body></html>`,
    ),
  );
  assert.equal(facts.canonical, null);
  assert.equal(facts.alternates.length, 0);
});

test("относительный href абсолютизируется от финального URL", () => {
  const facts = parsePage(
    fetched("https://betninja.sbs/betninja-gb/", `<html><head><link rel="canonical" href="/en/"></head></html>`),
  );
  assert.equal(facts.canonical, "https://betninja.sbs/en/");
  assert.equal(facts.canonicalRaw, "/en/");
});

test("X-Robots-Tag из заголовка учитывается", () => {
  const facts = parsePage(
    fetched(MONEY, "<html><head></head></html>", { headers: { "x-robots-tag": "noindex" } }),
  );
  assert.deepEqual(facts.robots, ["noindex"]);
});

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

test("сгенерированный funnel-кластер проходит собственный валидатор", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [{ hreflang: "en-GB", url: MONEY }],
  });
  const pages = plan.pages.map((p) => parsePage(fetched(p.url, head(p))));
  const report = validateCluster(pages, { mode: "funnel", plan });
  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  // механика схемы отмечена, но не как ошибка
  assert.ok(report.findings.some((f) => f.code === "hreflang_to_noncanonical" && f.severity === "info"));
});

test("тот же кластер в режиме cluster ловит некононический hreflang как блокер", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [{ hreflang: "en-GB", url: MONEY }],
  });
  const pages = plan.pages.map((p) => parsePage(fetched(p.url, head(p))));
  const report = validateCluster(pages, { mode: "cluster" });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "hreflang_to_noncanonical" && f.severity === "blocker"));
});

test("односторонняя аннотация: мани-страница не ссылается обратно", () => {
  const dropHtml = `<html lang="en"><head>
    <link rel="canonical" href="${DROP}" />
    <link rel="alternate" hreflang="en-GB" href="${MONEY}" />
    <link rel="alternate" hreflang="x-default" href="${DROP}" />
  </head></html>`;
  const moneyHtml = `<html lang="en-GB"><head>
    <link rel="canonical" href="${DROP}" />
    <link rel="alternate" hreflang="en-GB" href="${MONEY}" />
    <link rel="alternate" hreflang="x-default" href="${DROP}" />
  </head></html>`;
  const noBack = moneyHtml.replace(
    `<link rel="alternate" hreflang="x-default" href="${DROP}" />`,
    "",
  );
  const report = validateCluster(
    [parsePage(fetched(DROP, dropHtml)), parsePage(fetched(MONEY, noBack))],
    { mode: "funnel" },
  );
  assert.ok(report.findings.some((f) => f.code === "hreflang_not_reciprocal"));
});

test("схема из поста: блок скопирован без self-ссылки на морду ЕМД", () => {
  // На betninja.sbs/ стоит тот же блок, что и на /betninja-gb/ — сама морда
  // в наборе не перечислена, поэтому в группу она не входит.
  const block = `
    <link rel="canonical" href="${DROP}" />
    <link rel="alternate" hreflang="en-GB" href="${MONEY}" />
    <link rel="alternate" hreflang="x-default" href="${DROP}" />`;
  const pages = [
    parsePage(fetched(DROP, `<html lang="en"><head>${block}</head></html>`)),
    parsePage(fetched(MONEY, `<html lang="en-GB"><head>${block}</head></html>`)),
    parsePage(fetched("https://betninja.sbs/", `<html lang="en"><head>${block}</head></html>`)),
  ];
  const report = validateCluster(pages, { mode: "funnel" });
  const onHome = report.findings.filter((f) => f.page === "https://betninja.sbs/");
  assert.ok(onHome.some((f) => f.code === "hreflang_no_self"));
  assert.equal(report.ok, false);
});

test("мёртвая цель hreflang и noindex на дропе — блокеры", () => {
  const block = `
    <link rel="canonical" href="${DROP}" />
    <link rel="alternate" hreflang="en-GB" href="${MONEY}" />
    <link rel="alternate" hreflang="x-default" href="${DROP}" />`;
  const pages = [
    parsePage(
      fetched(DROP, `<html lang="en"><head>${block}<meta name="robots" content="noindex"></head></html>`),
    ),
    parsePage({ requestedUrl: MONEY, finalUrl: MONEY, status: 404, html: "" }),
  ];
  const report = validateCluster(pages, { mode: "funnel" });
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes("noindex"));
  assert.ok(codes.includes("page_dead"));
  assert.ok(codes.includes("canonical_to_noindex"));
  assert.ok(codes.includes("hreflang_target_dead"));
});

test("цепочка канoникалов ловится", () => {
  const third = "https://third.tld/";
  const pages = [
    parsePage(
      fetched(
        MONEY,
        `<html lang="en-GB"><head>
          <link rel="canonical" href="${DROP}" />
          <link rel="alternate" hreflang="en-GB" href="${MONEY}" />
          <link rel="alternate" hreflang="x-default" href="${DROP}" /></head></html>`,
      ),
    ),
    parsePage(
      fetched(
        DROP,
        `<html lang="en"><head>
          <link rel="canonical" href="${third}" />
          <link rel="alternate" hreflang="en-GB" href="${MONEY}" />
          <link rel="alternate" hreflang="x-default" href="${DROP}" /></head></html>`,
      ),
    ),
  ];
  const report = validateCluster(pages, { mode: "funnel" });
  assert.ok(report.findings.some((f) => f.code === "canonical_chain"));
});

test("редирект вместо страницы отмечается", () => {
  const facts = parsePage({
    requestedUrl: DROP,
    finalUrl: "https://betninja.sbs/",
    status: 200,
    redirectChain: [{ url: DROP, status: 301 }],
    html: `<html lang="en"><head>
      <link rel="canonical" href="https://betninja.sbs/" />
      <link rel="alternate" hreflang="en-GB" href="https://betninja.sbs/" />
      <link rel="alternate" hreflang="x-default" href="https://betninja.sbs/" /></head></html>`,
  });
  const report = validateCluster([facts], { mode: "funnel" });
  assert.ok(report.findings.some((f) => f.code === "page_redirected"));
});

test("сверка с планом ловит подменённый канoникал", () => {
  const plan = buildGluePlan({
    mode: "funnel",
    dropUrl: DROP,
    alternates: [{ hreflang: "en-GB", url: MONEY }],
  });
  const moneyPlanned = plan.pages[1];
  const live = head(moneyPlanned).replace(DROP, "https://someone-else.tld/");
  const pages = [
    parsePage(fetched(plan.pages[0].url, head(plan.pages[0]))),
    parsePage(fetched(moneyPlanned.url, live)),
  ];
  const report = validateCluster(pages, { mode: "funnel", plan });
  assert.ok(report.findings.some((f) => f.code === "canonical_mismatch"));
});
