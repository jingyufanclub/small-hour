import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelProvider, type ProviderResponse, type RuntimeOptions,
  type TraceEvent } from "../src/index.js";
import { callbackGate, deadlineClock } from "./deadline-clock.js";

const traceId = "1234567890abcdef1234567890abcdef";
const parentSpanId = "1234567890abcdef";
const text = (output = "done"): ProviderResponse => ({ content: [{ type: "text", text: output }], stopReason: "end_turn" });
const use = (id: string, name = "read", input: unknown = {}): ProviderResponse => ({
  content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use",
});
function runtime(provider: ModelProvider, events: TraceEvent[], options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("private instructions"), memory: new EmptyMemorySource(),
    tracing: { sink: { record: event => { events.push(event); } }, content: { maxBytes: 100_000 } },
    retry: { attempts: 1, delayMs: () => 0 }, ...options });
}
function captured(event: TraceEvent): any {
  assert.equal(event.content?.status, "captured");
  return event.content?.status === "captured" ? event.content.value : undefined;
}

test("one trace joins actual model requests, parsed tool input, results, and final output", async () => {
  const events: TraceEvent[] = [], sent: unknown[] = [], callbackTraces: unknown[] = [];
  let calls = 0;
  const model: ModelProvider = { name: "fixture", model: "selected-model", async complete(request) {
    sent.push(structuredClone(request.messages));
    return ++calls === 1 ? use("call-7", "read", { id: "item-7", extra: "ignored" }) : text("found item-7");
  } };
  const result = await runtime(model, events, {
    memory: { load: async context => { callbackTraces.push(context.trace); return [{ role: "user", content: "selected memory" }]; } },
    tools: new ToolRegistry([{ name: "read", description: "Read an item", inputSchema: {}, mode: "read",
      parse: (input: any) => ({ id: input.id }), execute: (input, context) => {
        callbackTraces.push(context.trace); context.recordReceipt("receipt-7"); return { id: input.id, found: true };
      } }]),
  }).turn({ agentId: "agent", input: "find it", trace: { traceId, parentSpanId } });
  assert.ok(events.length > 0, "the actual runtime must emit records");
  assert.ok(events.every(event => event.traceId === traceId));
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  const turn = events.find(event => event.type === "turn.started")!;
  assert.equal(turn.parentSpanId, parentSpanId);
  const attempts = events.filter(event => event.type === "model.started");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(event => event.parentSpanId === turn.spanId));
  assert.notEqual(attempts[0].spanId, attempts[1].spanId);
  const tool = events.find(event => event.type === "tool.requested")!;
  assert.equal(tool.parentSpanId, attempts[0].spanId);
  const executed = events.find(event => event.type === "tool.started")!;
  assert.deepEqual(captured(executed), { id: "item-7" });
  assert.equal(executed.spanId, tool.spanId);
  const requests = events.filter(event => event.type === "model.request" && event.format === "runtime");
  assert.deepEqual(requests.map(event => captured(event).messages), sent);
  assert.equal(captured(requests[0]).messages.length, 2);
  const finish = events.find(event => event.type === "tool.finished");
  assert.ok(finish?.type === "tool.finished");
  assert.deepEqual(finish.record.receiptIds, ["receipt-7"]);
  assert.equal(finish.record.status, "completed");
  assert.deepEqual(callbackTraces, [result.trace && { traceId, spanId: turn.spanId, parentSpanId },
    { traceId, spanId: tool.spanId, parentSpanId: attempts[0].spanId }]);
  assert.equal(result.trace?.spanId, turn.spanId);
  assert.equal(events.at(-1)?.type, "turn.finished");
  assert.equal(captured(events.at(-1)!).output, "found item-7");
});

test("metadata capture omits content and untraced execution keeps its existing report shape", async () => {
  const events: TraceEvent[] = [];
  const provider: ModelProvider = { name: "fixture", capabilities: { images: true }, async complete() { return text("private output"); } };
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const result = await runtime(provider, events, { tracing: { sink: { record: event => { events.push(event); } } } })
    .turn({ agentId: "agent", input: [{ type: "text", text: "private input" }, { type: "image", mediaType: "image/png", data: image }] });
  assert.ok(result.trace);
  assert.ok(events.some(event => event.content?.status === "omitted"));
  assert.doesNotMatch(JSON.stringify(events), /private input|private output|private instructions/);
  assert.equal(JSON.stringify(events).includes(image), false);
  const plain = await runtime(provider, [], { tracing: undefined }).turn({ agentId: "agent", input: "private input" });
  assert.equal("trace" in plain, false);
  assert.equal("trace" in plain.modelCalls[0], false);
});

test("failed tracing cannot mutate requests, authorize denied writes, or replay effects", async () => {
  const events: TraceEvent[] = [];
  let calls = 0, effects = 0;
  const result = await runtime({ name: "fixture", async complete(request) {
    assert.equal(request.messages[0].content, "original");
    if (++calls === 1) return { content: [
      { type: "tool_use", id: "choose", name: "small_hour_choose", input: { action: "wait" } },
      { type: "tool_use", id: "denied", name: "write", input: {} },
    ], stopReason: "tool_use" };
    return text("no write");
  } }, events, {
    tracing: { content: { maxBytes: 100_000 }, sink: { record: event => {
      events.push(structuredClone(event));
      if (event.type === "model.request" && event.content?.status === "captured") (event.content.value as any).messages[0].content = "mutated";
      throw new Error("private export failure");
    } } },
    tools: new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, execute() { effects++; } }]),
  }).turn({ agentId: "agent", input: "original", choice: { description: "Choose", inputSchema: {}, authorizeWrite: () => false } });
  assert.equal(effects, 0); assert.equal(calls, 2);
  const denied = events.find(event => event.type === "tool.finished" && event.record.id === "denied");
  assert.ok(denied?.type === "tool.finished");
  assert.equal(denied.record.status, "not_started");
  assert.equal(denied.record.errorCode, "choice_write_not_authorized");
  assert.equal(events.some(event => event.type === "tool.started" && event.toolCallId === "denied"), false);
  assert.ok(result.trace && result.trace.exportFailures > 0);
  assert.doesNotMatch(JSON.stringify(result.trace), /private export failure/);
});

test("each retried provider attempt has a distinct span and its original call outcome", async () => {
  const events: TraceEvent[] = []; let calls = 0;
  const result = await runtime({ name: "fixture", async complete() {
    if (++calls === 1) throw new Error("temporary private detail");
    return text();
  }, isRetryable: () => true }, events, { retry: { attempts: 2, delayMs: () => 0 } })
    .turn({ agentId: "agent", input: "retry", trace: { traceId } });
  const finished = events.filter(event => event.type === "model.finished");
  assert.equal(finished.length, 2);
  assert.deepEqual(finished.map(event => event.type === "model.finished" && event.record.status), ["unknown", "responded"]);
  assert.notEqual(finished[0].spanId, finished[1].spanId);
  assert.deepEqual(finished.map(event => event.type === "model.finished" && event.record.callId), result.modelCalls.map(call => call.callId));
  assert.doesNotMatch(JSON.stringify(events), /temporary private detail/);
});

test("denied model admission records an unstarted attempt without a provider request", async () => {
  const events: TraceEvent[] = [];
  await assert.rejects(runtime({ name: "fixture", async complete() { assert.fail("must not call provider"); } }, events,
    { modelCalls: { admit: () => false } }).turn({ agentId: "agent", input: "denied" }), { code: "model_call_denied" });
  const end = events.find(event => event.type === "model.finished");
  assert.ok(end?.type === "model.finished"); assert.equal(end.record.status, "not_started");
  assert.equal(events.some(event => event.type === "model.request"), false);
});

test("original and compacted tool results remain distinguishable and over-limit capture is explicit", async () => {
  const events: TraceEvent[] = []; let calls = 0;
  const result = await runtime({ name: "fixture", async complete() { return ++calls === 1 ? use("read-1") : text(); } }, events, {
    tracing: { sink: { record: event => { events.push(event); } }, content: { maxBytes: 200 } },
    tools: new ToolRegistry([{ name: "read", description: "Read", inputSchema: {}, mode: "read", execute: () => ({ large: "x".repeat(500) }) }]),
    maxToolResultCharacters: 100, toolResultOverflow: () => ({ summary: "selected facts" }),
  }).turn({ agentId: "agent", input: "read" });
  const original = events.find(event => event.type === "tool.result" && event.stage === "original")!;
  assert.equal(original.content?.status, "omitted");
  assert.ok(original.content?.status === "omitted" && original.content.reason === "size_limit");
  const visible = events.find(event => event.type === "tool.result" && event.stage === "model")!;
  assert.equal(captured(visible), '{"summary":"selected facts"}');
  assert.ok(result.trace && result.trace.contentOmissions > 0);
  assert.equal(result.output, "done");
});

test("asynchronous sink rejection is observed without delaying or failing a turn", async () => {
  let calls = 0;
  const result = await runtime({ name: "fixture", async complete() { calls++; return text(); } }, [], {
    tracing: { sink: { record: () => Promise.reject(new Error("export failed")) } },
  }).turn({ agentId: "agent", input: "finish" });
  await setImmediate();
  assert.equal(calls, 1); assert.equal(result.output, "done");
  assert.ok(result.trace && result.trace.exportFailures > 0);
});

test("cancellation closes uncertain model work and ignores late provider observations", async t => {
  const events: TraceEvent[] = [], gate = callbackGate(), clock = deadlineClock(t);
  const model: ModelProvider = { name: "fixture", async complete(request) {
    await gate.wait(); request.trace?.response({ late: "private answer" }); return text("late answer");
  } };
  const pending = assert.rejects(runtime(model, events, { timeoutMs: 10 }).turn({ agentId: "agent", input: "wait" }), { code: "turn_aborted" });
  await gate.entered; clock.tick(10); await pending;
  const ended = events.find(event => event.type === "model.finished");
  assert.ok(ended?.type === "model.finished"); assert.equal(ended.record.status, "unknown");
  assert.equal(events.at(-1)?.type, "turn.finished");
  const before = structuredClone(events); await gate.release();
  assert.deepEqual(events, before);
});

test("concurrent turns never mix trace identities or selected context", async () => {
  const events: TraceEvent[] = [], gate = callbackGate();
  const app = runtime({ name: "fixture", async complete(request) {
    if (request.messages[0].content === "first private input") await gate.wait();
    return text(String(request.messages[0].content));
  } }, events);
  const first = app.turn({ agentId: "first", input: "first private input" });
  await gate.entered;
  const second = await app.turn({ agentId: "second", input: "second private input" });
  await gate.release(); const result = await first;
  assert.ok(result.trace && second.trace); assert.notEqual(result.trace.traceId, second.trace.traceId);
  for (const [id, owner, excluded] of [[result.trace.traceId, "first", "second private input"], [second.trace.traceId, "second", "first private input"]]) {
    const selected = events.filter(event => event.traceId === id);
    assert.ok(selected.length > 0 && selected.every(event => event.agentId === owner));
    assert.doesNotMatch(JSON.stringify(selected), new RegExp(excluded));
  }
});

test("invalid trace identity fails before context loading or effects", async () => {
  let loads = 0;
  const app = runtime({ name: "fixture", async complete() { assert.fail("no provider call"); } }, [], {
    memory: { load: async () => { loads++; return []; } },
  });
  for (const invalid of [{ traceId: "" }, { traceId: "0".repeat(32) }, { traceId, parentSpanId: "bad" }]) {
    await assert.rejects(app.turn({ agentId: "agent", input: "hello", trace: invalid }));
  }
  assert.equal(loads, 0);
});

test("a rejected final output and failed export preserve a completed effect without replay", async () => {
  let calls = 0, writes = 0;
  const events: TraceEvent[] = [];
  const result = await runtime({ name: "fixture", async complete() { return ++calls === 1 ? use("write-1", "write") : text("rejected output"); } }, [], {
    tracing: { sink: { record: event => { events.push(event); throw new Error("offline"); } } },
    tools: new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, execute: (_input, context) => {
      writes++; context.recordReceipt("committed-1"); return { saved: true };
    } }]), outputPolicy: { apply: output => ({ accepted: false, output, issues: ["policy"] }) },
  }).turn({ agentId: "agent", input: "write" });
  assert.equal(writes, 1); assert.equal(calls, 2); assert.equal(result.status, "rejected");
  assert.deepEqual(result.toolCalls[0].receiptIds, ["committed-1"]);
  const check = events.find(event => event.type === "check.finished");
  assert.ok(check?.type === "check.finished"); assert.equal(check.verdict, "rejected");
  const end = events.at(-1); assert.ok(end?.type === "turn.finished"); assert.equal(end.status, "rejected");
});

test("capture failure leaves a valid application-transformed structured value intact", async () => {
  const events: TraceEvent[] = [];
  const result = await runtime({ name: "fixture", capabilities: { structuredOutput: true }, async complete() { return text('{"id":7}'); } }, events)
    .turn({ agentId: "agent", input: "extract", structuredOutput: { schema: { type: "object" }, parse: () => ({ id: 7n }) } });
  assert.deepEqual(result.value, { id: 7n });
  assert.ok(result.trace && result.trace.captureFailures > 0);
  assert.equal(events.at(-1)?.content?.status, "unavailable");
});

test("a tool withheld by the hop budget receives no execution event", async () => {
  const events: TraceEvent[] = [];
  await assert.rejects(runtime({ name: "fixture", async complete() { return use("withheld"); } }, events, {
    maxHops: 1, tools: new ToolRegistry([{ name: "read", description: "Read", inputSchema: {}, mode: "read",
      execute: () => assert.fail("budget must stop dispatch") }]),
  }).turn({ agentId: "agent", input: "read" }), { code: "tool_hop_limit" });
  const finish = events.find(event => event.type === "tool.finished");
  assert.ok(finish?.type === "tool.finished"); assert.equal(finish.record.status, "not_started");
  assert.equal(events.some(event => event.type === "tool.started"), false);
  assert.equal(events.at(-1)?.type, "turn.finished");
});

test("a pending asynchronous sink does not extend the turn or start an export worker", async () => {
  const result = await runtime({ name: "fixture", async complete() { return text(); } }, [], {
    tracing: { sink: { record: () => new Promise<void>(() => {}) } },
  }).turn({ agentId: "agent", input: "finish" });
  assert.equal(result.output, "done");
  assert.ok(result.trace && result.trace.exportFailures === result.trace.eventCount);
});

test("an unserializable tool result leaves explicit missing content and preserves the original failure", async () => {
  const events: TraceEvent[] = [];
  const cycle: { nested?: unknown } = {}; cycle.nested = cycle;
  await assert.rejects(runtime({ name: "fixture", async complete() { return use("read-1"); } }, events, {
    tools: new ToolRegistry([{ name: "read", description: "Read", inputSchema: {}, mode: "read", execute: () => cycle }]),
  }).turn({ agentId: "agent", input: "read" }), { code: "tool_result_serialization_failed" });
  const original = events.find(event => event.type === "tool.result" && event.stage === "original");
  assert.equal(original?.content?.status, "unavailable");
  const finish = events.find(event => event.type === "tool.finished");
  assert.ok(finish?.type === "tool.finished"); assert.equal(finish.record.status, "completed");
});

test("capturing parsed tool input never invokes application serialization callbacks", async () => {
  const events: TraceEvent[] = []; let calls = 0, serializations = 0;
  const app = runtime({ name: "fixture", async complete() { return ++calls === 1 ? use("read-1") : text(); } }, events, {
    tools: new ToolRegistry([{ name: "read", description: "Read", inputSchema: {}, mode: "read",
      parse: () => ({ id: "item-7", toJSON() { serializations++; return { id: "changed" }; } }),
      execute: input => { assert.equal(input.id, "item-7"); return { found: true }; },
    }]),
  });
  await app.turn({ agentId: "agent", input: "read" });
  assert.equal(serializations, 0);
  assert.equal(events.find(event => event.type === "tool.started")?.content?.status, "unavailable");
});

test("capturing a parsed proxy does not enumerate application-owned data", async () => {
  const events: TraceEvent[] = []; let calls = 0, enumerations = 0;
  const parsed = new Proxy({ id: "item-7" }, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
  await runtime({ name: "fixture", async complete() { return ++calls === 1 ? use("read-1") : text(); } }, events, {
    tools: new ToolRegistry([{ name: "read", description: "Read", inputSchema: {}, mode: "read", parse: () => parsed,
      execute: input => ({ id: input.id }) }]),
  }).turn({ agentId: "agent", input: "read" });
  assert.equal(enumerations, 0);
  assert.equal(events.find(event => event.type === "tool.started")?.content?.status, "unavailable");
});

test("enabling tracing does not reread the application's input or model getters", async () => {
  let reads = 0, modelReads = 0;
  const sent: unknown[] = [];
  const provider: ModelProvider = { name: "fixture", get model() { modelReads++; return "selected-model"; },
    async complete(request) { sent.push(request.messages.at(-1)?.content); return text(); } };
  const input = { agentId: "agent", get input() { return `value-${++reads}`; } };
  await runtime(provider, [], { tracing: undefined }).turn(input);
  const baseline = { reads, modelReads };
  reads = 0; modelReads = 0;
  await runtime(provider, []).turn(input);
  assert.deepEqual({ reads, modelReads }, baseline);
  assert.equal(sent[0], sent[1]);
});
