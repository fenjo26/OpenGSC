import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_NAMES,
  aiCredsReady,
  getConfiguredProviders,
  getSeoGenCreds,
  getSerpCreds,
  misplacedAiCreds,
  resolveTaskCreds,
} from "./keys";
import { defaultModelFor, OLLAMA_DEFAULT_BASE_URL, SUPPORTED_PROVIDERS } from "../providerDefaults";

// localStorage shim — keys.ts reads it directly on the client paths under test.
const store = new Map<string, string>();
const shim = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = shim;
  // keys.ts gates its client paths on `typeof window === "undefined"` — alias window to the
  // test global so the localStorage-backed code paths actually run under node:test.
  (globalThis as { window?: unknown }).window = globalThis;
});

// ── 1. Ollama configured without an API key ─────────────────────────────────────────────────
test("ollama without a key is ready once a model is picked", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");            // the card's empty-save marker
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const c = resolveTaskCreds("outline");
  assert.equal(c.provider, "ollama");
  assert.equal(c.apiKey, "");
  assert.equal(c.model, "llama3.2:3b");
  assert.equal(aiCredsReady(c), true);
});

test("ollama without a model is NOT ready (nothing to send the server)", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");
  const c = resolveTaskCreds("outline");
  assert.equal(c.apiKey, "");
  assert.equal(aiCredsReady(c), false);
});

// ── 2. Ollama Cloud with an API key ──────────────────────────────────────────────────────────
test("ollama cloud: key + https base url resolve and are ready", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "sk-ollama-cloud-key-123");
  shim.setItem("aiBaseUrl_ollama", "https://ollama.com/v1");
  shim.setItem("aiModel_ollama", "deepseek-v4.1-flash:1017-cloud");
  const c = resolveTaskCreds("outline");
  assert.equal(c.apiKey, "sk-ollama-cloud-key-123");
  assert.equal(c.baseUrl, "https://ollama.com/v1");
  assert.equal(aiCredsReady(c), true);
});

// ── 3. Local Ollama on the default endpoint ──────────────────────────────────────────────────
test("local ollama: no stored base url -> undefined here, known default in lib/llm", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const c = resolveTaskCreds("outline");
  assert.equal(c.baseUrl, undefined); // llm.ts substitutes OLLAMA_DEFAULT_BASE_URL
  assert.equal(OLLAMA_DEFAULT_BASE_URL, "http://127.0.0.1:11434/v1");
});

// ── 4. Remote Ollama via a custom endpoint ───────────────────────────────────────────────────
test("remote ollama: stored base url rides along on the creds", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiBaseUrl_ollama", "http://192.168.1.10:11434/v1");
  shim.setItem("aiModel_ollama", "gemma3:12b");
  const c = resolveTaskCreds("outline");
  assert.equal(c.baseUrl, "http://192.168.1.10:11434/v1");
  assert.equal(aiCredsReady(c), true);
});

// ── 5. Model discovery / selection plumbing ──────────────────────────────────────────────────
test("configured-providers list includes keyless ollama once saved (marker), and drops it when cleared", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", ""); // marker written by the card's Save
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const ids = getConfiguredProviders().map(p => p.id);
  assert.ok(ids.includes("ollama"), "saved ollama must count as configured");
  shim.removeItem("aiKey_ollama"); // never saved / removed in Settings
  assert.equal(getConfiguredProviders().some(p => p.id === "ollama"), false);
});

test("model registry: ollama has no invented default, the default endpoint is the local daemon", () => {
  assert.equal(defaultModelFor("ollama"), "");
  assert.equal(defaultModelFor("ollama", "vision"), "");
  assert.ok(SUPPORTED_PROVIDERS.includes("ollama"));
});

// ── 6. Active provider detection with valid credentials ─────────────────────────────────────
test("getSeoGenCreds resolves the active provider's own key (not another slot's)", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const g = getSeoGenCreds();
  assert.equal(g.provider, "ollama");
  assert.equal(g.model, "llama3.2:3b");
  assert.equal(aiCredsReady(g), true);
});

// ── 7. Credentials stored under a different provider ID ──────────────────────────────────────
test("creds under custom while openai is active: NOT ready, and the mismatch is diagnosed", () => {
  shim.setItem("aiProvider", "openai");
  shim.setItem("aiKey_custom", "sk-ollama-cloud");
  shim.setItem("aiBaseUrl_custom", "https://ollama.com/v1");
  shim.setItem("aiModel_custom", "deepseek-v4.1-flash:1017-cloud");
  const c = resolveTaskCreds("outline");
  assert.equal(c.provider, "openai");
  assert.equal(c.apiKey, "");
  assert.equal(aiCredsReady(c), false);
  const mis = misplacedAiCreds("openai");
  assert.ok(mis.some(m => m.provider === "custom" && m.name === "Custom (OpenAI-compatible)"));
  assert.ok(!mis.some(m => m.provider === "openai"), "active provider never listed as misplaced");
});

// ── 8. Task-specific overrides ───────────────────────────────────────────────────────────────
test("per-task override wins over the global ollama selection", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  shim.setItem("seoTaskProvider_outline", "openai");
  shim.setItem("aiKey_openai", "sk-openai");
  shim.setItem("seoTaskModel_outline", "gpt-5.6-luna");
  const c = resolveTaskCreds("outline");
  assert.equal(c.provider, "openai");
  assert.equal(c.apiKey, "sk-openai");
  assert.equal(c.model, "gpt-5.6-luna");
  assert.equal(aiCredsReady(c), true);
  // other tasks stay on the global selection
  const other = resolveTaskCreds("text");
  assert.equal(other.provider, "ollama");
});

// ── 9. Browser/server sync plumbing ──────────────────────────────────────────────────────────
test("ollama creds ride the generic aiKey_/aiBaseUrl_/aiModel_ prefixes the sync mirrors", () => {
  shim.setItem("aiKey_ollama", "");
  shim.setItem("aiBaseUrl_ollama", "https://ollama.com/v1");
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  // getConfiguredProviders + resolveTaskCreds read exactly these keys; the sync snapshot
  // (SeoKeysSync PREFIXES) mirrors the same three prefixes for ANY provider id, so ollama
  // needs no sync-side change — pin the shape the sync relies on:
  assert.deepEqual(getConfiguredProviders().find(p => p.id === "ollama"), {
    id: "ollama", key: "", baseUrl: "https://ollama.com/v1",
  });
});

// ── 10. Existing providers unaffected ────────────────────────────────────────────────────────
test("keyed providers keep their old readiness rule and defaults", () => {
  for (const [id, key] of [["anthropic", "sk-ant-x"], ["openai", "sk-x"], ["gemini", "AIzaSy-x"], ["openrouter", "sk-or-x"], ["custom", "sk-custom-x"]] as const) {
    shim.setItem(`aiKey_${id}`, key);
    assert.equal(aiCredsReady({ provider: id, apiKey: key }), true, id);
    assert.equal(aiCredsReady({ provider: id, apiKey: "" }), false, id);
  }
  assert.equal(defaultModelFor("anthropic"), "claude-haiku-4-5-20251001");
  assert.equal(defaultModelFor("openai"), "gpt-5.6-luna");
  assert.equal(defaultModelFor("custom"), "");
  assert.deepEqual(AI_PROVIDER_IDS.slice(0, 10), ["anthropic", "openai", "gemini", "openrouter", "cheaperinference", "zai", "kimi", "kie", "deepseek", "qwen"]);
  assert.equal(AI_PROVIDER_NAMES.ollama, "Ollama");
});

test("SERP creds untouched (same scope, unaffected by the AI work)", () => {
  shim.setItem("seoSerpProvider", "serper");
  shim.setItem("seoKey_serper", "sp-x");
  assert.deepEqual(getSerpCreds(), { provider: "serper", apiKey: "sp-x", baseUrl: undefined });
});
