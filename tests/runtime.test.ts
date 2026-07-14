import assert from "node:assert/strict";
import test from "node:test";
import {
  EmptyMemorySource,
  MaxLengthOutput,
  RuntimeError,
  SmallHourRuntime,
  StaticPersonaSource,
  ToolRegistry,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type UsageSink,
} from "../src/index.js";

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  calls: ProviderRequest[] = [];

  constructor(private readonly script: Array<ProviderResponse | Error>) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
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

test("assembles persona, bounded memory, input, and usage", async () => {
  const provider = new ScriptedProvider([{
    ...text("night is clear"),
    usage: { model: "fake", freshInputTokens: 12, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 4 },
  }]);
  const recorded: string[] = [];
  const usage: UsageSink = {
    record: (row, context) => {
      recorded.push(`${context.agentId}:${row.outputTokens}`);
    },
  };
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("quiet caretaker"),
    memory: { load: async () => [{ role: "user", content: "earlier" }] },
    usage,
  });

  const result = await runtime.turn({ agentId: "a-1", turnId: "t-1", input: "look up" });
  assert.equal(result.output, "night is clear");
  assert.equal(result.accepted, true);
  assert.equal(provider.calls[0]?.system[0]?.text, "quiet caretaker");
  assert.deepEqual(provider.calls[0]?.messages, [
    { role: "user", content: "earlier" },
    { role: "user", content: "look up" },
  ]);
  assert.deepEqual(recorded, ["a-1:4"]);
});

test("dispatches an allowlisted tool and returns its result to the provider", async () => {
  const provider = new ScriptedProvider([
    {
      content: [{ type: "tool_use", id: "tool-1", name: "read_weather", input: { place: "roof" } }],
      stopReason: "tool_use",
    },
    text("the roof is damp"),
  ]);
  const tools = new ToolRegistry([{
    name: "read_weather",
    description: "Read local weather",
    inputSchema: { type: "object" },
    execute: (input: any, context) => ({ place: input.place, agent: context.agentId, rain: true }),
  }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  const result = await runtime.turn({ agentId: "a-2", input: "weather?", allowedTools: ["read_weather"] });
  assert.equal(result.output, "the roof is damp");
  assert.equal(result.toolCalls[0]?.ok, true);
  assert.deepEqual(provider.calls[1]?.messages.at(-1), {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "tool-1", content: JSON.stringify({ place: "roof", agent: "a-2", rain: true }) }],
  });
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
    execute: () => undefined,
  }]);
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    tools,
  });

  const result = await runtime.turn({ agentId: "a-void", input: "touch", allowedTools: ["touch"] });
  assert.equal(result.output, "done");
  assert.deepEqual(provider.calls[1]?.messages.at(-1), {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "tool-void", content: "null" }],
  });
});

test("captures a required first structured choice", async () => {
  const provider = new ScriptedProvider([
    {
      content: [{ type: "tool_use", id: "choose-1", name: "choose_moment", input: { choice: "rest", why: "rain" } }],
      stopReason: "tool_use",
    },
    text("settles by the window"),
  ]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource() });
  const result = await runtime.turn({
    agentId: "a-3",
    input: "choose",
    choice: {
      name: "choose_moment",
      description: "Choose one action",
      inputSchema: { type: "object", required: ["choice"] },
      requiredFirst: true,
    },
  });
  assert.deepEqual(result.choice, { choice: "rest", why: "rain" });
  assert.equal(result.output, "settles by the window");
});

test("fails closed when a required choice is not first", async () => {
  const provider = new ScriptedProvider([{
    content: [{ type: "tool_use", id: "tool-1", name: "look", input: {} }],
    stopReason: "tool_use",
  }]);
  const tools = new ToolRegistry([{ name: "look", description: "look", inputSchema: { type: "object" }, execute: () => ({}) }]);
  const runtime = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("p"), memory: new EmptyMemorySource(), tools });

  await assert.rejects(
    runtime.turn({
      agentId: "a-4",
      input: "choose",
      allowedTools: ["look"],
      choice: { description: "choose", inputSchema: { type: "object" }, requiredFirst: true },
    }),
    (error: unknown) => error instanceof RuntimeError && error.code === "choice_required_first",
  );
});

test("retries transient provider failures without changing the turn", async () => {
  const provider = new ScriptedProvider([new Error("temporary"), text("recovered")]);
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    retry: { attempts: 2, delayMs: () => 0 },
  });
  const result = await runtime.turn({ agentId: "a-5", input: "hello" });
  assert.equal(result.output, "recovered");
  assert.equal(provider.calls.length, 2);
});

test("output rejection does not replay tools or silently clip text", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([
    { content: [{ type: "tool_use", id: "write-1", name: "write_note", input: { note: "x" } }], stopReason: "tool_use" },
    text("this line is too long"),
  ]);
  const tools = new ToolRegistry([{
    name: "write_note",
    description: "Write one note",
    inputSchema: { type: "object" },
    mode: "write",
    execute: () => ({ count: ++executions }),
  }]);
  const runtime = new SmallHourRuntime({
    provider,
    persona: new StaticPersonaSource("p"),
    memory: new EmptyMemorySource(),
    tools,
    outputPolicy: new MaxLengthOutput(8),
  });
  const result = await runtime.turn({ agentId: "a-6", input: "write", allowedTools: ["write_note"] });
  assert.equal(result.accepted, false);
  assert.equal(result.output, "this line is too long");
  assert.equal(executions, 1);
});

test("enforces the wall-clock timeout even when an adapter ignores abort", async () => {
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
