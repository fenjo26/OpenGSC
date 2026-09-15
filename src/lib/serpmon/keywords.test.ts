import assert from "node:assert/strict";
import test from "node:test";
import { normaliseKeyword, parseKeywordImport } from "./keywords";

test("normaliseKeyword trims, collapses spaces and lower-cases", () => {
  assert.equal(normaliseKeyword("  Казино   ОНЛАЙН \t бонус "), "казино онлайн бонус");
  assert.equal(normaliseKeyword("CASINO"), "casino");
});

test("normaliseKeyword rejects empty and over-191 input", () => {
  assert.equal(normaliseKeyword("   "), null);
  assert.equal(normaliseKeyword(""), null);
  assert.equal(normaliseKeyword("a".repeat(191)), "a".repeat(191));
  assert.equal(normaliseKeyword("a".repeat(192)), null);
});

test("parseKeywordImport: header line keyword,group is skipped", () => {
  const r = parseKeywordImport("keyword,group\ncasino online,LatAm");
  assert.deepEqual(r.rows, [{ keyword: "casino online", group: "LatAm" }]);
  assert.equal(r.skipped, 0);
  assert.equal(r.duplicates, 0);
});

test("parseKeywordImport: bare header line 'keyword' is skipped too", () => {
  const r = parseKeywordImport("keyword\ncasino online");
  assert.deepEqual(r.rows.map(x => x.keyword), ["casino online"]);
});

test("parseKeywordImport: the first separator found, left to right, wins", () => {
  // Tab is the earliest separator, so the comma belongs to the group cell.
  const tabFirst = parseKeywordImport("casino online\tbonus, spins");
  assert.deepEqual(tabFirst.rows, [{ keyword: "casino online", group: "bonus, spins" }]);

  // Comma comes first, so the tab (and everything after it) belongs to the group.
  const commaFirst = parseKeywordImport("casino online,bonus\tspins");
  assert.deepEqual(commaFirst.rows, [{ keyword: "casino online", group: "bonus spins" }]);

  // Semicolon wins when it is the leftmost.
  const semi = parseKeywordImport("casino online;bonus,spins");
  assert.deepEqual(semi.rows, [{ keyword: "casino online", group: "bonus,spins" }]);
});

test("parseKeywordImport: no separator means the whole line is the keyword", () => {
  const r = parseKeywordImport("казино онлайн");
  assert.deepEqual(r.rows, [{ keyword: "казино онлайн", group: "" }]);
});

test("parseKeywordImport: duplicates across case and spacing collapse into one", () => {
  const r = parseKeywordImport("Casino   Online\ncasino online\n  CASINO ONLINE ");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].keyword, "casino online");
  assert.equal(r.duplicates, 2);
  // The first spelling wins for the group; later duplicates never overwrite it.
  assert.equal(r.rows[0].group, "");
});

test("parseKeywordImport: blank lines and over-191 lines are skipped", () => {
  const r = parseKeywordImport("\n   \ncasino online\n" + "x".repeat(192));
  assert.deepEqual(r.rows.map(x => x.keyword), ["casino online"]);
  assert.equal(r.skipped, 3);
  assert.equal(r.duplicates, 0);
});

test("parseKeywordImport: a UTF-8 BOM in front of the first line is ignored", () => {
  const r = parseKeywordImport("﻿casino online\nslots");
  assert.deepEqual(r.rows.map(x => x.keyword), ["casino online", "slots"]);
  assert.equal(r.skipped, 0);
});

test("parseKeywordImport: \\r\\n line endings split cleanly", () => {
  const r = parseKeywordImport("casino online;LatAm\r\nslots\r\n");
  assert.deepEqual(r.rows, [
    { keyword: "casino online", group: "LatAm" },
    { keyword: "slots", group: "" },
  ]);
});
