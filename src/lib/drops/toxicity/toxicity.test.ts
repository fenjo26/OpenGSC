import test from "node:test";
import assert from "node:assert/strict";

import { classifyDomain, classifySnapshot, needsDeepCheck, parseCdxTimestamp, recencyFactor } from "./classify";
import { isParked, matchMarkers, scanDomainName, scriptsOf } from "./markers";
import { buildCdxUrl, extractMetaRefresh, extractTextSample, extractTitle, parseCdxJson, rawSnapshotUrl, usableRows } from "./cdx";

const NOW = new Date("2026-09-19T00:00:00Z");

/* ------------------------------------------------------------------ */
/* письменности и маркеры                                              */
/* ------------------------------------------------------------------ */

test("два иероглифа считаются, даже если латиницы больше", () => {
  // ровно тот титул, который чужой чекер посчитал чистым
  assert.ok(scriptsOf("mile米乐·m6(中国区)官方网站").includes("cjk"));
});

test("английский титул не даёт чужих письменностей", () => {
  assert.deepEqual(scriptsOf("Hub City Boxing Club - Training in Hamilton"), ["latin"]);
});

test("сильные и общие маркеры гембла разведены по весу", () => {
  const strong = matchMarkers("Situs Togel Gacor Maxwin");
  assert.equal(strong[0].group.code, "gambling_id");
  assert.equal(strong[0].group.weight, 60);

  const generic = matchMarkers("Casino on Wheels - Mobile Casino Party Rental");
  assert.equal(generic[0].group.code, "gambling_generic");
  assert.equal(generic[0].group.weight, 25);
});

test("паркинг и заглушки распознаются", () => {
  assert.ok(isParked("没有找到站点"));
  assert.ok(isParked("This domain is for sale"));
  assert.ok(isParked("Welcome to nginx!"));
  assert.equal(isParked("Hub City Boxing Club"), false);
});

/* ------------------------------------------------------------------ */
/* свежесть                                                            */
/* ------------------------------------------------------------------ */

test("свежий флип весит больше давнего", () => {
  assert.equal(recencyFactor("20250324", NOW), 1);
  assert.equal(recencyFactor("20220101", NOW), 0.6);
  assert.equal(recencyFactor("20150101", NOW), 0.35);
});

test("метка CDX разбирается и с временем, и без", () => {
  assert.equal(parseCdxTimestamp("20240617120000")?.getUTCFullYear(), 2024);
  assert.equal(parseCdxTimestamp("20240617")?.getUTCMonth(), 5);
  assert.equal(parseCdxTimestamp("мусор"), null);
});

/* ------------------------------------------------------------------ */
/* домены со скриншота                                                 */
/* ------------------------------------------------------------------ */

test("clarenvillecaribous.com: чужой чекер сказал ЧИСТО, этот говорит toxic", () => {
  const report = classifyDomain(
    {
      domain: "clarenvillecaribous.com",
      snapshots: [
        { timestamp: "20240617", title: "mile米乐·m6(中国区)官方网站" },
        { timestamp: "20241204", title: "九游会老哥必备的交流社区_老哥俱乐部" },
        { timestamp: "20250123", title: "利来w66_来利国际旗舰" },
      ],
    },
    { now: NOW },
  );
  assert.equal(report.verdict, "toxic");
  const codes = report.signals.map((s) => s.code);
  assert.ok(codes.includes("gambling_zh"));
  assert.ok(codes.includes("alien_script"));
});

test("hubcityboxingclub.com: флип языка + гембл + паркинг в последнем снимке", () => {
  const report = classifyDomain(
    {
      domain: "hubcityboxingclub.com",
      snapshots: [
        { timestamp: "20250324", title: "乐动网页版_乐动(中国)" },
        { timestamp: "20250711", title: "", redirectTo: "https://www.hubcityboxingclub.com/" },
        { timestamp: "20260208", title: "没有找到站点" },
      ],
    },
    { now: NOW },
  );
  assert.equal(report.verdict, "toxic");
  assert.ok(report.perSnapshot[2].parked);
  // редирект на самого себя (www) не считается уходом на чужой хост
  assert.equal(report.signals.some((s) => s.code === "redirect_offsite"), false);
});

/* ------------------------------------------------------------------ */
/* поведение вердикта                                                  */
/* ------------------------------------------------------------------ */

test("чистая история остаётся чистой", () => {
  const report = classifyDomain(
    {
      domain: "edslamprecycling.com",
      snapshots: [
        { timestamp: "20230410", title: "Ed's Lamp Recycling - Commercial Lamp & Ballast Disposal" },
        { timestamp: "20240822", title: "Ed's Lamp Recycling - Services" },
        { timestamp: "20251102", title: "Ed's Lamp Recycling - Contact" },
      ],
    },
    { now: NOW },
  );
  assert.equal(report.verdict, "clean");
  assert.equal(report.score, 0);
});

test("легальный casino-бизнес не становится токсичным по одному слову", () => {
  const report = classifyDomain(
    {
      domain: "casinoonwheels.de",
      snapshots: [
        { timestamp: "20240101", title: "Casino on Wheels - Mobiles Casino für Firmenfeiern" },
        { timestamp: "20250601", title: "Casino on Wheels - Preise" },
      ],
    },
    { now: NOW },
  );
  assert.equal(report.verdict, "suspicious");
  assert.ok(needsDeepCheck(report), "спорные уходят в платный AI-проход, а не в отсев");
});

test("китайский сайт в китайской зоне — не чужая письменность", () => {
  const cn = classifyDomain(
    { domain: "example.cn", snapshots: [{ timestamp: "20250101", title: "上海某某贸易有限公司" }] },
    { now: NOW },
  );
  assert.equal(cn.signals.some((s) => s.code === "alien_script"), false);
  assert.equal(cn.verdict, "clean");
});

test("смена письменности между снимками ловится отдельным сигналом", () => {
  const report = classifyDomain(
    {
      domain: "someshop.de",
      snapshots: [
        { timestamp: "20200101", title: "Möbelhaus Schmidt - Ihr Möbelhaus in Bremen" },
        { timestamp: "20250101", title: "ロト宝くじオンライン" },
      ],
    },
    { now: NOW },
  );
  assert.ok(report.signals.some((s) => s.code === "language_flip"));
});

test("одни заглушки — это empty, а не clean", () => {
  const report = classifyDomain(
    {
      domain: "neverused.com",
      snapshots: [
        { timestamp: "20210101", title: "Buy this domain" },
        { timestamp: "20240101", title: "Under construction" },
      ],
    },
    { now: NOW },
  );
  assert.equal(report.verdict, "empty");
  assert.equal(report.neverUsed, true);
});

test("нет снимков — empty, но не neverUsed", () => {
  const report = classifyDomain({ domain: "nothing.com", snapshots: [] }, { now: NOW });
  assert.equal(report.verdict, "empty");
  assert.equal(report.neverUsed, false);
  assert.ok(needsDeepCheck(report));
});

test("редирект на чужой хост — сигнал", () => {
  const v = classifySnapshot(
    { timestamp: "20250711", title: "", redirectTo: "https://slot-gacor.example/" },
    "hubcityboxingclub.com",
  );
  assert.ok(v.signals.some((s) => s.code === "redirect_offsite"));
});

/* ------------------------------------------------------------------ */
/* CDX                                                                 */
/* ------------------------------------------------------------------ */

test("limit отрицательный — иначе вернутся первые снимки", () => {
  const url = new URL(buildCdxUrl("example.com", { last: 3 }));
  assert.equal(url.searchParams.get("limit"), "-3");
  assert.equal(url.searchParams.get("collapse"), "digest");
  assert.equal(url.searchParams.get("fastLatest"), "true");
});

test("collapse по году задаётся явно", () => {
  const url = new URL(buildCdxUrl("example.com", { last: 5, collapseTimestamp: 4 }));
  assert.equal(url.searchParams.get("collapse"), "timestamp:4");
});

test("сырой снимок берётся с суффиксом id_", () => {
  assert.equal(
    rawSnapshotUrl("20250324", "http://example.com/"),
    "https://web.archive.org/web/20250324id_/http://example.com/",
  );
});

test("разбор CDX: заголовок пропускается, revisit-строки сохраняются", () => {
  const rows = parseCdxJson([
    ["timestamp", "original", "statuscode", "mimetype", "digest", "length"],
    ["20250324120000", "http://example.com/", "200", "text/html", "ABC", "1200"],
    ["20250711090000", "http://example.com/", "-", "text/html", "ABC", "1200"],
    ["20260208110000", "http://example.com/", "404", "text/html", "DEF", "300"],
  ]);
  assert.equal(rows.length, 3);
  assert.equal(usableRows(rows).length, 2);
  assert.equal(rows[0].length, 1200);
});

test("пустой ответ CDX не ломает разбор", () => {
  assert.deepEqual(parseCdxJson([]), []);
  assert.deepEqual(parseCdxJson(null), []);
});

test("титул, текст и meta refresh достаются из снимка", () => {
  const html = `<html lang="zh-CN"><head><title>利来w66_来利国际旗舰</title>
    <meta http-equiv="refresh" content="0; url=/go.html"></head>
    <body><script>var a=1;</script><p>欢迎光临</p></body></html>`;
  assert.equal(extractTitle(html), "利来w66_来利国际旗舰");
  assert.equal(extractTextSample(html).includes("欢迎光临"), true);
  assert.equal(extractTextSample(html).includes("var a"), false);
  assert.equal(extractMetaRefresh(html, "http://example.com/"), "http://example.com/go.html");
});

test("html-сущности в титуле декодируются до матчинга", () => {
  assert.equal(extractTitle("<title>Slot&#32;Gacor &amp; Togel</title>"), "Slot Gacor & Togel");
  const report = classifyDomain(
    { domain: "x.de", snapshots: [{ timestamp: "20250101", title: "Slot Gacor & Togel" }] },
    { now: NOW },
  );
  assert.equal(report.verdict, "toxic");
});

test("скан по имени ловит слитные названия без единого запроса", () => {
  assert.deepEqual(scanDomainName("situsumatoto.com")[0].code, "gambling_id");
  // а вот kudetabet98calljackpot.com по имени НЕ ловится: "bet" подстрокой брать нельзя,
  // иначе в .de зоне отвалится каждый betreuung/werbetechnik. Такие едут в проверку снапшотов.
  assert.deepEqual(scanDomainName("kudetabet98calljackpot.com"), []);
  assert.deepEqual(scanDomainName("betreuung-pflege-kafurke.de"), []);
  assert.deepEqual(scanDomainName("hubcityboxingclub.com"), []);
  // общие слова из имени не берутся: слишком много ложных
  assert.deepEqual(scanDomainName("casinoonwheels.de"), []);
});

test("скан по имени не ловит легальные имена с коллизиями", () => {
  assert.deepEqual(scanDomainName("judith-meyer-design.de"), []);
  assert.deepEqual(scanDomainName("reliabledeposits.org"), []);
  assert.deepEqual(scanDomainName("keswickpharmacy.com"), []);
});
