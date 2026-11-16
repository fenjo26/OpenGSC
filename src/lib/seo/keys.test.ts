import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_NAMES,
  adoptOllamaCloudCreds,
  aiCredsReady,
  getConfiguredProviders,
  getSeoGenCreds,
  getSerpCreds,
  misplacedAiCreds,
  ollamaReadinessIssue,
  resolveTaskCreds,
} from "./keys";
import {
  DEFAULT_AI_PROVIDER,
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_LOCAL_BASE_URL,
  defaultModelFor,
  isOllamaCloud,
  SUPPORTED_PROVIDERS,
} from "../providerDefaults";

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

// ── The default provider is one constant, and Ollama is fully tabled ────────────────────────
test("the app's default provider is the constant (anthropic upstream), with Ollama defaults tabled", () => {
  // Upstream keeps anthropic as the nothing-configured default; a fork running on Ollama
  // flips the constant itself. See providerDefaults.ts.
  assert.equal(DEFAULT_AI_PROVIDER, "anthropic");
  assert.equal(OLLAMA_CLOUD_BASE_URL, "https://ollama.com/v1");
  assert.equal(OLLAMA_LOCAL_BASE_URL, "http://127.0.0.1:11434/v1");
  assert.equal(defaultModelFor("ollama", "chat"), "deepseek-v4.1-flash:1017-cloud");
  assert.equal(defaultModelFor("ollama", "vision"), "gemma4:31b");
  assert.ok(SUPPORTED_PROVIDERS.includes("ollama"));
  assert.equal(AI_PROVIDER_NAMES.ollama, "Ollama");
  // nothing stored anywhere: task creds resolve to the default provider, not a hardcoded one
  const c = resolveTaskCreds("outline");
  assert.equal(c.provider, DEFAULT_AI_PROVIDER);
  assert.equal(c.providerFrom, "default");
  assert.equal(aiCredsReady(c), false); // no key -> not runnable yet
});

// ── Cloud readiness: a key is REQUIRED for ollama.com ───────────────────────────────────────
test("ollama cloud endpoint without a key is NOT ready (would 401 on every call)", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");
  shim.setItem("aiBaseUrl_ollama", OLLAMA_CLOUD_BASE_URL);
  shim.setItem("aiModel_ollama", "deepseek-v4.1-flash:1017-cloud");
  const c = resolveTaskCreds("outline");
  assert.equal(c.apiKey, "");
  assert.equal(c.model, "deepseek-v4.1-flash:1017-cloud");
  assert.equal(aiCredsReady(c), false);
  assert.equal(ollamaReadinessIssue(c), "cloud_key");
});

test("ollama cloud with a key is ready, and a missing model resolves to the cloud default", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "sk-ollama-cloud");
  shim.setItem("aiBaseUrl_ollama", OLLAMA_CLOUD_BASE_URL);
  const c = resolveTaskCreds("outline");
  assert.equal(c.model, "deepseek-v4.1-flash:1017-cloud");
  assert.equal(c.modelFrom, "default");
  assert.equal(aiCredsReady(c), true);
  assert.equal(ollamaReadinessIssue(c), "");
});

test("a key alone (no stored endpoint) targets Ollama Cloud, not the local daemon", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "sk-ollama-cloud");
  const c = resolveTaskCreds("outline");
  assert.equal(c.baseUrl, undefined); // lib/llm resolves it: key present -> Cloud
  assert.equal(c.model, "deepseek-v4.1-flash:1017-cloud");
  assert.equal(aiCredsReady(c), true);
});

// ── Local daemon stays a supported configuration ────────────────────────────────────────────
test("local ollama: no key, picked model, no endpoint -> ready on the daemon", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");            // the card's empty-save marker
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const c = resolveTaskCreds("outline");
  assert.equal(c.apiKey, "");
  assert.equal(c.model, "llama3.2:3b");
  assert.equal(aiCredsReady(c), true);
});

test("local ollama without a model is NOT ready (a daemon catalogue cannot be guessed)", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");
  const c = resolveTaskCreds("outline");
  assert.equal(c.model, "");
  assert.equal(aiCredsReady(c), false);
  assert.equal(ollamaReadinessIssue(c), "model");
});

test("remote ollama: private endpoint, no key, model picked -> ready", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiBaseUrl_ollama", "http://192.168.1.10:11434/v1");
  shim.setItem("aiModel_ollama", "gemma3:12b");
  const c = resolveTaskCreds("outline");
  assert.equal(c.baseUrl, "http://192.168.1.10:11434/v1");
  assert.equal(aiCredsReady(c), true);
});

// ── Migration: adopt the Cloud key that predates the native provider ───────────────────────
test("adoption copies ollama.com creds out of the custom slot and makes ollama active", () => {
  shim.setItem("aiProvider", "openai");
  shim.setItem("aiKey_custom", "sk-ollama-cloud");
  shim.setItem("aiBaseUrl_custom", "https://ollama.com/v1");
  shim.setItem("aiModel_custom", "deepseek-v4.1-flash:1017-cloud");
  const r = adoptOllamaCloudCreds();
  assert.equal(r.adopted, true);
  assert.equal(shim.getItem("aiProvider"), "ollama");
  assert.equal(shim.getItem("aiKey_ollama"), "sk-ollama-cloud");
  assert.equal(shim.getItem("aiBaseUrl_ollama"), "https://ollama.com/v1");
  assert.equal(shim.getItem("aiModel_ollama"), "deepseek-v4.1-flash:1017-cloud");
  const c = resolveTaskCreds("outline");
  assert.equal(aiCredsReady(c), true);
});

test("adoption replaces a local-only model with the cloud one", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiModel_ollama", "llama3.2:3b"); // local pick, no key/endpoint
  shim.setItem("aiKey_custom", "sk-ollama-cloud");
  shim.setItem("aiBaseUrl_custom", "https://ollama.com/v1");
  shim.setItem("aiModel_custom", "deepseek-v4.1-flash:1017-cloud");
  assert.equal(adoptOllamaCloudCreds().adopted, true);
  assert.equal(shim.getItem("aiModel_ollama"), "deepseek-v4.1-flash:1017-cloud");
});

test("adoption never overwrites an existing ollama slot or hijacks a keyed provider", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "sk-native");
  shim.setItem("aiBaseUrl_ollama", "https://ollama.com/v1");
  shim.setItem("aiModel_ollama", "kimi-k3");
  shim.setItem("aiKey_custom", "sk-ollama-cloud");
  shim.setItem("aiBaseUrl_custom", "https://ollama.com/v1");
  assert.equal(adoptOllamaCloudCreds().adopted, false);
  assert.equal(shim.getItem("aiKey_ollama"), "sk-native");
  assert.equal(shim.getItem("aiModel_ollama"), "kimi-k3");

  // a deliberately chosen provider WITH its own key keeps the wheel
  shim.setItem("aiProvider", "openai");
  shim.setItem("aiKey_openai", "sk-openai");
  assert.equal(adoptOllamaCloudCreds().adopted, false);
  assert.equal(shim.getItem("aiProvider"), "openai");
});

test("a custom slot that is not ollama.com is left alone", () => {
  shim.setItem("aiProvider", "custom");
  shim.setItem("aiKey_custom", "sk-gateway");
  shim.setItem("aiBaseUrl_custom", "https://gateway.example/v1");
  assert.equal(adoptOllamaCloudCreds().adopted, false);
  assert.equal(shim.getItem("aiProvider"), "custom");
  assert.equal(shim.getItem("aiKey_ollama"), null);
});

// ── Ollama Cloud with an explicit model / per-task override ─────────────────────────────────
test("cloud: an explicitly picked cloud model wins over the cloud default", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "sk-ollama-cloud");
  shim.setItem("aiModel_ollama", "glm-5.2");
  const c = resolveTaskCreds("outline");
  assert.equal(c.model, "glm-5.2");
  assert.equal(c.modelFrom, "provider");
  assert.equal(aiCredsReady(c), true);
});

test("per-task override still wins over the global ollama selection", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "sk-ollama-cloud");
  shim.setItem("seoTaskProvider_outline", "openai");
  shim.setItem("aiKey_openai", "sk-openai");
  shim.setItem("seoTaskModel_outline", "gpt-5.6-luna");
  const c = resolveTaskCreds("outline");
  assert.equal(c.provider, "openai");
  assert.equal(c.apiKey, "sk-openai");
  assert.equal(c.model, "gpt-5.6-luna");
  assert.equal(aiCredsReady(c), true);
  assert.equal(resolveTaskCreds("text").provider, "ollama");
});

// ── Model discovery / selection plumbing ───────────────────────────────────────────────────
test("configured-providers list includes keyless ollama once saved (marker), and drops it when cleared", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", ""); // marker written by the card's Save
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const ids = getConfiguredProviders().map(p => p.id);
  assert.ok(ids.includes("ollama"), "saved ollama must count as configured");
  shim.removeItem("aiKey_ollama"); // never saved / removed in Settings
  assert.equal(getConfiguredProviders().some(p => p.id === "ollama"), false);
});

test("an endpoint-only ollama (no marker, no key) also counts as configured", () => {
  shim.setItem("aiBaseUrl_ollama", "http://127.0.0.1:11434/v1");
  assert.ok(getConfiguredProviders().some(p => p.id === "ollama"));
});

test("ollama creds ride the generic aiKey_/aiBaseUrl_/aiModel_ prefixes the sync mirrors", () => {
  shim.setItem("aiKey_ollama", "sk-ollama-cloud");
  shim.setItem("aiBaseUrl_ollama", "https://ollama.com/v1");
  shim.setItem("aiModel_ollama", "kimi-k3");
  assert.deepEqual(getConfiguredProviders().find(p => p.id === "ollama"), {
    id: "ollama", key: "sk-ollama-cloud", baseUrl: "https://ollama.com/v1",
  });
});

// ── Active provider detection ───────────────────────────────────────────────────────────────
test("getSeoGenCreds resolves the active provider's own key (not another slot's)", () => {
  shim.setItem("aiProvider", "ollama");
  shim.setItem("aiKey_ollama", "");
  shim.setItem("aiModel_ollama", "llama3.2:3b");
  const g = getSeoGenCreds();
  assert.equal(g.provider, "ollama");
  assert.equal(g.model, "llama3.2:3b");
  assert.equal(aiCredsReady(g), true);
});

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

// ── Existing providers unaffected ───────────────────────────────────────────────────────────
test("keyed providers keep their old readiness rule and defaults", () => {
  for (const [id, key] of [["anthropic", "sk-ant-x"], ["openai", "sk-x"], ["gemini", "AIzaSy-x"], ["openrouter", "sk-or-x"], ["custom", "sk-custom-x"]] as const) {
    shim.setItem(`aiKey_${id}`, key);
    assert.equal(aiCredsReady({ provider: id, apiKey: key }), true, id);
    assert.equal(aiCredsReady({ provider: id, apiKey: "" }), false, id);
  }
  assert.equal(defaultModelFor("anthropic"), "claude-haiku-4-5-20251001");
  assert.equal(defaultModelFor("openai"), "gpt-5.6-luna");
  assert.equal(defaultModelFor("custom"), ""); // still no invented id for an unknown catalogue
  assert.deepEqual(AI_PROVIDER_IDS.slice(0, 10), ["anthropic", "openai", "gemini", "openrouter", "cheaperinference", "zai", "kimi", "kie", "deepseek", "qwen"]);
});

test("isOllamaCloud distinguishes Cloud from a self-hosted daemon", () => {
  assert.equal(isOllamaCloud("https://ollama.com/v1"), true);
  assert.equal(isOllamaCloud("https://api.ollama.com/v1"), true);
  assert.equal(isOllamaCloud("http://127.0.0.1:11434/v1"), false);
  assert.equal(isOllamaCloud("http://192.168.1.10:11434/v1"), false);
  assert.equal(isOllamaCloud("https://ollama.example.com/v1"), false);
});

test("SERP creds untouched (same scope, unaffected by the AI work)", () => {
  shim.setItem("seoSerpProvider", "serper");
  shim.setItem("seoKey_serper", "sp-x");
  assert.deepEqual(getSerpCreds(), { provider: "serper", apiKey: "sp-x", baseUrl: undefined });
});
