import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelProvider, type ProviderRequest, type UserBlock } from "../src/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

const png = { type: "image", mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1kAAAAASUVORK5CYII=" } as const;
const jpeg = { type: "image", mediaType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).toString("base64") } as const;
const content = [{ type: "text", text: "First image:" }, png, { type: "text", text: "Second image:" }, jpeg] as const;

function wireContent(protocol: "anthropic" | "responses") {
  return content.map(block => block.type === "text"
    ? { type: protocol === "anthropic" ? "text" : "input_text", text: block.text }
    : protocol === "anthropic"
      ? { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } }
      : { type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` });
}

function anthropicResponse(blocks: unknown[] = [{ type: "text", text: "Processed." }], stop = "end_turn") {
  return { id: "message-1", type: "message", role: "assistant", model: "fixture", content: blocks,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 24, output_tokens: 8 } };
}

function responsesResponse(output: unknown[] = [{ type: "message", id: "message-1", role: "assistant", status: "completed",
  phase: "final_answer", content: [{ type: "output_text", text: "Processed.", annotations: [] }] }]) {
  return { id: "response-1", model: "fixture", status: "completed", output, usage: { input_tokens: 24, output_tokens: 8 } };
}

function transport(protocol: "anthropic" | "responses" | "compatible", bodies: unknown[]) {
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    assert.ok(bodies.length, "unexpected HTTP request");
    return new Response(JSON.stringify(bodies.shift()), { status: 200,
      headers: { "content-type": "application/json", "request-id": "request-1", "x-request-id": "request-1" } });
  };
  const provider: ModelProvider = protocol === "anthropic"
    ? new AnthropicProvider({ model: "fixture", client: new Anthropic({ apiKey: "fixture-only", fetch }) })
    : protocol === "responses"
      ? new OpenAIProvider({ model: "fixture", apiKey: "fixture-only", fetch })
      : new OpenAICompatibleProvider({ model: "fixture", baseURL: "http://fixture.invalid/v1", fetch });
  return { provider, requests };
}

function request(blocks: readonly unknown[]): ProviderRequest {
  return { system: [{ text: "Process supplied facts." }], messages: [{ role: "user", content: blocks as UserBlock[] }],
    tools: [], maxTokens: 512, signal: new AbortController().signal };
}

for (const protocol of ["anthropic", "responses"] as const) {
  const response = protocol === "anthropic" ? anthropicResponse : responsesResponse;

  test(`${protocol} maps ordered text and image bytes without fetching media`, async () => {
    const { provider, requests } = transport(protocol, [response()]);
    await provider.complete(request(content));
    assert.equal(provider.capabilities?.images, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, protocol === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/responses");
    const messages = protocol === "anthropic" ? requests[0].body.messages : requests[0].body.input;
    assert.deepEqual(messages, [{ role: "user", content: wireContent(protocol) }]);
  });

  test(`${protocol} image input survives native history and a host tool round trip`, async () => {
    const native = protocol === "anthropic"
      ? [{ type: "thinking", thinking: "Read the supplied record.", signature: "signed-7" },
        { type: "tool_use", id: "call-7", name: "lookup", input: { recordId: "item-7" } }]
      : [{ type: "reasoning", id: "reasoning-7", summary: [], encrypted_content: "opaque-7" },
        { type: "message", id: "commentary-1", role: "assistant", status: "completed", phase: "commentary",
          content: [{ type: "output_text", text: "Reading the record.", annotations: [] }] },
        { type: "function_call", id: "function-7", call_id: "call-7", name: "lookup", arguments: '{"recordId":"item-7"}', status: "completed" }];
    const first = protocol === "anthropic" ? anthropicResponse(native, "tool_use") : responsesResponse(native);
    const { provider, requests } = transport(protocol, [first, response()]);
    let reads = 0;
    const tools = new ToolRegistry([{ name: "lookup", mode: "read", description: "Read the selected record",
      inputSchema: { type: "object", properties: { recordId: { type: "string" } }, required: ["recordId"], additionalProperties: false },
      execute: (input, context) => {
        reads++;
        assert.deepEqual(input, { recordId: "item-7" });
        assert.equal(context.toolCallId, "call-7");
        return { recordId: "item-7", available: true };
      } }]);
    const app = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use supplied facts."), memory: new EmptyMemorySource(),
      tools, retry: { attempts: 1, delayMs: () => 0 } });
    const result = await app.turn({ agentId: "app", input: content });
    assert.equal(reads, 1);
    assert.equal(requests.length, 2);
    const inputs = requests.map(item => protocol === "anthropic" ? item.body.messages : item.body.input);
    for (const input of inputs) assert.deepEqual(input[0], { role: "user", content: wireContent(protocol) });
    if (protocol === "anthropic") {
      assert.deepEqual(inputs[1][1], { role: "assistant", content: native });
      assert.deepEqual(inputs[1][2], { role: "user", content: [{ type: "tool_result", tool_use_id: "call-7",
        content: '{"recordId":"item-7","available":true}' }] });
    } else {
      assert.deepEqual(inputs[1].slice(1, 1 + native.length), native);
      assert.deepEqual(inputs[1].at(-1), { type: "function_call_output", call_id: "call-7", output: '{"recordId":"item-7","available":true}' });
    }
    assert.equal(result.output, "Processed.");
    assert.equal(result.toolCalls[0].id, "call-7");
    assert.deepEqual(result.modelCalls.map(call => call.stop), protocol === "anthropic"
      ? [{ reason: "tool_use", nativeReason: "tool_use" }, { reason: "end_turn", nativeReason: "end_turn" }]
      : [{ reason: "tool_use" }, { reason: "end_turn" }]);
  });

  test(`${protocol} direct image calls reject invalid bytes and remote references before HTTP`, async t => {
    const malformed = [
      { ...png, data: "aHR0cHM6Ly9maXh0dXJlLmludmFsaWQvcGhvdG8ucG5n" },
      { ...png, data: `${png.data}\n` },
      { ...png, mediaType: "image/jpeg" },
      { type: "image", url: "https://fixture.invalid/photo.png" },
      { type: "image", mediaType: "image/png", data: "https://fixture.invalid/photo.png" },
    ];
    for (const [index, block] of malformed.entries()) await t.test(`invalid form ${index + 1}`, async () => {
      const { provider, requests } = transport(protocol, [response()]);
      await assert.rejects(provider.complete(request([block])), error => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.code, "invalid_input");
        assert.equal(error.message.includes("fixture.invalid"), false);
        assert.equal(error.message.includes(png.data), false);
        return true;
      });
      assert.equal(requests.length, 0);
    });
  });

  test(`${protocol} direct image calls enforce the shared image count before HTTP`, async () => {
    const { provider, requests } = transport(protocol, [response()]);
    await assert.rejects(provider.complete(request(Array.from({ length: 21 }, () => png))), { code: "image_input_limit" });
    assert.equal(requests.length, 0);
  });

  test(`${protocol} direct image calls reject accessors and nonplain blocks before reading or HTTP`, async t => {
    for (const kind of ["data accessor", "type accessor", "nonplain object"] as const) await t.test(kind, async () => {
      let reads = 0;
      const block = kind === "nonplain object" ? Object.assign(Object.create({ marker: true }), png) : { ...png };
      if (kind === "data accessor") Object.defineProperty(block, "data", { enumerable: true, get: () => ++reads === 1 ? png.data : "invalid-base64" });
      if (kind === "type accessor") Object.defineProperty(block, "type", { enumerable: true, get: () => ++reads === 1 ? "image" : "tool_result" });
      const { provider, requests } = transport(protocol, [response()]);
      await assert.rejects(provider.complete(request([block])), { code: "invalid_input" });
      assert.equal(reads, 0);
      assert.equal(requests.length, 0);
    });
  });

  test(`${protocol} plain string requests preserve their existing wire shape`, async () => {
    const { provider, requests } = transport(protocol, [response()]);
    await provider.complete({ ...request([]), messages: [{ role: "user", content: "Process the supplied facts." }] });
    const messages = protocol === "anthropic" ? requests[0].body.messages : requests[0].body.input;
    assert.deepEqual(messages, [{ role: "user", content: "Process the supplied facts." }]);
  });
}

test("Responses separates tool results from adjacent ordered multimodal user content", async () => {
  const { provider, requests } = transport("responses", [responsesResponse()]);
  const blocks = [...content, { type: "tool_result", toolUseId: "call-9", content: "Recorded." }, png,
    { type: "text", text: "Read this after the result." }];
  await provider.complete(request(blocks));
  assert.deepEqual(requests[0].body.input, [
    { role: "user", content: wireContent("responses") },
    { type: "function_call_output", call_id: "call-9", output: "Recorded." },
    { role: "user", content: [{ type: "input_image", image_url: `data:${png.mediaType};base64,${png.data}` },
      { type: "input_text", text: "Read this after the result." }] },
  ]);
});

test("Responses preserves the wire shape of existing text-only user blocks", async () => {
  const { provider, requests } = transport("responses", [responsesResponse()]);
  await provider.complete(request([{ type: "text", text: "First fact." }, { type: "text", text: "Second fact." },
    { type: "tool_result", toolUseId: "call-9", content: "Recorded." }, { type: "text", text: "After the result." }]));
  assert.deepEqual(requests[0].body.input, [
    { role: "user", content: "First fact." },
    { role: "user", content: "Second fact." },
    { type: "function_call_output", call_id: "call-9", output: "Recorded." },
    { role: "user", content: "After the result." },
  ]);
});

test("compatible endpoints reject direct image requests without contacting the server", async () => {
  const { provider, requests } = transport("compatible", []);
  assert.equal(provider.capabilities?.images, false);
  await assert.rejects(provider.complete(request([png])), { code: "images_unsupported" });
  assert.equal(requests.length, 0);
});
