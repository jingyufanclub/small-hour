import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, type AnthropicProviderOptions } from "../src/providers/anthropic.js";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type TraceEvent } from "../src/index.js";

function fixture(temperature?: number) {
  const requests: Record<string, any>[] = [];
  const client = new Anthropic({ apiKey: "test-only", maxRetries: 4, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "decision-1", type: "message", role: "assistant", model: "test-model",
      content: [{ type: "text", text: '{"selectedId":"item-2"}' }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 8 } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const options: AnthropicProviderOptions & { temperature?: number } = { model: "test-model", client,
    ...(temperature === undefined ? {} : { temperature }) };
  return { options, requests };
}

for (const temperature of [undefined, 0, 0.5, 1]) {
  test(`structured decisions preserve ${temperature ?? "omitted"} temperature in HTTP and trace`, async () => {
    const { options, requests } = fixture(temperature);
    const provider = new AnthropicProvider(options);
    options.temperature = 0.9;
    const events: TraceEvent[] = [];
    const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Choose an offered ID."),
      memory: new EmptyMemorySource(), maxModelCalls: 1, retry: { attempts: 1 },
      tracing: { content: { maxBytes: 20_000 }, sink: { record: event => { events.push(event); } } } });
    const schema = { type: "object", properties: { selectedId: { type: "string", enum: ["item-2"] } },
      required: ["selectedId"], additionalProperties: false };
    const result = await runtime.turn({ agentId: "app", input: "item-2", maxTokens: 512,
      structuredOutput: { schema, parse: value => { assert.deepEqual(value, { selectedId: "item-2" }); return value; } } });
    assert.deepEqual(result.value, { selectedId: "item-2" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].temperature, temperature);
    assert.equal(Object.hasOwn(requests[0], "temperature"), temperature !== undefined);
    assert.equal(requests[0].max_tokens, 512);
    assert.deepEqual(requests[0].output_config, { format: { type: "json_schema", schema } });
    const captured = events.find(event => event.type === "model.request" && event.format === "provider");
    assert.equal(captured?.content?.status, "captured");
    assert.deepEqual(captured?.content?.status === "captured" ? captured.content.value : null, requests[0]);
  });
}

test("invalid sampling settings fail before dispatch", () => {
  for (const temperature of [-0.1, 1.1, NaN, Infinity, "0", null]) {
    const { options, requests } = fixture();
    Object.assign(options, { temperature });
    assert.throws(() => new AnthropicProvider(options), /temperature/);
    assert.equal(requests.length, 0);
  }
});

test("sampling and thinking cannot silently change each other's configuration", async () => {
  const { options, requests } = fixture(0);
  assert.throws(() => new AnthropicProvider({ ...options, thinking: { type: "adaptive" } }), /temperature/);
  const provider = new AnthropicProvider(options);
  let admissions = 0;
  await assert.rejects(new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Choose."),
    memory: new EmptyMemorySource(), modelCalls: { admit: () => { admissions++; return true; } } })
    .turn({ agentId: "app", input: "item-2", thinking: { budgetTokens: 1024 } }), { code: "thinking_unsupported" });
  assert.equal(admissions, 0);
  await assert.rejects(provider.complete({ system: [], messages: [], tools: [], maxTokens: 512,
    thinking: { enabled: true, budgetTokens: 1024 }, signal: new AbortController().signal }), { code: "thinking_unsupported" });
  assert.equal(requests.length, 0);
});
