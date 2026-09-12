import assert from "node:assert/strict";
import test from "node:test";
import {
  EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelProvider, type ProviderRequest, type ProviderResponse, type RuntimeOptions,
  type TurnReport,
} from "../src/index.js";

const text = (value = "done"): ProviderResponse => ({
  content: [{ type: "text", text: value }], stopReason: "end_turn",
});
const use = (...names: string[]): ProviderResponse => ({
  content: names.map((name, i) => ({ type: "tool_use", name, id: `${name}-${i}`, input: {} })),
  stopReason: "tool_use",
});
const usage = { model: "test", freshInputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 3 };
function scripted(script: Array<ProviderResponse | Error>, structuredOutput = false) {
  const calls: ProviderRequest[] = [];
  const provider: ModelProvider = {
    name: "test", capabilities: { structuredOutput },
    async complete(request) {
      calls.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
    isRetryable: () => true,
  };
  return { provider, calls };
}
function runtime(provider: ModelProvider, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({
    provider, persona: new StaticPersonaSource("Use supplied facts."), memory: new EmptyMemorySource(),
    retry: { attempts: 1, delayMs: () => 0 }, ...options,
  });
}
async function failure(promise: Promise<unknown>, code: string): Promise<TurnReport> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, code);
    assert.ok(error.report);
    return error.report;
  }
  assert.fail(`expected ${code}`);
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("dispatch rejects a registered tool withheld from this turn", async () => {
  let writes = 0;
  const { provider, calls } = scripted([use("write"), text()]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: () => ++writes }]);
  const result = await runtime(provider, { tools }).turn({ agentId: "a", input: "go", allowedTools: [] });
  assert.equal(calls[0].tools.length, 0);
  assert.equal(writes, 0);
  assert.equal(result.toolCalls[0].status, "not_started");
  assert.equal(result.toolCalls[0].errorCode, "tool_not_allowed");
});

test("an already cancelled turn starts no host or provider work", async () => {
  let loads = 0;
  const controller = new AbortController(); controller.abort();
  const { provider, calls } = scripted([text()]);
  await failure(runtime(provider, { persona: { load: async () => { loads++; return "p"; } } })
    .turn({ agentId: "a", input: "go", signal: controller.signal }), "turn_aborted");
  assert.equal(loads, 0);
  assert.equal(calls.length, 0);
});

test("deadline covers output and usage callbacks without returning success", async (t) => {
  for (const hook of ["output", "usage"] as const) await t.test(hook, async () => {
    const { provider } = scripted([{ ...text(), usage }]);
    const options: Partial<RuntimeOptions> = hook === "output"
      ? { outputPolicy: { apply: async (output) => { await delay(40); return { output, accepted: true }; } } }
      : { usage: { record: async () => { await delay(40); } } };
    const report = await failure(runtime(provider, { ...options, timeoutMs: 5 })
      .turn({ agentId: "a", input: "go" }), "turn_aborted");
    assert.deepEqual(report.usage, [usage]);
    assert.equal(report.modelCalls[0].status, "responded");
  });
});

test("choice callback timeout preserves the decision and starts no following write", async () => {
  let writes = 0;
  const { provider, calls } = scripted([use("small_hour_choose", "write"), text()]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: () => ++writes }]);
  const report = await failure(runtime(provider, { tools, timeoutMs: 5 }).turn({
    agentId: "a", input: "go", choice: {
      description: "choose", inputSchema: {}, parse: () => ({ selectedId: "item-7" }),
      onChoice: async () => { await delay(40); }, authorizeWrite: () => true,
    },
  }), "turn_aborted");
  assert.deepEqual(report.choice, { selectedId: "item-7" });
  assert.equal(writes, 0);
  assert.equal(calls.length, 1);
  assert.equal(report.toolCalls[0].status, "unknown");
});

test("authorization timeout never starts the authorized operation", async () => {
  let writes = 0;
  const { provider } = scripted([use("small_hour_choose", "write"), text()]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: () => ++writes }]);
  const report = await failure(runtime(provider, { tools, timeoutMs: 5 }).turn({
    agentId: "a", input: "go", choice: { description: "choose", inputSchema: {},
      authorizeWrite: async () => { await delay(40); return true; } },
  }), "turn_aborted");
  await delay(45);
  assert.equal(writes, 0);
  assert.equal(report.toolCalls[1].status, "not_started");
});

test("a later provider failure retains completed effects, receipts, choice, and usage", async () => {
  let writes = 0;
  const { provider, calls } = scripted([{ ...use("small_hour_choose", "write"), usage, requestId: "request-1" }, new Error("offline")]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: (_, context) => {
    writes++; context.recordReceipt("receipt-42"); return { saved: true };
  } }]);
  const report = await failure(runtime(provider, { tools }).turn({
    agentId: "agent-1", turnId: "turn-1", input: "go", choice: {
      description: "choose", inputSchema: {}, parse: () => ({ id: "selected-9" }), authorizeWrite: () => true,
    },
  }), "provider_failed");
  assert.equal(writes, 1);
  assert.equal(calls.length, 2);
  assert.equal(report.agentId, "agent-1"); assert.equal(report.turnId, "turn-1");
  assert.deepEqual(report.choice, { id: "selected-9" });
  assert.equal(report.toolCalls[1].status, "completed");
  assert.deepEqual(report.toolCalls[1].receiptIds, ["receipt-42"]);
  assert.deepEqual(report.usage, [usage]);
  assert.deepEqual(report.modelCalls.map((call) => call.status), ["responded", "unknown"]);
  assert.equal(report.modelCalls[0].requestId, "request-1");
});

test("cancellation during a tool reports uncertainty and prevents subsequent tools", async () => {
  let laterWrites = 0;
  const { provider, calls } = scripted([use("slow", "later"), text()]);
  const tools = new ToolRegistry([
    { name: "slow", description: "slow", inputSchema: {}, execute: async (_, context) => {
      context.recordReceipt("committed-before-wait"); await delay(40); context.recordReceipt("late-receipt"); return {};
    } },
    { name: "later", description: "later", inputSchema: {}, execute: () => ++laterWrites },
  ]);
  const report = await failure(runtime(provider, { tools, timeoutMs: 5 }).turn({ agentId: "a", input: "go" }), "turn_aborted");
  assert.equal(report.toolCalls[0].status, "unknown");
  assert.deepEqual(report.toolCalls[0].receiptIds, ["committed-before-wait"]);
  assert.equal(report.toolCalls[1].status, "not_started");
  await delay(45);
  assert.deepEqual(report.toolCalls[0].receiptIds, ["committed-before-wait"]);
  assert.equal(laterWrites, 0); assert.equal(calls.length, 1);
});

test("a write that throws after committing stops before the model can replay it", async () => {
  let writes = 0;
  const { provider, calls } = scripted([use("write"), text("try again")]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: (_, context) => {
    writes++; context.recordReceipt("committed-1"); throw new Error("acknowledgement failed");
  } }]);
  const report = await failure(runtime(provider, { tools }).turn({ agentId: "a", input: "go" }), "tool_outcome_unknown");
  assert.equal(writes, 1); assert.equal(calls.length, 1);
  assert.equal(report.toolCalls[0].status, "unknown");
  assert.deepEqual(report.toolCalls[0].receiptIds, ["committed-1"]);
});

test("invalid tool input remains recoverable without starting a write", async () => {
  let writes = 0;
  const { provider, calls } = scripted([use("write"), text("please supply a valid ID")]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {},
    parse: () => { throw new Error("missing ID"); }, execute: () => ++writes,
  }]);
  const result = await runtime(provider, { tools }).turn({ agentId: "a", input: "go" });
  assert.equal(writes, 0); assert.equal(result.toolCalls[0].status, "not_started");
  assert.equal(result.status, "reply");
  const errorMessage = calls[1].messages.at(-1);
  assert.ok(errorMessage && typeof errorMessage.content !== "string");
  const block = errorMessage.content[0];
  assert.equal(block.type, "tool_result");
  if (block.type === "tool_result") assert.equal(JSON.parse(block.content).error, "missing ID");
});

test("a completed choice with no final text does not return earlier tool-call prose", async () => {
  const { provider } = scripted([{
    ...use("small_hour_choose"), content: [{ type: "text", text: "I will choose next." }, ...use("small_hour_choose").content],
  }, text("")]);
  const result = await runtime(provider).turn({ agentId: "a", input: "choose", choice: {
    description: "choose", inputSchema: {}, parse: () => ({ id: "selected-7" }),
  } });
  assert.equal(result.status, "silence"); assert.equal(result.output, "");
  assert.deepEqual(result.choice, { id: "selected-7" });
});

test("duplicate provider call IDs are rejected before any effect in that batch", async () => {
  let writes = 0;
  const response = use("write", "write");
  if (response.content[1].type === "tool_use") response.content[1].id = "write-0";
  const { provider } = scripted([response, text()]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: () => ++writes }]);
  await failure(runtime(provider, { tools }).turn({ agentId: "a", input: "go" }), "invalid_tool_call");
  assert.equal(writes, 0);
});

test("a late choice callback cannot alter the accepted selection in the failure report", async () => {
  const { provider } = scripted([use("small_hour_choose"), text()]);
  const report = await failure(runtime(provider, { timeoutMs: 5 }).turn({ agentId: "a", input: "go", choice: {
    description: "choose", inputSchema: {}, parse: () => ({ selectedId: "original" }),
    onChoice: async (choice) => { await delay(30); choice.selectedId = "changed"; },
  } }), "turn_aborted");
  await delay(40);
  assert.deepEqual(report.choice, { selectedId: "original" });
});

test("synchronous callbacks that overrun the deadline cannot return success", async () => {
  const { provider } = scripted([text()]);
  await failure(runtime(provider, { timeoutMs: 5, outputPolicy: { apply: (output) => {
    const end = performance.now() + 15;
    while (performance.now() < end) {}
    return { output, accepted: true };
  } } }).turn({ agentId: "a", input: "go" }), "turn_aborted");
});

test("structured mode validates a complete object with one call and no tools", async () => {
  const { provider, calls } = scripted([text('{"selectedId":"id-9"}')], true);
  const schema = { type: "object", properties: { selectedId: { type: "string" } }, required: ["selectedId"], additionalProperties: false };
  const result = await runtime(provider, { maxHops: 1 }).turn({ agentId: "a", input: "select", structuredOutput: {
    schema, parse: (value) => { assert.deepEqual(value, { selectedId: "id-9" }); return value as { selectedId: string }; },
  } });
  assert.equal(result.status, "structured"); assert.equal(result.value.selectedId, "id-9");
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].tools, []);
  assert.deepEqual(calls[0].outputSchema, schema);
});

test("structured mode rejects unsupported, malformed, incomplete, and semantically invalid results", async (t) => {
  const cases = [
    { name: "unsupported", supported: false, response: text("{}"), code: "structured_output_unsupported", calls: 0 },
    { name: "malformed", supported: true, response: text("{"), code: "structured_output_invalid", calls: 1 },
    { name: "incomplete", supported: true, response: { ...text("{}"), stopReason: "max_tokens" as const }, code: "incomplete_stop", calls: 1 },
    { name: "invalid selection", supported: true, response: text('{"id":"invented"}'), code: "structured_output_invalid", calls: 1 },
    { name: "unexpected tool", supported: true, response: use("write"), code: "unexpected_tool_use", calls: 1 },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const { provider, calls } = scripted([{ ...item.response, usage }], item.supported);
    const report = await failure(runtime(provider).turn({ agentId: "a", input: "go", structuredOutput: {
      schema: { type: "object" }, parse: () => { throw new Error("not an allowed selection"); },
    } }), item.code);
    assert.equal(calls.length, item.calls);
    assert.equal(report.usage.length, item.calls);
  });
});

test("model admission and accounting cover each retry and enforce a total call budget", async () => {
  const { provider, calls } = scripted([new Error("offline"), use("write"), text()]);
  const admitted: string[] = []; const recorded: string[] = []; let writes = 0;
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: () => ++writes }]);
  const report = await failure(runtime(provider, {
    tools, maxModelCalls: 2, retry: { attempts: 3, delayMs: () => 0 },
    modelCalls: { admit: (context) => { admitted.push(context.callId); return true; },
      record: (call) => { recorded.push(`${call.callId}:${call.status}`); } },
  }).turn({ agentId: "a", input: "go" }), "model_call_limit");
  assert.equal(calls.length, 2); assert.equal(writes, 0);
  assert.equal(new Set(admitted).size, 2);
  assert.deepEqual(recorded, admitted.map((id, i) => `${id}:${i ? "responded" : "unknown"}`));
  assert.ok(report.modelCalls.every((call) => call.accounting === "recorded"));
});

test("denied admission and failed accounting cannot trigger a provider retry", async (t) => {
  for (const stage of ["admit", "record"] as const) await t.test(stage, async () => {
    const { provider, calls } = scripted([{ ...text(), usage }, text()]);
    const report = await failure(runtime(provider, {
      retry: { attempts: 3, delayMs: () => 0, retryable: () => true },
      modelCalls: stage === "admit" ? { admit: () => false } : { record: () => { throw new Error("ledger unavailable"); } },
    }).turn({ agentId: "a", input: "go" }), stage === "admit" ? "model_call_denied" : "model_call_accounting_failed");
    assert.equal(calls.length, stage === "admit" ? 0 : 1);
    assert.equal(report.modelCalls[0].status, stage === "admit" ? "not_started" : "responded");
    assert.equal(report.modelCalls[0].accounting, "unrecorded");
    if (stage === "record") assert.deepEqual(report.usage, [usage]);
  });
});

test("model admission and accounting obey the turn deadline", async (t) => {
  for (const stage of ["admit", "record"] as const) await t.test(stage, async () => {
    const { provider, calls } = scripted([text()]);
    const report = await failure(runtime(provider, { timeoutMs: 5, modelCalls: stage === "admit"
      ? { admit: async () => { await delay(40); return true; } }
      : { record: async () => { await delay(40); } },
    }).turn({ agentId: "a", input: "go" }), "turn_aborted");
    await delay(45);
    assert.equal(calls.length, stage === "admit" ? 0 : 1);
    assert.equal(report.modelCalls[0].accounting, "unrecorded");
  });
});

test("oversized results stop without hiding a completed write or sending a preview", async () => {
  const { provider, calls } = scripted([use("write"), text()]);
  const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: (_, context) => {
    context.recordReceipt("saved-1"); return { id: "saved-1", details: "x".repeat(500) };
  } }]);
  const report = await failure(runtime(provider, { tools, maxToolResultCharacters: 120 })
    .turn({ agentId: "a", input: "go" }), "tool_result_too_large");
  assert.equal(calls.length, 1); assert.equal(report.toolCalls[0].status, "completed");
  assert.deepEqual(report.toolCalls[0].receiptIds, ["saved-1"]);
});

test("host compaction preserves selected IDs at the next provider boundary", async () => {
  const { provider, calls } = scripted([use("read"), text()]);
  const tools = new ToolRegistry([{ name: "read", description: "read", mode: "read", inputSchema: {},
    execute: () => ({ selectedId: "exact-7", details: "x".repeat(500) }),
  }]);
  await runtime(provider, { tools, maxToolResultCharacters: 120,
    toolResultOverflow: (value) => ({ selectedId: (value as { selectedId: string }).selectedId }),
  }).turn({ agentId: "a", input: "go" });
  assert.deepEqual(calls[1].messages.at(-1), { role: "user", content: [
    { type: "tool_result", toolUseId: "read-0", content: '{"selectedId":"exact-7"}' },
  ] });
});

test("result encoding failures preserve the completed effect and prevent more calls", async (t) => {
  for (const kind of ["circular", "compaction failure", "compaction timeout"] as const) await t.test(kind, async () => {
    const { provider, calls } = scripted([use("write"), text()]);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const tools = new ToolRegistry([{ name: "write", description: "write", inputSchema: {}, execute: (_, context) => {
      context.recordReceipt("saved-7"); return kind === "circular" ? circular : { payload: "x".repeat(500) };
    } }]);
    const report = await failure(runtime(provider, { tools, timeoutMs: 10, maxToolResultCharacters: 120,
      toolResultOverflow: async () => {
        if (kind === "compaction timeout") await delay(40);
        throw new Error("could not compact");
      },
    }).turn({ agentId: "a", input: "go" }), kind === "circular" ? "tool_result_serialization_failed"
      : kind === "compaction timeout" ? "turn_aborted" : "turn_failed");
    assert.equal(calls.length, 1); assert.equal(report.toolCalls[0].status, "completed");
    assert.deepEqual(report.toolCalls[0].receiptIds, ["saved-7"]);
  });
});

test("concurrent turns retain their own identities, receipts, and model attempts", async () => {
  const provider: ModelProvider = { name: "concurrent", async complete(request) {
    const input = request.messages[0].content as string;
    if (request.messages.length > 1) return text(input);
    return use("save");
  } };
  const tools = new ToolRegistry([{ name: "save", description: "save", inputSchema: {}, execute: async (_, context) => {
    await delay(context.agentId === "first" ? 10 : 1);
    context.recordReceipt(`${context.agentId}-receipt`); return { agentId: context.agentId };
  } }]);
  const shared = runtime(provider, { tools });
  const results = await Promise.all(["first", "second"].map((id) => shared.turn({ agentId: id, turnId: `${id}-turn`, input: id })));
  for (const result of results) {
    assert.equal(result.output, result.agentId);
    assert.equal(result.turnId, `${result.agentId}-turn`);
    assert.deepEqual(result.toolCalls[0].receiptIds, [`${result.agentId}-receipt`]);
    assert.deepEqual(result.modelCalls.map((call) => call.attempt), [1, 2]);
  }
  assert.equal(new Set(results.flatMap((result) => result.modelCalls.map((call) => call.callId))).size, 4);
});
