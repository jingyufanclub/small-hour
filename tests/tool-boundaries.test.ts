import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  EmptyMemorySource, ModelSafeToolError, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelProvider, type ProviderRequest, type ProviderResponse, type ToolDefinition, type TraceEvent,
} from "../src/index.js";

const secret = "private-database-token-for-test";
const text: ProviderResponse = { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
function tool(name: string, input: unknown = {}, id = "call-1"): ProviderResponse {
  return { content: [{ type: "tool_use", name, input, id }], stopReason: "tool_use" };
}
function model(...responses: ProviderResponse[]) {
  const requests: unknown[] = [];
  const provider: ModelProvider = { name: "controlled", capabilities: { tools: true, structuredOutput: true },
    async complete({ signal, trace, ...request }: ProviderRequest) {
      requests.push(structuredClone(request));
      assert.ok(responses.length, "unexpected provider call");
      return responses.shift()!;
    } };
  return { provider, requests };
}
function parseEmpty(input: unknown) { assert.deepEqual(input, {}); return {}; }
function runtime(provider: ModelProvider, tools = new ToolRegistry(), events: TraceEvent[] = []) {
  return new SmallHourRuntime({ provider, tools, persona: new StaticPersonaSource("Use supplied tools."),
    memory: new EmptyMemorySource(), tracing: { sink: { record: event => { events.push(event); } }, content: { maxBytes: 10_000 } } });
}

test("omitted tool selection fails before context loading, admission or execution", async () => {
  const invoked: string[] = [];
  const tools = new ToolRegistry([{ name: "read", description: "Read", inputSchema: { type: "object" },
    parse: parseEmpty, execute: () => { invoked.push("tool"); } }]);
  const bounded = new SmallHourRuntime({ tools,
    provider: { name: "controlled", async complete() { invoked.push("provider"); return text; } },
    persona: { async load() { invoked.push("instructions"); return "instructions"; } },
    memory: { async load() { invoked.push("context"); return []; } },
    modelCalls: { admit() { invoked.push("admission"); return true; } },
  });
  await assert.rejects(bounded.turn({ agentId: "app", input: "read" }), { code: "tool_allowlist_required" });
  assert.deepEqual(invoked, []);
});

test("malformed tool selections never widen access", async () => {
  for (const allowedTools of [null, "read", {}, [null], [1]]) {
    const selected = model(text);
    const tools = new ToolRegistry([{ name: "read", description: "Read", inputSchema: {}, parse: parseEmpty,
      execute: () => assert.fail("unexpected execution") }]);
    await assert.rejects(runtime(selected.provider, tools).turn({ agentId: "app", input: "read", allowedTools: allowedTools as string[] }));
    assert.equal(selected.requests.length, 0);
  }
});

test("an explicit selection excludes tools registered later and accepts the selected tool", async () => {
  let reads = 0, writes = 0;
  const tools = new ToolRegistry([{ name: "read", description: "Read", mode: "read", inputSchema: {},
    parse: parseEmpty, execute: () => { reads++; return { id: "record-1" }; } }]);
  const selected = model(tool("delete"), tool("read", {}, "call-2"), text);
  const bounded = runtime(selected.provider, tools);
  tools.register({ name: "delete", description: "Delete", inputSchema: {}, parse: parseEmpty, execute: () => ++writes });
  const result = await bounded.turn({ agentId: "app", input: "read", allowedTools: ["read"] });
  assert.equal(reads, 1); assert.equal(writes, 0);
  assert.equal(result.toolCalls[0].errorCode, "tool_not_allowed");
  assert.equal(result.toolCalls[0].status, "not_started");
  assert.equal(result.toolCalls[1].status, "completed");
  for (const request of selected.requests as ProviderRequest[]) assert.deepEqual(request.tools.map(item => item.name), ["read"]);
});

test("tool-free and structured turns need no registry selection", async () => {
  const selected = model(text, { ...text, content: [{ type: "text", text: '{"id":"record-1"}' }] });
  await runtime(selected.provider).turn({ agentId: "app", input: "explain" });
  const tools = new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, parse: parseEmpty,
    execute: () => assert.fail("unexpected write") }]);
  const result = await runtime(selected.provider, tools).turn({ agentId: "app", input: "select", structuredOutput: {
    schema: { type: "object" }, parse: value => { assert.deepEqual(value, { id: "record-1" }); return value; },
  } });
  assert.equal(result.status, "structured");
  for (const request of selected.requests as ProviderRequest[]) assert.deepEqual(request.tools, []);
});

test("JavaScript callers cannot register a tool without a local validator", () => {
  const tools = new ToolRegistry();
  assert.throws(() => tools.register({ name: "write", description: "Write", inputSchema: { type: "object" },
    execute: () => assert.fail("unexpected write") } as unknown as ToolDefinition), /parser|parse|validator/);
  assert.equal(tools.has("write"), false);
});

test("invalid arguments never start a write and valid parsed arguments reach storage", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    const tools = new ToolRegistry([{ name: "save", description: "Save", inputSchema: { type: "object" },
      parse(input: unknown) {
        if (!input || typeof input !== "object" || Array.isArray(input)
          || typeof (input as { body?: unknown }).body !== "string") throw new Error(secret);
        return { body: (input as { body: string }).body.trim() };
      },
      execute(input) { db.prepare("INSERT INTO notes VALUES (?, ?)").run("note-1", input.body); return { id: "note-1" }; },
    }]);
    const selected = model(tool("save", { body: null }), tool("save", { body: " accepted " }, "call-2"), text);
    const events: TraceEvent[] = [];
    const result = await runtime(selected.provider, tools, events).turn({ agentId: "app", input: "save", allowedTools: ["save"] });
    assert.deepEqual({ ...db.prepare("SELECT * FROM notes").get() }, { id: "note-1", body: "accepted" });
    assert.equal(result.toolCalls[0].status, "not_started");
    assert.equal(result.toolCalls[1].status, "completed");
    assert.ok(!JSON.stringify({ requests: selected.requests, events, result }).includes(secret));
  } finally { db.close(); }
});

test("recoverable exceptions cannot disclose messages, causes or stacks to the model", async () => {
  for (const thrown of [new Error(secret, { cause: new Error(secret) }), secret,
    new RuntimeError(secret, secret), Object.assign(new Error(secret), { name: "ModelSafeToolError" })]) {
    const selected = model(tool("read"), text);
    const events: TraceEvent[] = [];
    const tools = new ToolRegistry([{ name: "read", description: "Read", mode: "read", inputSchema: {}, parse: parseEmpty,
      execute() { throw thrown; } }]);
    const result = await runtime(selected.provider, tools, events).turn({ agentId: "app", input: "read", allowedTools: ["read"] });
    assert.equal(result.toolCalls[0].errorCode, "tool_failed");
    assert.deepEqual((selected.requests[1] as ProviderRequest).messages.at(-1)?.content, [{
      type: "tool_result", toolUseId: "call-1", isError: true,
      content: '{"error":"Tool failed.","code":"tool_failed"}',
    }]);
    assert.ok(!JSON.stringify({ requests: selected.requests, events, result }).includes(secret));
  }
});

test("asynchronous argument parsers cannot start an effect", async () => {
  for (const parse of [async () => ({}), async () => { throw new Error(secret); }]) {
    const selected = model(tool("write"), text);
    let writes = 0;
    const tools = new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, parse, execute: () => ++writes }]);
    const result = await runtime(selected.provider, tools).turn({ agentId: "app", input: "write", allowedTools: ["write"] });
    assert.equal(writes, 0);
    assert.equal(result.toolCalls[0].status, "not_started");
    assert.ok(!JSON.stringify(selected.requests).includes(secret));
  }
});

test("explicit safe feedback reaches the model without its private cause", async () => {
  for (const phase of ["parse", "read"] as const) {
    const selected = model(tool("read"), text);
    const events: TraceEvent[] = [];
    const publicMessage = "Select an available record ID.";
    const failed = () => { throw new ModelSafeToolError(publicMessage, { cause: new Error(secret) }); };
    const tools = new ToolRegistry([{ name: "read", description: "Read", mode: "read", inputSchema: {},
      parse: phase === "parse" ? failed : parseEmpty, execute: failed }]);
    const result = await runtime(selected.provider, tools, events).turn({ agentId: "app", input: "read", allowedTools: ["read"] });
    assert.ok(JSON.stringify(selected.requests).includes(publicMessage));
    assert.ok(!JSON.stringify({ requests: selected.requests, events, result }).includes(secret));
    assert.equal(result.toolCalls[0].status, phase === "parse" ? "not_started" : "unknown");
  }
});

test("rejected choice parsing uses the same private error boundary", async () => {
  const selected = model(tool("small_hour_choose"), text);
  const result = await runtime(selected.provider).turn({ agentId: "app", input: "choose", choice: {
    description: "Choose", inputSchema: {}, required: false, parse() { throw new Error(secret); },
  } });
  assert.equal(result.toolCalls[0].status, "not_started");
  assert.ok(!JSON.stringify(selected.requests).includes(secret));
});

for (const feedback of ["private", "model-safe"]) test(`a committed write with lost ${feedback} acknowledgement cannot authorize replay`, async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const events: TraceEvent[] = [];
  const selected = model(tool("write"), text);
  const tools = new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, parse: parseEmpty,
    execute(_, context) {
      const saved = db.prepare("INSERT INTO notes (body) VALUES (?)").run("saved once");
      context.recordReceipt(`note-${saved.lastInsertRowid}`);
      throw feedback === "model-safe" ? new ModelSafeToolError("Please try again.", { cause: new Error(secret) }) : new Error(secret);
    } }]);
  await assert.rejects(runtime(selected.provider, tools, events).turn({ agentId: "app", input: "write", allowedTools: ["write"] }), error => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "tool_outcome_unknown");
    assert.equal(error.report?.toolCalls[0].status, "unknown");
    assert.deepEqual(error.report.toolCalls[0].receiptIds, ["note-1"]);
    assert.ok(!JSON.stringify(error.report).includes(secret));
    return true;
  });
  assert.deepEqual(db.prepare("SELECT id, body FROM notes").all().map(row => ({ ...row })), [{ id: 1, body: "saved once" }]);
  assert.equal(selected.requests.length, 1);
  assert.ok(!JSON.stringify({ requests: selected.requests, events }).includes(secret));
});
