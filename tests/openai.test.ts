import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelProvider, type RuntimeOptions } from "../src/index.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

function transport(bodies: unknown[], statuses: number[] = []) {
  const requests: Array<{ url: string; body: any; options: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)), options: options ?? {} });
    assert.ok(bodies.length, "unexpected HTTP attempt");
    return new Response(JSON.stringify(bodies.shift()), { status: statuses.shift() ?? 200,
      headers: { "content-type": "application/json", "x-request-id": `request-${requests.length}` },
    });
  };
  return { fetch, requests };
}

const message = (text: string, phase?: string) => ({ type: "message", id: "message-1", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }], ...(phase ? { phase } : {}),
});
const response = (output: unknown[] = [message("done")]) => ({ id: "response-1", model: "test-model", status: "completed", output,
  usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 } },
});
const completion = (content: string | null = "done", tool_calls?: unknown[]) => ({ model: "test-model",
  choices: [{ index: 0, finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) } }],
  usage: { prompt_tokens: 30, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens: 8 },
});
const schema = { type: "object", properties: { selectedId: { type: "string", enum: ["item-7"] } },
  required: ["selectedId"], additionalProperties: false,
};
const lookupSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
function runtime(provider: ModelProvider, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use the supplied IDs."), memory: new EmptyMemorySource(),
    retry: { attempts: 1, delayMs: () => 0 }, ...options,
  });
}
async function failure(promise: Promise<unknown>, code: string) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof RuntimeError && error.report);
    assert.equal(error.code, code);
    return error.report;
  }
  assert.fail(`expected ${code}`);
}

test("OpenAI sends app context and exact schema in a stateless Responses request", async () => {
  const { fetch, requests } = transport([response([message('{"selectedId":"item-7"}')])]);
  const provider = new OpenAIProvider({ model: "test-model", apiKey: "test-key", fetch, reasoningEffort: "low" });
  const result = await runtime(provider, { memory: { load: async () => [{ role: "user", content: "The pending selection is item-7." }] } })
    .turn({ agentId: "router", input: "Use that selection.", maxTokens: 900, structuredOutput: { schema,
      parse: (value) => { assert.deepEqual(value, { selectedId: "item-7" }); return value; },
    } });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(new Headers(request.options.headers).get("authorization"), "Bearer test-key");
  assert.equal(request.body.instructions, "Use the supplied IDs.");
  assert.deepEqual(request.body.input, [{ role: "user", content: "The pending selection is item-7." }, { role: "user", content: "Use that selection." }]);
  assert.equal(request.body.store, false);
  assert.equal(request.body.truncation, "disabled");
  assert.equal(request.body.previous_response_id, undefined);
  assert.equal(request.body.max_output_tokens, 900);
  assert.deepEqual(request.body.reasoning, { effort: "low" });
  assert.deepEqual(request.body.text.format, { type: "json_schema", name: "small_hour_result", strict: true, schema });
  assert.deepEqual(result.value, { selectedId: "item-7" });
  assert.equal(result.modelCalls[0].requestId, "request-1");
  assert.deepEqual(result.usage[0], { model: "test-model", freshInputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 8 });
});

test("OpenAI preserves native reasoning, phases, and tool call IDs through a real host tool", async () => {
  const native = [
    { type: "reasoning", id: "reasoning-7", summary: [], encrypted_content: "opaque-proof" },
    message("Looking up the selected item.", "commentary"),
    { type: "function_call", id: "function-7", call_id: "call-7", name: "lookup", arguments: '{"id":"item-7"}', status: "completed" },
  ];
  const { fetch, requests } = transport([response(native), response([message("Analysis completed.", "commentary"), message("Available.", "final_answer")])]);
  let reads = 0;
  const tools = new ToolRegistry([{ name: "lookup", mode: "read", description: "Read the chosen item", inputSchema: lookupSchema,
    parse: (input) => { assert.deepEqual(input, { id: "item-7" }); return input; },
    execute: () => { reads++; return { id: "item-7", available: true }; },
  }]);
  const result = await runtime(new OpenAIProvider({ model: "test-model", apiKey: "test-key", fetch }), { tools })
    .turn({ agentId: "router", input: "Read item-7." });
  assert.equal(reads, 1);
  assert.equal(result.output, "Available.");
  assert.equal(requests[0].body.tools[0].type, "function");
  assert.deepEqual(requests[0].body.tools[0].parameters, lookupSchema);
  assert.deepEqual(requests[1].body.input.slice(1, 1 + native.length), native);
  assert.deepEqual(requests[1].body.input.at(-1), { type: "function_call_output", call_id: "call-7", output: '{"id":"item-7","available":true}' });
  assert.equal(result.toolCalls[0].id, "call-7");
});

test("OpenAI accepts a completed answer with a null phase", async () => {
  const { fetch, requests } = transport([response([{ ...message("Available."), phase: null }])]);
  const result = await runtime(new OpenAIProvider({ model: "test-model", apiKey: "test-key", fetch }))
    .turn({ agentId: "router", input: "Read the supplied state." });
  assert.equal(result.output, "Available.");
  assert.equal(requests.length, 1);
});

test("local compatibility preserves a tool exchange and sends no implicit cloud credential", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "cloud-key-must-not-reach-local-server";
  t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
  const { fetch, requests } = transport([completion(null, [{ type: "function", id: "local-call", function: { name: "lookup", arguments: '{"id":"item-7"}' } }]), completion("Available.")]);
  const provider = new OpenAICompatibleProvider({ model: "loaded-model", baseURL: "http://127.0.0.1:11434/v1/", fetch, capabilities: { tools: true } });
  const tools = new ToolRegistry([{ name: "lookup", mode: "read", description: "Read an item", inputSchema: lookupSchema,
    execute: (input) => ({ id: (input as { id: string }).id, available: true }),
  }]);
  const result = await runtime(provider, { tools }).turn({ agentId: "router", input: "Read item-7." });
  assert.equal(result.output, "Available.");
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(new Headers(requests[0].options.headers).has("authorization"), false);
  assert.equal(requests[0].body.max_tokens, 512);
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.tools[0].function.name, "lookup");
  assert.deepEqual(requests[1].body.messages.at(-1), { role: "tool", tool_call_id: "local-call", content: '{"id":"item-7","available":true}' });
  assert.equal(requests[1].body.messages.at(-2).tool_calls[0].id, "local-call");
});

test("local structured output requires explicit capability and retains host validation", async () => {
  const { fetch, requests } = transport([completion('{"selectedId":"item-7"}')]);
  const provider = new OpenAICompatibleProvider({ model: "loaded-model", baseURL: "http://localhost:1234/v1", fetch, capabilities: { structuredOutput: true } });
  const result = await runtime(provider).turn({ agentId: "router", input: "Select item-7.", structuredOutput: { schema,
    parse: (value) => { assert.deepEqual(value, { selectedId: "item-7" }); return value; },
  } });
  assert.equal(result.status, "structured");
  assert.deepEqual(requests[0].body.response_format, { type: "json_schema", json_schema: { name: "small_hour_result", strict: true, schema } });
  assert.equal(requests[0].body.tools, undefined);
});

test("HTTP body serialization failure cannot be retried as a connection failure", async () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const { fetch, requests } = transport([]);
  let admissions = 0;
  const tools = new ToolRegistry([{ name: "read", mode: "read", description: "Read", inputSchema: circular, execute: () => ({}) }]);
  await failure(runtime(new OpenAIProvider({ model: "test-model", apiKey: "test-key", fetch }), {
    tools, retry: { attempts: 3, delayMs: () => 0 }, modelCalls: { admit: () => { admissions++; return true; } },
  }).turn({ agentId: "a", input: "go" }), "provider_failed");
  assert.equal(requests.length, 0);
  assert.equal(admissions, 1);
});

test("native HTTP transport obeys the runtime attempt budget and does not follow redirects", async (t) => {
  const paths: string[] = [];
  const events: string[] = [];
  const server = createServer((request, reply) => {
    paths.push(request.url!); events.push("http");
    request.resume();
    reply.setHeader("x-request-id", `native-${paths.length}`);
    if (request.url === "/redirect/chat/completions") {
      reply.writeHead(307, { location: "/unexpected-cloud-fallback" }); reply.end();
    } else if (paths.length === 1) {
      reply.writeHead(429, { "content-type": "application/json" }); reply.end(JSON.stringify({ error: "busy" }));
    } else {
      reply.writeHead(200, { "content-type": "application/json" }); reply.end(JSON.stringify(completion()));
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const result = await runtime(new OpenAICompatibleProvider({ model: "test-model", baseURL: `${base}/v1` }), {
    maxModelCalls: 2, retry: { attempts: 2, delayMs: () => 0 }, modelCalls: {
      admit: () => { events.push("admit"); return true; }, record: () => { events.push("record"); },
    },
  }).turn({ agentId: "a", input: "go" });
  assert.equal(result.output, "done");
  assert.deepEqual(events, ["admit", "http", "record", "admit", "http", "record"]);
  await failure(runtime(new OpenAICompatibleProvider({ model: "test-model", baseURL: `${base}/redirect`, apiKey: "test-only" }))
    .turn({ agentId: "a", input: "go" }), "provider_failed");
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/chat/completions", "/redirect/chat/completions"]);
});

test("unsupported local features and incompatible thinking budgets start no model attempt", async (t) => {
  for (const feature of ["tools", "choice", "structured", "thinking"] as const) await t.test(feature, async () => {
    const { fetch, requests } = transport([]);
    const provider = new OpenAICompatibleProvider({ model: "plain-model", baseURL: "http://localhost:1234/v1", fetch });
    const tools = new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, execute: () => assert.fail("must not write") }]);
    let admissions = 0;
    const app = runtime(provider, { ...(feature === "tools" ? { tools } : {}), modelCalls: { admit: () => { admissions++; return true; } } });
    const report = await failure(feature === "structured"
      ? app.turn({ agentId: "a", input: "go", structuredOutput: { schema, parse: (value) => value } })
      : app.turn({ agentId: "a", input: "go", ...(feature === "thinking" ? { thinking: { budgetTokens: 200 } } : {}),
        ...(feature === "choice" ? { choice: { description: "Choose an ID", inputSchema: schema } } : {}) }),
    feature === "tools" || feature === "choice" ? "tools_unsupported" : feature === "structured" ? "structured_output_unsupported" : "thinking_unsupported");
    assert.equal(requests.length, 0); assert.equal(admissions, 0); assert.equal(report.modelCalls.length, 0);
  });
});

for (const protocol of ["responses", "chat"] as const) {
  const make = (fetch: typeof globalThis.fetch) => protocol === "responses"
    ? new OpenAIProvider({ model: "test-model", apiKey: "test-key", fetch })
    : new OpenAICompatibleProvider({ model: "test-model", baseURL: "http://localhost:1234/v1", fetch, capabilities: { tools: true, structuredOutput: true } });
  const success = () => protocol === "responses" ? response() : completion();

  test(`${protocol} HTTP attempts pass admission and accounting without hidden retries`, async () => {
    const { fetch, requests } = transport([{ error: { message: "busy" } }, success()], [429, 200]);
    const events: string[] = [];
    const result = await runtime(make(fetch), { maxModelCalls: 2, retry: { attempts: 2, delayMs: () => 0 }, modelCalls: {
      admit: () => { events.push(`admit:${requests.length}`); return true; },
      record: (call) => { events.push(`record:${call.status}:${requests.length}`); },
    } }).turn({ agentId: "a", input: "go" });
    assert.deepEqual(events, ["admit:0", "record:rejected:1", "admit:1", "record:responded:2"]);
    assert.equal(result.output, "done");
    assert.equal(requests.length, 2);
    const denied = transport([{ error: "busy" }], [429]);
    const report = await failure(runtime(make(denied.fetch), { maxModelCalls: 1, retry: { attempts: 3, delayMs: () => 0 } }).turn({ agentId: "a", input: "go" }), "model_call_limit");
    assert.equal(denied.requests.length, 1);
    assert.equal(report.modelCalls[0].requestId, "request-1");
  });

  test(`${protocol} incomplete and malformed tool output never causes a write`, async (t) => {
    for (const kind of ["incomplete", "malformed arguments", "withheld tool", "refusal", "filter"] as const) await t.test(kind, async () => {
      let writes = 0;
      const tools = new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, execute: () => ++writes }]);
      const args = kind === "malformed arguments" ? "{" : "{}";
      const body = protocol === "responses"
        ? kind === "filter" ? { ...response([]), status: "incomplete", incomplete_details: { reason: "content_filter" } }
          : kind === "refusal" ? response([{ ...message(""), content: [{ type: "refusal", refusal: "Cannot comply." }] }])
          : { ...response([{ type: "function_call", call_id: "write-1", name: "write", arguments: args }]),
            ...(kind === "incomplete" ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } : {}) }
        : kind === "filter" ? { ...completion(null), choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: null } }] }
          : kind === "refusal" ? { ...completion(null), choices: [{ finish_reason: "stop", message: { role: "assistant", content: null, refusal: "Cannot comply." } }] }
          : { ...completion(null, [{ type: "function", id: "write-1", function: { name: "write", arguments: args } }]),
            ...(kind === "incomplete" ? { choices: [{ finish_reason: "length", message: { role: "assistant", content: null,
              tool_calls: [{ type: "function", id: "write-1", function: { name: "write", arguments: args } }] } }] } : {}) };
      const { fetch, requests } = transport([body, success()]);
      const input = { agentId: "a", input: "go", ...(kind === "withheld tool" ? { allowedTools: [] } : {}) };
      if (kind === "withheld tool") {
        const result = await runtime(make(fetch), { tools }).turn(input);
        assert.equal(result.toolCalls[0].status, "not_started");
      } else {
        const pending = runtime(make(fetch), { tools, retry: { attempts: 3, delayMs: () => 0 } }).turn(input);
        if (kind === "refusal" || kind === "filter") await failure(pending, kind === "refusal" ? "provider_refused" : "provider_filtered");
        else await assert.rejects(pending, RuntimeError);
        assert.equal(requests.length, 1);
      }
      assert.equal(writes, 0);
    });
  });

  test(`${protocol} host validation rejects an invented selection without a repair call`, async () => {
    const body = protocol === "responses" ? response([message('{"selectedId":"invented"}')]) : completion('{"selectedId":"invented"}');
    const { fetch, requests } = transport([body]);
    const report = await failure(runtime(make(fetch), { retry: { attempts: 3, delayMs: () => 0 } }).turn({ agentId: "a", input: "Select item-7.",
      structuredOutput: { schema, parse: (value) => { assert.deepEqual(value, { selectedId: "item-7" }); return value; } },
    }), "structured_output_invalid");
    assert.equal(requests.length, 1);
    assert.equal(report.modelCalls[0].status, "responded");
  });

  test(`${protocol} a pending HTTP call receives cancellation with no later attempt`, async () => {
    const controller = new AbortController();
    let aborted = false;
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_, options) => {
      calls++;
      return await new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => { aborted = true; reject(options!.signal!.reason); }, { once: true });
        controller.abort(new Error("caller cancelled"));
      });
    };
    const report = await failure(runtime(make(fetch)).turn({ agentId: "a", input: "go", signal: controller.signal }), "turn_aborted");
    assert.equal(calls, 1); assert.equal(aborted, true);
    assert.equal(report.modelCalls[0].status, "unknown");
  });

  test(`${protocol} unknown usage and permanent failures retain response evidence`, async () => {
    for (const usage of [undefined, "invalid metadata", { input_tokens: -1, prompt_tokens: -1, output_tokens: 5, completion_tokens: 5 }]) {
      const missing = transport([{ ...success(), usage }]);
      const result = await runtime(make(missing.fetch)).turn({ agentId: "a", input: "go" });
      assert.equal(result.modelCalls[0].status, "responded");
      assert.equal(result.modelCalls[0].requestId, "request-1");
      assert.deepEqual(result.usage, []);
    }
    const denied = transport([{ error: "credential rejected" }], [401]);
    const report = await failure(runtime(make(denied.fetch), { retry: { attempts: 3, delayMs: () => 0 } }).turn({ agentId: "a", input: "go" }), "provider_failed");
    assert.equal(denied.requests.length, 1);
    assert.equal(report.modelCalls[0].status, "rejected");
    assert.equal(report.modelCalls[0].requestId, "request-1");
  });
}
