import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEasyGrBody, parseEasyGrRecord } from "./easyGr";

// This parser had to be written without keys and without an allowlisted IP, so the contract is
// pinned here instead of being discovered against the live service. The one rule that matters:
// nothing that is not positively an answer may become one.

test("the documented free markers are read as available", () => {
  // ".gr" answers "not exist"; the gTLDs easy.gr resells answer "No match for".
  assert.equal(parseEasyGrBody("Domain not exist").verdict, "available");
  assert.equal(parseEasyGrBody("No match for CYCLORAMA.GR").verdict, "available");
});

test("a real record reads as registered", () => {
  const body = [
    "domain: cyclorama.gr",
    "Registrar: Papaki",
    "Creation Date: 2009-04-01",
    "Name Server: ns1.example.gr",
  ].join("\n");
  assert.equal(parseEasyGrBody(body).verdict, "registered");
});

test("a JSON refusal is a refusal, never a verdict", () => {
  // This is the exact shape api.easy.gr returns for a bad password — and, by the same path, for
  // an IP that is not on their allowlist or an account out of credits. Reading it as "available"
  // would tell the user to go and buy a domain somebody owns.
  const out = parseEasyGrBody('{"done":0,"errors":{"password":"unauthorized"},"time_taken":"3ms"}');
  assert.equal(out.verdict, "refused");
  assert.match(out.reason ?? "", /password/);
});

test("an empty or unrecognised body is 'empty', not 'registered'", () => {
  // "Does not contain the free marker" is not evidence of registration: a blank reply, an error
  // page and a maintenance notice all pass that test, and each would quietly bin a candidate.
  assert.equal(parseEasyGrBody("").verdict, "empty");
  assert.equal(parseEasyGrBody("   ").verdict, "empty");
  assert.equal(parseEasyGrBody("<html><body>Service temporarily unavailable</body></html>").verdict, "empty");
  assert.equal(parseEasyGrBody("{}").verdict, "empty");
  assert.equal(parseEasyGrBody("{not json").verdict, "empty");
});

test("a successful JSON answer is read through whichever field carries it", () => {
  assert.equal(parseEasyGrBody('{"done":1,"result":"Domain not exist"}').verdict, "available");
  assert.equal(parseEasyGrBody('{"done":1,"whois":"Registrar: Papaki\\nStatus: active"}').verdict, "registered");
});

test("free wins over registered when both appear", () => {
  // "No match for X" replies sometimes carry a boilerplate footer mentioning a registrar. The
  // free marker is the specific statement; the footer is decoration.
  assert.equal(parseEasyGrBody("No match for X\n\nRegistrar of record: none").verdict, "available");
});

// ─── Captured from the live API on 2026-09-10, from an allowlisted server ────────────────────
//
// These two are the contract, not an imitation of it. The taken-domain reply is an HTML table in
// GREEK — no English whois vocabulary appears in it anywhere — which is why a marker list built
// only from English words read every taken .gr as "answer not understood".

const FREE_GR = "Domain Does not exist";

const TAKEN_GR = `<div class="box-white text-left"><div class="table_header">ΣΤΟΙΧΕΙΑ ΟΝΟΜΑΤΟΣ</div><table class="table table-hover"><tbody><table class="table table-hover"><br />
  <tbody><br />
    <tr><br />
      <td>Όνομα χώρου</td><th class="domain-wrap"> google.gr</th><br />
    </tr><br />
    <tr><br />
      <td>Κατάταση Domain</td><th class="domain-wrap"> ok</th><br />
    </tr><br />
    <tr><br />
      <td>Αριθμός πρωτοκόλλου</td><th class="domain-wrap"> 1005766</th><br />
    </tr><br />
    <tr><br />
      <td>Ημερομηνία δημιουργίας</td><th class="domain-wrap"> 01-12-2004</th><br />
    </tr><br />
    <tr><br />
      <td>Ημερομηνία λήξης</td><th class="domain-wrap"> 30-11-2026</th><br />
    </tr><br />
    <tr><br />
      <td>Δέσμη ονόματος</td><th class="domain-wrap"> google.gr</th><br />
    </tr><tr><td>Εξυπηρετητής ονοματοδοσίας</td><th class="domain-wrap"> ns1.google.com</th></tr><tr><td>Εξυπηρετητής ονοματοδοσίας</td><th class="domain-wrap"> ns2.google.com</th></tr></tbody></table></div><div class="box-white text-left"><p class="table_header">ΣΤΟΙΧΕΙΑ ΚΑΤΑΧΩΡΗΤΗ</p><table class="table table-hover"><tbody><br />
    <tr><br />
      <td>Επωνυμία</td><th class="domain-wrap"> STYLIANOS STAFYLAKIS AB</th><br />
    </tr></tbody></table></div><div class="gr_message"></div>`;

test("the real free reply is read as available", () => {
  assert.equal(parseEasyGrBody(FREE_GR).verdict, "available");
});

test("the real taken reply is read as registered, in Greek", () => {
  // The regression this pins: with an English-only marker list this body matched nothing and
  // came back "empty", so every taken .gr looked like a broken answer instead of a taken name.
  assert.equal(parseEasyGrBody(TAKEN_GR).verdict, "registered");
});

test("the registry table gives up the dates a drop hunter is actually here for", () => {
  const record = parseEasyGrRecord(TAKEN_GR);
  // dd-mm-yyyy, not ISO — reading 01-12-2004 as the 12th of January would be silent and wrong.
  assert.equal(record.createdAt?.getFullYear(), 2004);
  assert.equal(record.createdAt?.getMonth(), 11);
  assert.equal(record.createdAt?.getDate(), 1);
  // The expiry of a taken .gr is the date of a future drop.
  assert.equal(record.expiresAt?.getFullYear(), 2026);
  assert.equal(record.expiresAt?.getMonth(), 10);
  assert.equal(record.expiresAt?.getDate(), 30);
  assert.deepEqual(record.nameServers, ["ns1.google.com", "ns2.google.com"]);
  assert.deepEqual(record.registryStatus, ["ok"]);
});

test("a body with no table yields no record rather than half a one", () => {
  assert.deepEqual(parseEasyGrRecord(FREE_GR), {});
  assert.deepEqual(parseEasyGrRecord("<html><body>error</body></html>"), {});
});

test("a taken reply carries its record through the verdict", () => {
  const out = parseEasyGrBody(TAKEN_GR);
  assert.equal(out.record?.expiresAt?.getFullYear(), 2026);
});
