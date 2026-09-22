import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, type AnthropicProviderOptions } from "../src/providers/anthropic.js";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry, type RuntimeOptions } from "../src/index.js";
import { SqliteModelSpendStore, SqliteModelStepStore } from "../src/durable/sqlite.js";

type AdaptiveThinking = { type: "adaptive"; effort?: "low" | "medium" | "high" | "xhigh" | "max" };

function message(content: unknown[] = [{ type: "text", text: "Processed." }], stopReason = "end_turn") {
  return { id: "message-1", type: "message", role: "assistant", model: "test-model", content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 } };
}

function transport(bodies: unknown[], thinking?: AdaptiveThinking, options: Partial<RuntimeOptions> = {}) {
  const requests: Record<string, any>[] = [];
  const client = new Anthropic({ apiKey: "test-only", maxRetries: 4, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    assert.ok(bodies.length, "unexpected extra HTTP attempt");
    return new Response(JSON.stringify(bodies.shift()), { status: 200,
      headers: { "content-type": "application/json", "request-id": `request-${requests.length}` } });
  } });
  const configuration: AnthropicProviderOptions & { thinking?: AdaptiveThinking } = { model: "test-model", client,
    ...(thinking === undefined ? {} : { thinking }) };
  const provider = new AnthropicProvider(configuration);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Process supplied facts."),
    memory: new EmptyMemorySource(), retry: { attempts: 1, delayMs: () => 0 }, ...options });
  return { provider, runtime, requests, configuration };
}

for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"] as const) {
  test(`adaptive thinking sends a total output ceiling with ${effort ?? "default"} effort`, async () => {
    const { runtime, requests } = transport([message()], { type: "adaptive", ...(effort ? { effort } : {}) });
    const result = await runtime.turn({ agentId: "app", input: "Process.", maxTokens: 2_048 });
    assert.equal(result.output, "Processed.");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].thinking, { type: "adaptive" });
    assert.equal(requests[0].max_tokens, 2_048);
    assert.deepEqual(requests[0].output_config, effort ? { effort } : undefined);
    assert.equal(result.usage[0].outputTokens, 8);
  });
}

test("adaptive effort and the application structured schema both reach the provider", async () => {
  const schema = { type: "object", properties: { selectedId: { type: "string", enum: ["item-7"] } },
    required: ["selectedId"], additionalProperties: false };
  const { runtime, requests } = transport([message([{ type: "text", text: '{"selectedId":"item-7"}' }])],
    { type: "adaptive", effort: "medium" });
  const result = await runtime.turn({ agentId: "app", input: "Select item-7.", maxTokens: 1_024,
    structuredOutput: { schema, parse: value => { assert.deepEqual(value, { selectedId: "item-7" }); return value; } } });
  assert.deepEqual(result.value, { selectedId: "item-7" });
  assert.deepEqual(requests[0].thinking, { type: "adaptive" });
  assert.deepEqual(requests[0].output_config, { effort: "medium", format: { type: "json_schema", schema } });
  assert.equal(requests[0].tools, undefined);
});

test("adaptive tool calls preserve signed thinking and exact tool IDs through the next HTTP request", async () => {
  const first = [
    { type: "thinking", thinking: "Consider the supplied identifier.", signature: "signed-block-7" },
    { type: "redacted_thinking", data: "opaque-redacted-7" },
    { type: "tool_use", id: "tool-call-7", name: "read_item", input: { itemId: "item-7" } },
  ];
  let reads = 0;
  const tools = new ToolRegistry([{ name: "read_item", description: "Read a selected item", inputSchema: {}, mode: "read",
    execute: (input, context) => {
      reads++;
      assert.deepEqual(input, { itemId: "item-7" });
      assert.equal(context.toolCallId, "tool-call-7");
      return { itemId: "item-7", label: "Selected item" };
    } }]);
  const { runtime, requests } = transport([message(first, "tool_use"), message([
    { type: "thinking", thinking: "Private reasoning stays outside the answer.", signature: "signed-final" },
    { type: "text", text: "Selected item is available." },
  ])], { type: "adaptive", effort: "high" }, { tools });
  const result = await runtime.turn({ agentId: "app", input: "Read item-7.", maxTokens: 2_048 });
  assert.equal(reads, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages[1], { role: "assistant", content: first });
  assert.deepEqual(requests[1].messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-call-7",
    content: '{"itemId":"item-7","label":"Selected item"}' }] });
  assert.deepEqual(requests.map(request => [request.thinking, request.output_config, request.max_tokens]),
    [[{ type: "adaptive" }, { effort: "high" }, 2_048], [{ type: "adaptive" }, { effort: "high" }, 2_048]]);
  assert.equal(result.output, "Selected item is available.");
  assert.equal(result.toolCalls[0].id, "tool-call-7");
  assert.equal(result.usage.reduce((total, usage) => total + usage.outputTokens, 0), 16);
});

test("a manual turn budget conflicts with adaptive thinking before context loading, admission, or HTTP", async () => {
  let loads = 0, admissions = 0;
  const { runtime, requests } = transport([message()], { type: "adaptive" }, {
    persona: { load: async () => { loads++; return "Instructions."; } },
    memory: { load: async () => { loads++; return []; } },
    modelCalls: { admit: () => { admissions++; return true; } },
  });
  await assert.rejects(runtime.turn({ agentId: "app", input: "Process.", thinking: { budgetTokens: 1_024 } }),
    { code: "thinking_unsupported" });
  assert.equal(loads, 0);
  assert.equal(admissions, 0);
  assert.equal(requests.length, 0);
});

test("direct provider calls also reject a manual budget combined with adaptive thinking before HTTP", async () => {
  const { provider, requests } = transport([message()], { type: "adaptive" });
  await assert.rejects(provider.complete({ system: [{ text: "Instructions." }], messages: [{ role: "user", content: "Process." }],
    tools: [], maxTokens: 512, thinking: { enabled: true, budgetTokens: 1_024 }, signal: new AbortController().signal }),
  { code: "thinking_unsupported" });
  assert.equal(requests.length, 0);
});

test("provider configuration remains fixed when callers mutate their original adaptive options", async () => {
  const thinking: AdaptiveThinking = { type: "adaptive", effort: "medium" };
  const { runtime, requests, configuration } = transport([message()], thinking);
  thinking.effort = "max";
  configuration.thinking = { type: "adaptive", effort: "low" };
  await runtime.turn({ agentId: "app", input: "Process." });
  assert.deepEqual(requests[0].thinking, { type: "adaptive" });
  assert.deepEqual(requests[0].output_config, { effort: "medium" });
});

test("legacy manual thinking retains its additional allowance and unconfigured calls remain unchanged", async () => {
  const { runtime, requests } = transport([message(), message()]);
  await runtime.turn({ agentId: "app", input: "Process.", maxTokens: 512, thinking: { budgetTokens: 1_024 } });
  await runtime.turn({ agentId: "app", input: "Process.", maxTokens: 512 });
  assert.equal(requests[0].max_tokens, 1_536);
  assert.deepEqual(requests[0].thinking, { type: "enabled", budget_tokens: 1_024 });
  assert.equal(requests[0].output_config, undefined);
  assert.equal(requests[1].max_tokens, 512);
  assert.equal(requests[1].thinking, undefined);
  assert.equal(requests[1].output_config, undefined);
});

test("malformed adaptive provider options fail during construction", () => {
  for (const value of [null, [], "adaptive", {}, { type: "enabled" }, { type: "adaptive", effort: "extreme" },
    { type: "adaptive", effort: 1 }, { type: "adaptive", effort: null }, { type: "adaptive", budgetTokens: 1_024 }]) {
    assert.throws(() => transport([], value as AdaptiveThinking), TypeError);
  }
});

test("adaptive calls share spending admission and completed replay preserves the provider profile contract", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const spend = new SqliteModelSpendStore(db), steps = new SqliteModelStepStore(db);
  spend.initialize(); steps.initialize();
  const hooks = spend.hooks({
    quote: context => {
      assert.equal(context.maxTokens, 16);
      assert.equal(context.thinking, undefined);
      return { scope: "app:budget", limit: 28, amount: context.maxTokens + 12, pricing: { inputAllowance: 12, unitPrice: 1 } };
    },
    charge: usage => usage.freshInputTokens + usage.outputTokens,
  });
  const { runtime, requests } = transport([message()], { type: "adaptive", effort: "medium" }, { modelCalls: hooks });
  const request = { scope: "app", id: "step-1", kind: "describe", version: "1", input: {
    providerProfile: { model: "test-model", thinking: "adaptive", effort: "medium" },
  } };
  const input = { agentId: "app", input: "Process.", allowedTools: [], maxTokens: 16 };
  const first = await steps.run(request, runtime, input);
  assert.deepEqual(requests[0].thinking, { type: "adaptive" });
  assert.equal(requests[0].max_tokens, 16);
  assert.equal(spend.inspectBudget("app:budget").totalAmount, 20);
  const saved = spend.inspect(first.result.modelCalls[0].callId)!;
  assert.equal(saved.quote.amount, 28);
  assert.equal(saved.chargedAmount, 20);
  const replay = await steps.run(request, runtime, input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  await assert.rejects(steps.run({ ...request, input: { providerProfile: { ...request.input.providerProfile, effort: "high" } } }, runtime, input),
    { code: "contract_conflict" });
  await assert.rejects(runtime.turn(input), { code: "model_call_denied" });
  assert.equal(requests.length, 1);
  assert.equal(spend.inspectBudget("app:budget").totalAmount, 20);
});
