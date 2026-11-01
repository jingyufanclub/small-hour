import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry, type ProviderRequest } from "../src/index.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { parseObject } from "./fixtures/tool-input.js";

const png = { type: "image", mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP8/x8AAwMCAO+jA1kAAAAASUVORK5CYII=" } as const;
const webp = { type: "image", mediaType: "image/webp", data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA" } as const;
const input = [{ type: "text", text: "Compare these two items with the inventory." }, png, webp] as const;
const wire = [{ type: "text", text: input[0].text },
  { type: "image_url", image_url: { url: `data:image/png;base64,${png.data}` } },
  { type: "image_url", image_url: { url: `data:image/webp;base64,${webp.data}` } }];

test("local vision preserves both images through HTTP and a tool continuation with per-call accounting", async t => {
  const bodies: Array<Record<string, any>> = [], events: string[] = [];
  const native = { role: "assistant", content: null, tool_calls: [{ id: "lookup-7", type: "function",
    function: { name: "lookup", arguments: '{"id":"item-7"}' } }] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString())); events.push("http");
    res.writeHead(200, { "content-type": "application/json", "x-request-id": `request-${bodies.length}` });
    res.end(JSON.stringify({ id: `response-${bodies.length}`, model: "local-vision", choices: [{
      message: bodies.length === 1 ? native : { role: "assistant", content: "Compared." },
      finish_reason: bodies.length === 1 ? "tool_calls" : "stop",
    }], usage: { prompt_tokens: 24, completion_tokens: 8 } }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let reads = 0;
  const app = new SmallHourRuntime({
    provider: new OpenAICompatibleProvider({ model: "local-vision", baseURL: `http://127.0.0.1:${address.port}/v1`,
      capabilities: { images: true, tools: true } }),
    persona: new StaticPersonaSource("Use supplied facts."), memory: new EmptyMemorySource(),
    tools: new ToolRegistry([{ name: "lookup", mode: "read", description: "Read inventory", inputSchema: {}, parse: parseObject,
      execute(value) { reads++; assert.deepEqual(value, { id: "item-7" }); return { available: true }; } }]),
    modelCalls: { admit() { events.push("admit"); return true; }, record() { events.push("record"); } },
    retry: { attempts: 1, delayMs: () => 0 },
  });
  const result = await app.turn({ agentId: "reader", input, allowedTools: ["lookup"] });
  assert.equal(result.status, "reply"); assert.equal(reads, 1);
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.deepEqual(body.messages[1], { role: "user", content: wire });
  assert.deepEqual(bodies[1].messages.slice(2), [native, { role: "tool", tool_call_id: "lookup-7", content: '{"available":true}' }]);
  assert.deepEqual(events, ["admit", "http", "record", "admit", "http", "record"]);
  assert.deepEqual(result.modelCalls.map(call => [call.status, call.requestId]), [["responded", "request-1"], ["responded", "request-2"]]);
});

test("local vision separates tool results from adjacent pictures and validates before sending", async () => {
  const bodies: any[] = [];
  const provider = new OpenAICompatibleProvider({ model: "local-vision", baseURL: "http://fixture.invalid/v1", capabilities: { images: true },
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ choices: [
      { message: { role: "assistant", content: "Read." }, finish_reason: "stop" }], usage: {} }), { status: 200 }); } });
  const request: ProviderRequest = { system: [], tools: [], maxTokens: 100, signal: new AbortController().signal,
    messages: [{ role: "user", content: [...input, { type: "tool_result", toolUseId: "lookup-7", content: "Available." }, png] }] };
  await provider.complete(request);
  assert.deepEqual(bodies[0].messages.slice(1), [{ role: "user", content: wire },
    { role: "tool", tool_call_id: "lookup-7", content: "Available." }, { role: "user", content: [wire[1]] }]);
  for (const content of [[{ ...png, data: "invalid" }], [{ type: "image", url: "https://unselected.invalid/private.png" }], Array.from({ length: 21 }, () => png)]) {
    await assert.rejects(provider.complete({ ...request, messages: [{ role: "user", content } as ProviderRequest["messages"][number]] }),
      (error: any) => ["invalid_input", "image_input_limit"].includes(error.code));
  }
  assert.equal(bodies.length, 1);
});
