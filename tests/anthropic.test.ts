import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, type RuntimeOptions } from "../src/index.js";
import { SqliteModelCallStore } from "../src/durable/sqlite.js";

function transport(responses: Array<{ status: number; body: unknown; requestId: string } | Error>, options: Partial<RuntimeOptions> = {}) {
  const requests: Record<string, any>[] = [];
  const client = new Anthropic({ apiKey: "test-only", maxRetries: 4,
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)));
      const response = responses.shift();
      assert.ok(response, "unexpected extra HTTP attempt");
      if (response instanceof Error) throw response;
      return new Response(JSON.stringify(response.body), { status: response.status, headers: {
        "content-type": "application/json", "request-id": response.requestId, "retry-after-ms": "1",
      } });
    },
  });
  const provider = new AnthropicProvider({ model: "test-model", client });
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(),
    retry: { attempts: 1, delayMs: () => 0 }, ...options,
  });
  return { runtime, provider, requests };
}

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

for (const failure of [400, 408, 429, 503, "connection"] as const) {
  test(`Anthropic ${failure} failure preserves the spending decision before any retry`, async t => {
    const db = new DatabaseSync(":memory:"); t.after(() => db.close());
    const spend = new SqliteModelCallStore(db); spend.initialize();
    const { runtime, requests } = transport([
      failure === "connection" ? new Error("connection lost")
        : { status: failure, requestId: "failed-request", body: { type: "error", error: { type: "api_error", message: "unavailable" } } },
      { status: 200, requestId: "ready-request", body: {
        id: "message-1", type: "message", role: "assistant", model: "test-model",
        content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8 },
      } },
    ], { retry: { attempts: 2, delayMs: () => 0 }, modelCalls: spend.hooks({
      quote: () => ({ scope: "app", limit: 30, amount: 30, pricing: { perToken: 1 } }),
      charge: usage => usage.freshInputTokens + usage.outputTokens,
    }) });
    const pending = runtime.turn({ agentId: "app", input: "Process supplied facts." });
    if (failure === 429) {
      const result = await pending;
      assert.equal(result.status, "reply");
      assert.deepEqual(result.modelCalls.map(call => [call.status, call.requestId, spend.inspect(call.callId)?.status]),
        [["rejected", "failed-request", "rejected"], ["responded", "ready-request", "accepted"]]);
      assert.equal(requests.length, 2);
      assert.equal(spend.inspectBudget("app").totalAmount, 20);
    } else {
      await assert.rejects(pending, error => {
        assert.ok(error instanceof RuntimeError && error.report);
        assert.equal(error.code, failure === 400 ? "provider_failed" : "model_call_denied");
        assert.equal(error.report.modelCalls[0].status, failure === 400 ? "rejected" : "unknown");
        return true;
      });
      assert.equal(requests.length, 1);
      assert.deepEqual(spend.inspectBudget("app"), failure === 400
        ? { acceptedAmount: 0, reservedAmount: 0, unknownAmount: 0, totalAmount: 0 }
        : { acceptedAmount: 0, reservedAmount: 0, unknownAmount: 30, totalAmount: 30 });
    }
  });
}

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
