import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEasyGrBody } from "./easyGr";

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
