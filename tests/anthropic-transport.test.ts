import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import Anthropic from "@anthropic-ai/sdk";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type RuntimeOptions } from "../src/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

const answer = { id: "message-7", type: "message", role: "assistant", model: "selected-model",
  content: [{ type: "text", text: "Accepted." }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 3 },
};

function environment(t: TestContext, overrides: Record<string, string | undefined> = {}) {
  const settings = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_LOG: undefined, ANTHROPIC_CUSTOM_HEADERS: undefined, ANTHROPIC_PROFILE: undefined, ...overrides };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

async function endpoint(t: TestContext, handler: RequestListener) {
  const nativeFetch = globalThis.fetch;
  const server = createServer(handler);
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = (url, options) => {
    requests.push({ url: String(url), options: options ?? {} });
    return nativeFetch(`${baseURL}${new URL(String(url)).pathname}`, options);
  };
  return { baseURL, fetch, requests };
}

function runtime(provider: AnthropicProvider, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use supplied facts."),
    memory: new EmptyMemorySource(), retry: { attempts: 1, delayMs: () => 0 }, ...options });
}

for (const keySource of ["explicit", "environment"] as const) {
  test(`managed Anthropic requests use only the ${keySource} API key and the official destination`, async t => {
    environment(t, { ANTHROPIC_API_KEY: "environment-test-key", ANTHROPIC_AUTH_TOKEN: "unselected-test-token",
      ANTHROPIC_BASE_URL: "https://unselected.invalid", ANTHROPIC_PROFILE: "unselected-test-profile" });
    const { fetch, requests } = await endpoint(t, (request, reply) => {
      request.resume(); reply.writeHead(200, { "content-type": "application/json", "request-id": "request-7" });
      reply.end(JSON.stringify(answer));
    });
    t.mock.method(globalThis, "fetch", fetch);
    const provider = new AnthropicProvider({ model: "selected-model", ...(keySource === "explicit" ? { apiKey: "selected-test-key" } : {}) });
    const result = await runtime(provider).turn({ agentId: "reader", input: "Read the supplied facts." });
    assert.equal(result.status, "reply");
    assert.equal(result.modelCalls[0].requestId, "request-7");
    assert.equal(result.usage[0].freshInputTokens, 12);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
    const headers = new Headers(requests[0].options.headers);
    assert.equal(headers.get("x-api-key"), keySource === "explicit" ? "selected-test-key" : "environment-test-key");
    assert.equal(headers.get("authorization"), null);
  });
}

test("managed Anthropic clients reject missing or blank API keys before credential fallback or dispatch", t => {
  environment(t, { ANTHROPIC_AUTH_TOKEN: "unselected-test-token", ANTHROPIC_PROFILE: "unselected-test-profile" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(); });
  for (const apiKey of [undefined, "", "   "]) {
    assert.throws(() => new AnthropicProvider({ model: "selected-model", apiKey }), /API key/);
  }
  process.env.ANTHROPIC_API_KEY = "environment-test-key";
  assert.throws(() => new AnthropicProvider({ model: "selected-model", apiKey: "" }), /API key/);
  assert.equal(requests, 0);
});

test("managed Anthropic clients reject ambient custom headers before dispatch", t => {
  environment(t, { ANTHROPIC_CUSTOM_HEADERS: "x-api-key: unselected-test-key\nx-extra-context: unselected" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(); });
  assert.throws(() => new AnthropicProvider({ model: "selected-model", apiKey: "selected-test-key" }), /ANTHROPIC_CUSTOM_HEADERS/);
  assert.equal(requests, 0);
});

test("managed Anthropic clients do not enable SDK content logging from the environment", async t => {
  environment(t, { ANTHROPIC_LOG: "debug" });
  let logs = 0;
  for (const method of ["debug", "info", "warn", "error"] as const) t.mock.method(console, method, () => { logs++; });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }));
  const result = await runtime(new AnthropicProvider({ model: "selected-model", apiKey: "selected-test-key" }))
    .turn({ agentId: "reader", input: "Private test input." });
  assert.equal(result.status, "reply");
  assert.equal(logs, 0);
});

for (const clientMode of ["managed", "injected"] as const) {
  test(`${clientMode} Anthropic HTTP requests cannot forward credentials or input through a redirect`, async t => {
    environment(t);
    const paths: string[] = [];
    const { baseURL, fetch } = await endpoint(t, (request, reply) => {
      request.resume(); paths.push(request.url!);
      if (request.url === "/v1/messages") { reply.writeHead(307, { location: "/credential-recipient" }); reply.end(); }
      else { reply.writeHead(200, { "content-type": "application/json" }); reply.end(JSON.stringify(answer)); }
    });
    t.mock.method(globalThis, "fetch", fetch);
    const provider = new AnthropicProvider({ model: "selected-model", apiKey: "selected-test-key",
      ...(clientMode === "injected" ? { client: new Anthropic({ apiKey: "selected-test-key", baseURL,
        maxRetries: 4, fetchOptions: { redirect: "follow" } }) } : {}) });
    await assert.rejects(runtime(provider).turn({ agentId: "reader", input: "Private test input." }), { code: "provider_failed" });
    assert.deepEqual(paths, ["/v1/messages"]);
  });
}

test("explicit Anthropic clients retain application-owned credentials, destination, headers and logging", async t => {
  environment(t, { ANTHROPIC_CUSTOM_HEADERS: "x-app-context: selected" });
  const { baseURL, fetch, requests } = await endpoint(t, (request, reply) => {
    request.resume(); reply.writeHead(200, { "content-type": "application/json" }); reply.end(JSON.stringify(answer));
  });
  let logs = 0;
  const log = () => { logs++; };
  const client = new Anthropic({ apiKey: "client-test-key", baseURL, fetch, logLevel: "debug",
    logger: { debug: log, info: log, warn: log, error: log } });
  const provider = new AnthropicProvider({ model: "selected-model", client });
  const result = await runtime(provider).turn({ agentId: "reader", input: "Read supplied facts." });
  assert.equal(result.status, "reply");
  assert.equal(requests[0].url, `${baseURL}/v1/messages`);
  assert.equal(new Headers(requests[0].options.headers).get("x-api-key"), "client-test-key");
  assert.equal(new Headers(requests[0].options.headers).get("x-app-context"), "selected");
  assert.ok(logs > 0);
  assert.equal(client.logLevel, "debug");
});

test("each managed Anthropic HTTP retry requires runtime admission and settlement", async t => {
  environment(t);
  const events: string[] = [];
  let calls = 0;
  const { fetch } = await endpoint(t, (request, reply) => {
    request.resume(); calls++; events.push("http");
    reply.writeHead(calls === 1 ? 429 : 200, { "content-type": "application/json", "request-id": `request-${calls}` });
    reply.end(JSON.stringify(calls === 1 ? { type: "error", error: { type: "rate_limit_error", message: "busy" } } : answer));
  });
  t.mock.method(globalThis, "fetch", fetch);
  const result = await runtime(new AnthropicProvider({ model: "selected-model", apiKey: "selected-test-key" }), {
    maxModelCalls: 2, retry: { attempts: 2, delayMs: () => 0 },
    modelCalls: { admit: () => { events.push("admit"); return true; }, record: () => { events.push("record"); } },
  }).turn({ agentId: "reader", input: "Read supplied facts." });
  assert.equal(result.status, "reply");
  assert.deepEqual(events, ["admit", "http", "record", "admit", "http", "record"]);
  assert.deepEqual(result.modelCalls.map(call => [call.status, call.requestId]), [["rejected", "request-1"], ["responded", "request-2"]]);
});
