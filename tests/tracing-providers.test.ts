import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider, type TraceEvent } from "../src/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

for (const kind of ["anthropic", "openai", "compatible"] as const) test(`${kind} trace captures the effective SDK request body and decoded response without credentials`, async () => {
  const events: TraceEvent[] = [], sent: unknown[] = [];
  const body = kind === "anthropic"
    ? { id: "message-1", type: "message", role: "assistant", model: "resolved-model", content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 7, output_tokens: 2 } }
    : kind === "openai"
      ? { id: "response-1", model: "resolved-model", status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }] }], usage: { input_tokens: 7, output_tokens: 2 } }
      : { model: "resolved-model", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "answer" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 } };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    assert.ok(new Headers(init?.headers).get(kind === "anthropic" ? "x-api-key" : "authorization")?.includes("test-secret-key"));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-request-id": "request-1", "request-id": "request-1" } });
  };
  const provider: ModelProvider = kind === "anthropic"
    ? new AnthropicProvider({ model: "selected-model", thinking: { type: "adaptive", effort: "high" }, client: new Anthropic({ apiKey: "test-secret-key", fetch }) })
    : kind === "openai" ? new OpenAIProvider({ model: "selected-model", apiKey: "test-secret-key", reasoningEffort: "high", fetch })
      : new OpenAICompatibleProvider({ model: "selected-model", apiKey: "test-secret-key", baseURL: "https://fixture.invalid/v1", fetch });
  const app = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("selected instructions"), memory: new EmptyMemorySource(),
    tracing: { content: { maxBytes: 100_000 }, sink: { record: event => { events.push(event); } } } });
  const result = await app.turn({ agentId: "agent", input: "selected input", maxTokens: 77 });
  const requests = events.filter(event => event.type === "model.request" && event.format === "provider");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].content?.status === "captured");
  assert.deepEqual(requests[0].content.value, sent[0]);
  const response = events.find(event => event.type === "model.response" && event.format === "provider");
  assert.ok(response?.content?.status === "captured");
  assert.equal((response.content.value as any).model, "resolved-model");
  assert.equal(response.spanId, requests[0].spanId);
  assert.equal(result.usage[0].model, "resolved-model");
  assert.doesNotMatch(JSON.stringify(events), /test-secret-key|authorization|x-api-key/);
});
