import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, type RuntimeOptions } from "../src/index.js";
import { OpenAIProvider } from "../src/providers/openai.js";

const answer = { id: "response-7", model: "selected-model", status: "completed",
  output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Accepted.", annotations: [] }] }],
  usage: { input_tokens: 12, output_tokens: 3 },
};

async function endpoint(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = (url, options) => {
    requests.push({ url: String(url), options: options ?? {} });
    return globalThis.fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, options);
  };
  return { fetch, requests };
}

function runtime(fetch: typeof globalThis.fetch, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider: new OpenAIProvider({ model: "selected-model", apiKey: "selected-test-key", fetch }),
    persona: new StaticPersonaSource("Use supplied facts."), memory: new EmptyMemorySource(),
    retry: { attempts: 3, delayMs: () => 0 }, ...options,
  });
}

test("OpenAI native HTTP attempts each require runtime admission and settlement", async t => {
  const events: string[] = [];
  let calls = 0;
  const { fetch, requests } = await endpoint(t, (request, reply) => {
    request.resume(); calls++; events.push("http");
    reply.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json", "x-request-id": `request-${calls}` });
    reply.end(JSON.stringify(calls === 1 ? { error: { message: "busy" } } : answer));
  });
  const result = await runtime(fetch, { maxModelCalls: 2, modelCalls: {
    admit: () => { events.push("admit"); return true; }, record: () => { events.push("record"); },
  } }).turn({ agentId: "reader", input: "Read the supplied facts." });
  assert.equal(result.output, "Accepted.");
  assert.equal(requests.length, 2);
  assert.deepEqual(events, ["admit", "http", "record", "admit", "http", "record"]);
  assert.deepEqual(result.modelCalls.map(call => [call.status, call.requestId]), [["unknown", "request-1"], ["responded", "request-2"]]);
});

test("OpenAI redirects cannot forward the selected credential or create an unaccounted request", async t => {
  const paths: string[] = [];
  const { fetch } = await endpoint(t, (request, reply) => {
    request.resume(); paths.push(request.url!);
    reply.writeHead(307, { location: "/credential-recipient" }); reply.end();
  });
  await assert.rejects(runtime(fetch, { retry: { attempts: 1, delayMs: () => 0 } })
    .turn({ agentId: "reader", input: "Read the supplied facts." }), { code: "provider_failed" });
  assert.deepEqual(paths, ["/v1/responses"]);
});

test("OpenAI malformed HTTP responses retain request evidence without retries or accepted output", async t => {
  for (const [name, body] of [
    ["invalid JSON", "{broken-json"],
    ["non-object response", "[]"],
    ["malformed output", '{"status":"completed","output":"wrong shape"}'],
    ["invalid native message", '{"object":"response","status":"completed","output":[null]}'],
  ]) await t.test(name, async t => {
    const { fetch, requests } = await endpoint(t, (request, reply) => {
      request.resume(); reply.writeHead(200, { "content-type": "application/json", "x-request-id": "malformed-7" }); reply.end(body);
    });
    let accepted = 0;
    await assert.rejects(runtime(fetch, { outputPolicy: { apply: text => { accepted++; return { output: text, accepted: true }; } } })
      .turn({ agentId: "reader", input: "Read the supplied facts." }), error => {
        assert.ok(error instanceof RuntimeError && error.report);
        assert.equal(error.code, "provider_failed");
        assert.equal(error.message.includes(body), false);
        assert.equal(error.report.modelCalls.length, 1);
        assert.equal(error.report.modelCalls[0].requestId, "malformed-7");
        assert.equal(error.report.modelCalls[0].status, "unknown");
        return true;
      });
    assert.equal(requests.length, 1); assert.equal(accepted, 0);
  });
});

test("OpenAI configuration ignores unrelated endpoint and account environment defaults", async t => {
  const overrides = { OPENAI_BASE_URL: "https://unselected.invalid/v1", OPENAI_ORG_ID: "unselected-org", OPENAI_PROJECT_ID: "unselected-project" };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { fetch, requests } = await endpoint(t, (request, reply) => {
    request.resume(); assert.equal(request.headers.authorization, "Bearer selected-test-key");
    assert.equal(request.headers["openai-organization"], undefined);
    assert.equal(request.headers["openai-project"], undefined);
    reply.writeHead(200, { "content-type": "application/json" }); reply.end(JSON.stringify(answer));
  });
  const result = await runtime(fetch).turn({ agentId: "reader", input: "Read the supplied facts." });
  assert.equal(result.output, "Accepted.");
  assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
});

test("OpenAI permanent HTTP failures retain status and ID without exposing the provider payload", async t => {
  const { fetch, requests } = await endpoint(t, (request, reply) => {
    request.resume(); reply.writeHead(400, { "content-type": "application/json", "x-request-id": "rejected-7" });
    reply.end(JSON.stringify({ error: { message: "private provider detail", type: "invalid_request_error" } }));
  });
  await assert.rejects(runtime(fetch).turn({ agentId: "reader", input: "Read the supplied facts." }), error => {
    assert.ok(error instanceof RuntimeError && error.report);
    assert.equal(error.message.includes("private provider detail"), false);
    assert.equal(error.report.modelCalls[0].requestId, "rejected-7");
    assert.equal(error.report.modelCalls[0].status, "rejected");
    return true;
  });
  assert.equal(requests.length, 1);
});

test("OpenAI records a received rejection even when the error body never finishes", async t => {
  const { fetch, requests } = await endpoint(t, (request, reply) => {
    request.resume(); reply.writeHead(401, { "content-type": "application/json", "x-request-id": "rejected-headers" });
    reply.flushHeaders();
  });
  await assert.rejects(runtime(fetch, { timeoutMs: 500 })
    .turn({ agentId: "reader", input: "Read the supplied facts." }), error => {
      assert.ok(error instanceof RuntimeError && error.report);
      assert.equal(error.code, "provider_failed");
      assert.equal(error.report.modelCalls[0].status, "rejected");
      assert.equal(error.report.modelCalls[0].requestId, "rejected-headers");
      return true;
    });
  assert.equal(requests.length, 1);
});
