import assert from "node:assert/strict";
import test from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type TraceEvent } from "../src/index.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

for (const effort of [undefined, "none", "medium"]) test(`compatible reasoning ${effort ?? 'default'} reaches the wire and trace`, async () => {
  const sent: Record<string, unknown>[] = [], events: TraceEvent[] = [];
  const provider = new OpenAICompatibleProvider({ model: "local", baseURL: "http://fixture.invalid/v1",
    reasoningEffort: effort, fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ model: "local", choices: [{ finish_reason: "stop",
        message: { role: "assistant", content: "complete answer", reasoning: "private thinking" } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 } }), { headers: { "content-type": "application/json" } });
    } });
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("instructions"), memory: new EmptyMemorySource(),
    tracing: { content: { maxBytes: 10_000 }, sink: { record: event => { events.push(event); } } } });
  const result = await runtime.turn({ agentId: "agent", input: "question", maxTokens: 123 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reasoning_effort, effort);
  assert.equal(Object.hasOwn(sent[0], 'reasoning_effort'), effort !== undefined);
  assert.equal(sent[0].max_tokens, 123);
  const trace = events.find(event => event.type === "model.request" && event.format === "provider");
  assert.ok(trace?.content?.status === "captured");
  assert.deepEqual(trace.content.value, sent[0]);
  assert.equal(result.status, "reply");
  if (result.status === "reply") assert.equal(result.output, "complete answer");
});
