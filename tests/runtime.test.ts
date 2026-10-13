import { parseObject } from "./fixtures/tool-input.js";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { callbackGate, deadlineClock } from "./deadline-clock.js";
import {
  EmptyMemorySource,
  RuntimeError,
  SmallHourRuntime,
  StaticPersonaSource,
  ToolRegistry,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "../src/index.js";

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: ProviderRequest[] = [];

  constructor(private readonly script: Array<ProviderResponse | Error>) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }

  isRetryable(): boolean {
    return true;
  }
}

const text = (value: string): ProviderResponse => ({
  content: [{ type: "text", text: value }],
  stopReason: "end_turn",
});

test("normalizes an undefined tool result instead of crashing", async () => {
  const provider = new ScriptedProvider([
    {
      content: [{ type: "tool_use", id: "tool-void", name: "touch", input: {} }],
      stopReason: "tool_use",
    },
    text("done"),
  ]);
  const tools = new ToolRegistry([{
    name: "touch",
    description: "Perform an action with no return value",
    inputSchema: { type: "object" },
    parse: parseObject, execute: () => undefined,
  }]);
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    tools,
  });

  const result = await runtime.turn({ agentId: "a-void", input: "touch", allowedTools: ["touch"] });
  assert.equal(result.status, "reply");
  assert.deepEqual(provider.calls[1]?.messages.at(-1), {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "tool-void", content: "null" }],
  });
});

test("allows reads before a required choice", async () => {
  const provider = new ScriptedProvider([
    {
      content: [{ type: "tool_use", id: "tool-1", name: "look", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "choose-1", name: "choose_moment", input: { choice: "rest" } }],
      stopReason: "tool_use",
    },
    text("settles down"),
  ]);
  const tools = new ToolRegistry([{
    name: "look",
    description: "look",
    inputSchema: { type: "object" },
    mode: "read",
    parse: parseObject, execute: () => ({ weather: "rain" }),
  }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  const result = await runtime.turn({
    agentId: "a-4",
    input: "choose",
    allowedTools: ["look"],
    choice: { name: "choose_moment", description: "choose", inputSchema: { type: "object" }, requiredFirst: true },
  });
  assert.deepEqual(result.choice, { choice: "rest" });
  assert.equal(result.status, "reply");
  assert.deepEqual(provider.calls[1].messages.at(-1), { role: "user", content: [
    { type: "tool_result", toolUseId: "tool-1", content: '{"weather":"rain"}' },
  ] });
});

test("blocks writes before a required choice", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([
    {
      content: [{ type: "tool_use", id: "write-early", name: "write_note", input: { note: "x" } }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "choose-2", name: "small_hour_choose", input: { choice: "rest" } }],
      stopReason: "tool_use",
    },
    text("rests without writing"),
  ]);
  const tools = new ToolRegistry([{
    name: "write_note",
    description: "write",
    inputSchema: { type: "object" },
    mode: "write",
    parse: parseObject, execute: () => ({ count: ++executions }),
  }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  const result = await runtime.turn({ allowedTools: ["write_note"],
    agentId: "a-write-early",
    input: "choose",
    choice: {
      description: "choose",
      inputSchema: { type: "object" },
      requiredFirst: true,
      authorizeWrite: () => true,
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.toolCalls[0]?.ok, false);
  assert.deepEqual(result.choice, { choice: "rest" });
});

test("executes only a write explicitly authorized by the structured choice", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([{
    content: [
      { type: "tool_use", id: "choose-3", name: "small_hour_choose", input: { choice: "write" } },
      { type: "tool_use", id: "write-1", name: "write_note", input: { note: "x" } },
    ],
    stopReason: "tool_use",
  }, text("")]);
  const tools = new ToolRegistry([{
    name: "write_note",
    description: "write",
    inputSchema: { type: "object" },
    mode: "write",
    parse: parseObject, execute: () => ({ count: ++executions }),
  }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  const result = await runtime.turn({ allowedTools: ["write_note"],
    agentId: "a-write-authorized",
    input: "choose",
    choice: {
      description: "choose",
      inputSchema: { type: "object" },
      requiredFirst: true,
      parse: (input: any) => ({ choice: String(input?.choice) }),
      authorizeWrite: (choice, tool) => choice.choice === "write" && tool.name === "write_note",
    },
  });
  assert.equal(executions, 1);
  assert.equal(result.status, "silence");
  assert.equal(result.toolCalls.every((call) => call.ok), true);
});

test("denies a choice-governed write without host authorization", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([{
    content: [
      { type: "tool_use", id: "choose-4", name: "small_hour_choose", input: { choice: "write" } },
      { type: "tool_use", id: "write-denied", name: "write_note", input: { note: "x" } },
    ],
    stopReason: "tool_use",
  }, text("keeps the note unwritten")]);
  const tools = new ToolRegistry([{
    name: "write_note",
    description: "write",
    inputSchema: { type: "object" },
    mode: "write",
    parse: parseObject, execute: () => ({ count: ++executions }),
  }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  const result = await runtime.turn({ allowedTools: ["write_note"],
    agentId: "a-write-denied",
    input: "choose",
    choice: { description: "choose", inputSchema: { type: "object" }, requiredFirst: true },
  });
  assert.equal(executions, 0);
  assert.equal(result.toolCalls[1]?.ok, false);
  assert.equal(result.status, "reply");
});

test("rejects host compaction that still exceeds the configured bound", async () => {
  const provider = new ScriptedProvider([
    { content: [{ type: "tool_use", id: "large-1", name: "large_read", input: {} }], stopReason: "tool_use" },
    text("read it"),
  ]);
  const tools = new ToolRegistry([{
    name: "large_read",
    description: "read a large value",
    inputSchema: { type: "object" },
    mode: "read",
    parse: parseObject, execute: () => ({ payload: "x".repeat(500) }),
  }]);
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    tools,
    maxToolResultCharacters: 120,
    toolResultOverflow: (value) => value,
  });

  await assert.rejects(runtime.turn({ allowedTools: ["large_read"], agentId: "a-large", input: "read" }),
    (error: unknown) => error instanceof RuntimeError && error.code === "tool_result_too_large");
  assert.equal(provider.calls.length, 1);
});

test("rejects an empty completion after a read tool", async () => {
  const provider = new ScriptedProvider([
    { content: [{ type: "tool_use", id: "read-1", name: "read_once", input: {} }], stopReason: "tool_use" },
    text(""),
  ]);
  const tools = new ToolRegistry([{
    name: "read_once",
    description: "read",
    inputSchema: { type: "object" },
    mode: "read",
    parse: parseObject, execute: () => ({ value: 1 }),
  }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  await assert.rejects(
    runtime.turn({ allowedTools: ["read_once"], agentId: "a-empty", input: "read" }),
    (error: unknown) => error instanceof RuntimeError && error.code === "missing_tool_answer",
  );
});

test("the real wall-clock deadline aborts an unfinished turn", async () => {
  const provider: ModelProvider = {
    name: "stuck",
    complete: async () => await new Promise<ProviderResponse>(() => {}),
  };
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    timeoutMs: 10,
    retry: { attempts: 3, delayMs: () => 0 },
  });

  await assert.rejects(
    runtime.turn({ agentId: "a-7", input: "hello" }),
    (error: unknown) => error instanceof RuntimeError && error.code === "turn_aborted",
  );
});

test("deadline stops a provider that ignores abort without retrying it", async (t) => {
  const clock = deadlineClock(t); const callback = callbackGate();
  let calls = 0;
  const provider: ModelProvider = { name: "stuck", complete: async () => {
    calls++; await callback.wait(); return text("late answer");
  } };
  const runtime = new SmallHourRuntime({
    provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(),
    timeoutMs: 10, retry: { attempts: 3, delayMs: () => 0, retryable: () => true },
  });
  const pending = assert.rejects(runtime.turn({ agentId: "a", input: "hello" }), (error: unknown) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "turn_aborted");
    assert.deepEqual(error.report?.modelCalls.map((call) => call.status), ["unknown"]);
    return true;
  });
  await callback.entered;
  clock.tick(10);
  await pending;
  await callback.release();
  assert.equal(calls, 1);
});

test("aborts during retry backoff instead of waiting out the delay", async (t) => {
  const clock = deadlineClock(t);
  let entered = false;
  const provider = new ScriptedProvider([new Error("temporary"), text("retried")]);
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    timeoutMs: 10,
    retry: { attempts: 3, delayMs: () => {
      entered = true;
      queueMicrotask(() => clock.tick(10));
      return 10_000;
    } },
  });

  await assert.rejects(runtime.turn({ agentId: "a-backoff", input: "hello" }), (error: unknown) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "turn_aborted");
    assert.deepEqual(error.report?.modelCalls.map((call) => call.status), ["unknown"]);
    return true;
  });
  assert.equal(entered, true);
  clock.tick(10_000);
  await setImmediate();
  assert.equal(provider.calls.length, 1);
});
