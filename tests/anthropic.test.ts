import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource } from "../src/index.js";

function transport(responses: Array<{ status: number; body: unknown; requestId: string }>) {
  const requests: Record<string, any>[] = [];
  const client = new Anthropic({ apiKey: "test-only", maxRetries: 4,
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)));
      const response = responses.shift();
      assert.ok(response, "unexpected extra HTTP attempt");
      return new Response(JSON.stringify(response.body), { status: response.status, headers: {
        "content-type": "application/json", "request-id": response.requestId, "retry-after-ms": "1",
      } });
    },
  });
  const provider = new AnthropicProvider({ model: "test-model", client });
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(),
    retry: { attempts: 1, delayMs: () => 0 },
  });
  return { runtime, provider, requests };
}

test("Anthropic sends the exact structured schema and exposes the HTTP request ID and usage", async () => {
  const { runtime, requests } = transport([{ status: 200, requestId: "req-42", body: {
    id: "msg-9", type: "message", role: "assistant", model: "test-model",
    content: [{ type: "text", text: '{"selectedId":"exact-9"}' }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 8 },
  } }]);
  const schema = { type: "object", properties: { selectedId: { type: "string", enum: ["exact-9"] } },
    required: ["selectedId"], additionalProperties: false,
  };
  const result = await runtime.turn({ agentId: "a", input: "select", structuredOutput: { schema,
    parse: (value) => { assert.deepEqual(value, { selectedId: "exact-9" }); return value; },
  } });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].output_config, { format: { type: "json_schema", schema } });
  assert.equal(requests[0].tools, undefined);
  assert.equal(result.modelCalls[0].requestId, "req-42");
  assert.equal(result.usage[0].freshInputTokens, 12);
});

test("an injected Anthropic client cannot hide SDK retries from the runtime budget", async () => {
  const errorBody = { type: "error", error: { type: "rate_limit_error", message: "limit" } };
  const { runtime, requests } = transport(Array.from({ length: 5 }, () => ({ status: 429, requestId: "req-denied", body: errorBody })));
  await assert.rejects(runtime.turn({ agentId: "a", input: "go" }), (error: unknown) => {
    assert.ok(error instanceof RuntimeError && error.report);
    assert.equal(error.code, "provider_failed");
    assert.equal(error.report.modelCalls[0].status, "rejected");
    assert.equal(error.report.modelCalls[0].requestId, "req-denied");
    return true;
  });
  assert.equal(requests.length, 1);
});

test("Anthropic treats server and connection failures as uncertain outcomes", () => {
  const { provider } = transport([]);
  assert.equal(provider.failureInfo({ status: 500 }).status, "unknown");
  assert.equal(provider.failureInfo({ status: 408 }).status, "unknown");
  assert.equal(provider.failureInfo(new Error("connection lost")).status, "unknown");
});

test("a provider response without usage remains a known response with unknown cost", async () => {
  const { runtime } = transport([{ status: 200, requestId: "req-no-usage", body: {
    id: "msg-10", type: "message", role: "assistant", model: "test-model",
    content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null,
  } }]);
  const result = await runtime.turn({ agentId: "a", input: "go" });
  assert.equal(result.modelCalls[0].status, "responded");
  assert.equal(result.modelCalls[0].requestId, "req-no-usage");
  assert.equal(result.modelCalls[0].usage, undefined);
  assert.deepEqual(result.usage, []);
});
