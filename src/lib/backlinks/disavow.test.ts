import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDisavowFile,
  disavowDomain,
  disavowFileName,
  disavowReason,
  type DisavowDonor,
  type DisavowLink,
} from "./disavow";

const NOW = new Date("2026-11-02T12:00:00Z");

function link(overrides: Partial<DisavowLink> = {}): DisavowLink {
  return {
    id: "l1",
    urlFrom: "https://spam.example/page",
    domainFrom: "spam.example",
    disavow: true,
    disavowNote: "",
    toxLevel: "toxic",
    toxSignals: ["pharma"],
    ...overrides,
  };
}

function donor(overrides: Partial<DisavowDonor> = {}): DisavowDonor {
  return { domain: "spam.example", marked: [link()], total: 1, ...overrides };
}

/* ------------------------------------------------------------------ */

test("пустой список → только заголовок", () => {
  const file = buildDisavowFile("example.com", [], { now: NOW });
  assert.equal(
    file,
    "# OpenGSC disavow file for example.com — generated 2026-11-02\n" +
      "# Upload: https://search.google.com/search-console/disavow-links\n",
  );
});

test("полностью отмеченный донор → domain: с комментарием-причиной из сигналов", () => {
  const file = buildDisavowFile("example.com", [donor()], { now: NOW });
  const lines = file.split("\n");
  assert.equal(lines[2], "# toxic · pharma · 1 link(s)");
  assert.equal(lines[3], "domain:spam.example");
});

test("заметка оператора важнее сигналов", () => {
  const d = donor({ marked: [link({ disavowNote: "paid links 2024", toxSignals: ["pharma", "anchor_adult"] })] });
  const { level, reason } = disavowReason(d.marked);
  assert.equal(level, "toxic");
  assert.equal(reason, "paid links 2024");
  assert.ok(buildDisavowFile("example.com", [d], { now: NOW }).includes("# toxic · paid links 2024 · 1 link(s)"));
});

test("частично отмеченный донор → отдельные URL даже в доменном режиме", () => {
  const marked = [
    link({ id: "a", urlFrom: "https://spam.example/a" }),
    link({ id: "b", urlFrom: "https://spam.example/b" }),
  ];
  const file = buildDisavowFile("example.com", [donor({ marked, total: 5 })], { now: NOW });
  assert.ok(!file.includes("domain:spam.example"), file);
  assert.ok(file.includes("https://spam.example/a"));
  assert.ok(file.includes("https://spam.example/b"));
});

test("режим «отдельные URL» разворачивает и полностью отмеченных доноров", () => {
  const file = buildDisavowFile("example.com", [donor()], { now: NOW, mode: "urls" });
  assert.ok(!file.includes("domain:spam.example"), file);
  assert.ok(file.includes("https://spam.example/page"));
});

test("неотмеченные ссылки не попадают в файл", () => {
  const d = donor({ marked: [link({ disavow: false })] });
  const file = buildDisavowFile("example.com", [d], { now: NOW });
  assert.equal((file.match(/\n/g)?.length ?? 0), 2); // только заголовок
});

test("домен нормализуется: схема, www и путь уходят", () => {
  assert.equal(disavowDomain("https://www.Spam.Example/whatever"), "spam.example");
  assert.equal(disavowDomain("spam.example"), "spam.example");
});

test("уровень unknown у ручной отметки подписывается как manual", () => {
  const d = donor({ marked: [link({ toxLevel: "unknown", toxSignals: [] })] });
  assert.ok(buildDisavowFile("example.com", [d], { now: NOW }).includes("# manual · manual · 1 link(s)"));
});

test("имя файла: disavow-<host>-<date>.txt", () => {
  assert.equal(disavowFileName("https://www.example.com/x", NOW), "disavow-example.com-2026-11-02.txt");
  assert.equal(disavowFileName("", NOW), "disavow-site-2026-11-02.txt");
});

test("сортировка: токсичные доноры выше подозрительных, дальше по домену", () => {
  const donors: DisavowDonor[] = [
    donor({ domain: "zzz.example", marked: [link({ toxLevel: "suspicious" })] }),
    donor({ domain: "bbb.example", marked: [link({ toxLevel: "toxic" })] }),
    donor({ domain: "aaa.example", marked: [link({ toxLevel: "toxic" })] }),
  ];
  const file = buildDisavowFile("example.com", donors, { now: NOW });
  const order = file.split("\n").filter(l => l.startsWith("domain:"));
  assert.deepEqual(order, ["domain:aaa.example", "domain:bbb.example", "domain:zzz.example"]);
});
