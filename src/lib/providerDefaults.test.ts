// Endpoint/model resolution for Ollama — one rule shared by chat, vision and discovery.
//
// These are the branches that decide where a request goes and what model id it carries, so they
// are worth pinning: the previous code sent every Ollama call to 127.0.0.1:11434 unless an
// endpoint was stored, which silently broke cloud keys and made server-side jobs (no browser, only
// a key) point at a daemon that is not running on that host.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AI_PROVIDER,
  aiConfigReady,
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_LOCAL_BASE_URL,
  defaultModelFor,
  isLocalEndpoint,
  isOllamaCloud,
  ollamaChatModel,
  ollamaEndpoint,
  ollamaVisionModel,
} from "./providerDefaults";

test("endpoint: an explicit override always wins", () => {
  assert.equal(ollamaEndpoint("sk-key", "https://my-proxy.example/v1"), "https://my-proxy.example/v1");
  assert.equal(ollamaEndpoint("", "http://10.0.0.5:11434/v1"), "http://10.0.0.5:11434/v1");
  assert.equal(ollamaEndpoint("sk-key", "https://ollama.com/v1///"), "https://ollama.com/v1"); // trailing slashes trimmed
});

test("endpoint: a key means Cloud, no key means the local daemon", () => {
  assert.equal(ollamaEndpoint("sk-ollama-cloud"), OLLAMA_CLOUD_BASE_URL);
  assert.equal(ollamaEndpoint(""), OLLAMA_LOCAL_BASE_URL);
  assert.equal(ollamaEndpoint(undefined, undefined), OLLAMA_LOCAL_BASE_URL);
  assert.equal(ollamaEndpoint("   ", ""), OLLAMA_LOCAL_BASE_URL); // whitespace is not a key
});

test("model: the user's pick always wins", () => {
  assert.equal(ollamaChatModel("glm-5.2", "sk-key"), "glm-5.2");
  assert.equal(ollamaChatModel("llama3.2:3b"), "llama3.2:3b");
  assert.equal(ollamaVisionModel("kimi-k3", "sk-key"), "kimi-k3");
});

test("model: only Cloud has an inventable default", () => {
  // Cloud catalogue is fixed, so the app can name a model the account will have.
  assert.equal(ollamaChatModel("", "sk-key"), defaultModelFor("ollama", "chat"));
  assert.equal(ollamaVisionModel("", "sk-key"), defaultModelFor("ollama", "vision"));
  assert.ok(defaultModelFor("ollama", "chat").trim().length > 0);
  // A daemon's catalogue is whatever was pulled: guessing an id there is a 404, so say nothing.
  assert.equal(ollamaChatModel("", ""), "");
  assert.equal(ollamaVisionModel(""), "");
});

test("model: an explicit cloud endpoint without a key still gets cloud defaults", () => {
  // The key is missing (caller will 401 and can say so), but the target IS known to be Cloud, so
  // naming a cloud model is correct — the failure to report is the absent key, not the model.
  assert.equal(ollamaChatModel("", "", OLLAMA_CLOUD_BASE_URL), defaultModelFor("ollama", "chat"));
});

test("cloud detection does not mistake look-alike hosts", () => {
  assert.equal(isOllamaCloud(OLLAMA_CLOUD_BASE_URL), true);
  assert.equal(isOllamaCloud("https://ollama.example.com/v1"), false);
  assert.equal(isOllamaCloud("https://notollama.com/v1"), false);
});

test("local detection covers loopback and private ranges", () => {
  for (const u of ["http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://10.1.2.3:11434/v1",
    "http://192.168.0.9:11434/v1", "http://172.16.5.4:11434/v1", "http://host.internal/v1"]) {
    assert.equal(isLocalEndpoint(u), true, u);
  }
  assert.equal(isLocalEndpoint(OLLAMA_CLOUD_BASE_URL), false);
  assert.equal(isLocalEndpoint("https://8.8.8.8/v1"), false);
});

test("the rest of the provider table is untouched", () => {
  assert.equal(DEFAULT_AI_PROVIDER, "ollama");
  assert.equal(defaultModelFor("openai"), "gpt-5.6-luna");
  assert.equal(defaultModelFor("anthropic"), "claude-haiku-4-5-20251001");
  assert.equal(defaultModelFor("custom"), "");
  assert.equal(defaultModelFor("nope-not-a-provider"), "");
});


test("aiConfigReady: a key makes any provider ready", () => {
  assert.equal(aiConfigReady("anthropic", "sk-x"), true);
  assert.equal(aiConfigReady("ollama", "sk-ollama"), true);
  assert.equal(aiConfigReady("custom", "k", "https://gw.example/v1"), true);
});

test("aiConfigReady: keyless is an Ollama-local privilege only", () => {
  // The daemon on this box: ready with no key anywhere.
  assert.equal(aiConfigReady("ollama", ""), true);
  assert.equal(aiConfigReady("ollama", undefined, undefined), true);
  // An explicit non-cloud endpoint (a remote self-hosted daemon) is keyless-ready too.
  assert.equal(aiConfigReady("ollama", "", "http://10.0.0.5:11434/v1"), true);
  // Cloud without a key would 401 on every call — NOT ready.
  assert.equal(aiConfigReady("ollama", "", OLLAMA_CLOUD_BASE_URL), false);
  // Whitespace is not a key.
  assert.equal(aiConfigReady("ollama", "   "), true); // local daemon, not cloud
  // Every other provider without a key stays not-ready.
  assert.equal(aiConfigReady("anthropic", ""), false);
  assert.equal(aiConfigReady("openai", ""), false);
  assert.equal(aiConfigReady("custom", ""), false);
});
