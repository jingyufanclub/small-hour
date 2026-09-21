import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelCallRecord, type ProviderResponse, type RuntimeOptions } from "../src/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { SqliteModelSpendStore, SqliteModelStepStore, SqliteOperationStore } from "../src/durable/sqlite.js";

const request = { scope: "app", id: "reply", kind: "compose", version: "1", input: { itemId: "item-7" } };
const input = { agentId: "app", input: "Process item-7.", allowedTools: ["save"] };
const tokens = { input_tokens: 12, output_tokens: 8 };
const tool = { type: "tool_use", id: "tool-1", name: "save", input: { itemId: "item-7" } };
function message(reason: unknown, content: unknown[] = [{ type: "text", text: "private partial prose" }], usage: unknown = tokens) {
  return { id: "message-1", type: "message", role: "assistant", model: "test-model", content,
    stop_reason: reason, stop_sequence: null, ...(usage === null ? {} : { usage }) };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-outcomes-"));
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(join(directory, "app.sqlite")); connections.add(db);
    const steps = new SqliteModelStepStore(db), spend = new SqliteModelSpendStore(db), operations = new SqliteOperationStore(db);
    steps.initialize(); spend.initialize(); operations.initialize();
    return { db, steps, spend, operations, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open };
}
function transport(bodies: unknown[], options: Partial<RuntimeOptions> = {}) {
  const requests: Record<string, any>[] = [];
  const client = new Anthropic({ apiKey: "test-only", maxRetries: 4, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    assert.ok(bodies.length, "unexpected extra provider call");
    return new Response(JSON.stringify(bodies.shift()), { status: 200,
      headers: { "content-type": "application/json", "request-id": `request-${requests.length}` } });
  } });
  const runtime = new SmallHourRuntime({ provider: new AnthropicProvider({ model: "test-model", client }),
    persona: new StaticPersonaSource("Use supplied IDs."), memory: new EmptyMemorySource(),
    tools: new ToolRegistry([{ name: "save", description: "Save an item", inputSchema: {}, execute: () => assert.fail("unexpected tool effect") }]),
    retry: { attempts: 3, delayMs: () => 0, retryable: () => true }, ...options });
  return { runtime, requests };
}
const stops = [
  { native: "refusal", reason: "refusal", error: "provider_refused" },
  { native: "max_tokens", reason: "max_tokens", error: "incomplete_stop" },
  { native: "model_context_window_exceeded", reason: "context_limit", error: "incomplete_stop" },
  { native: "pause_turn", reason: "pause", error: "incomplete_stop" },
  { native: "future_stop", reason: "unknown", error: "incomplete_stop" },
] as const;

for (const stop of stops) {
  test(`a ${stop.native} response preserves its outcome and charge through checkpoint reopen`, async t => {
    const app = fixture(t);
    const hooks = app.spend.hooks({ quote: () => ({ scope: "budget", amount: 30, limit: 30, pricing: {} }), charge: () => 20 });
    const records: ModelCallRecord[] = [];
    const checkpointStops: unknown[] = [];
    const { runtime, requests } = transport([message(stop.native)], { modelCalls: {
      admit: hooks.admit,
      record: async (call, context) => {
        checkpointStops.push(app.steps.inspect(request)?.report.modelCalls[0].stop);
        records.push(structuredClone(call));
        await hooks.record!(call, context);
      },
    } });
    await assert.rejects(app.steps.run(request, runtime, input), (error: unknown) => {
      assert.ok(error instanceof RuntimeError && error.report);
      assert.equal(error.code, stop.error);
      assert.deepEqual(error.report.modelCalls[0].stop, { reason: stop.reason, nativeReason: stop.native });
      assert.equal(error.report.modelCalls[0].status, "responded");
      return true;
    });
    const before = app.steps.inspect(request)!;
    const callId = before.report.modelCalls[0].callId;
    assert.deepEqual(checkpointStops, [{ reason: stop.reason, nativeReason: stop.native }]);
    assert.deepEqual(records[0].stop, before.report.modelCalls[0].stop);
    assert.equal(before.report.modelCalls[0].requestId, "request-1");
    assert.equal(before.report.usage[0].freshInputTokens, 12);
    assert.doesNotMatch(String(app.db.prepare("SELECT report_json FROM small_hour_model_steps").get()?.report_json), /private partial prose/);
    app.close();
    const reopened = app.open();
    assert.deepEqual(reopened.steps.inspect(request), before);
    assert.deepEqual(reopened.spend.inspect(callId)?.record?.stop, before.report.modelCalls[0].stop);
    assert.equal(reopened.spend.inspect(callId)?.status, "accepted");
    assert.equal(reopened.spend.inspectBudget("budget").totalAmount, 20);
    await assert.rejects(reopened.steps.run(request, runtime, input), { code: "step_unresolved" });
    assert.equal(requests.length, 1);
  });

  test(`mixed text and tools under ${stop.native} authorize no effect, accepted output, or retry`, async t => {
    const { steps } = fixture(t);
    let effects = 0, accepted = 0;
    const { runtime, requests } = transport([message(stop.native, [{ type: "text", text: "looks complete" }, tool])], {
      tools: new ToolRegistry([{ name: "save", description: "Save an item", inputSchema: {}, execute: () => { effects++; } }]),
      outputPolicy: { apply: text => { accepted++; return { accepted: true, output: text }; } },
    });
    await assert.rejects(steps.run(request, runtime, input));
    const state = steps.inspect(request)!;
    assert.equal(state.status, "failed");
    assert.deepEqual(state.report.modelCalls[0].stop, { reason: stop.reason, nativeReason: stop.native });
    assert.equal(state.report.toolCalls[0].status, "not_started");
    assert.equal(effects, 0); assert.equal(accepted, 0); assert.equal(requests.length, 1);
  });
}

test("known stop evidence survives missing usage and an accounting failure", async t => {
  const app = fixture(t);
  const { runtime, requests } = transport([message("model_context_window_exceeded", undefined, null)], {
    modelCalls: { record: () => { throw new Error("accounting unavailable"); } },
  });
  await assert.rejects(app.steps.run(request, runtime, input), { code: "model_call_accounting_failed" });
  app.close();
  const call = app.open().steps.inspect(request)!.report.modelCalls[0];
  assert.equal(call.status, "responded");
  assert.equal(call.usage, undefined); assert.equal(call.accounting, "unrecorded");
  assert.deepEqual(call.stop, { reason: "context_limit", nativeReason: "model_context_window_exceeded" });
  assert.equal(requests.length, 1);
});

test("a completed local receipt remains intact when the following provider call exhausts context", async t => {
  const app = fixture(t);
  app.db.exec("CREATE TABLE saved_items (id TEXT PRIMARY KEY)");
  let effects = 0;
  const { runtime, requests } = transport([message("tool_use", [tool]), message("model_context_window_exceeded")], {
    tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, execute: (_value, context) => {
      const saved = app.operations.commit({ ...request, id: "save-item", kind: "save" }, {
        execute: db => { effects++; db.prepare("INSERT INTO saved_items VALUES ('item-7')").run(); return { itemId: "item-7" }; },
        parseResult: value => value as { itemId: string },
      });
      context.recordReceipt(saved.receipt.id);
      return saved.receipt.result;
    } }]),
  });
  await assert.rejects(app.steps.run(request, runtime, input), { code: "incomplete_stop" });
  const before = app.steps.inspect(request)!;
  assert.equal(before.report.toolCalls[0].status, "completed");
  assert.equal(before.report.toolCalls[0].receiptIds.length, 1);
  assert.deepEqual(before.report.modelCalls.map(call => call.stop?.reason), ["tool_use", "context_limit"]);
  app.close();
  const reopened = app.open();
  assert.deepEqual(reopened.steps.inspect(request), before);
  await assert.rejects(reopened.steps.run(request, runtime, input), { code: "step_unresolved" });
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM saved_items").get()?.n, 1);
  assert.equal(effects, 1); assert.equal(requests.length, 2);
});

test("normal tool continuation and final output retain detached stop evidence on replay", async t => {
  const app = fixture(t);
  const { runtime, requests } = transport([message("tool_use", [tool]), message("end_turn", [{ type: "text", text: "Saved item-7." }])], {
    tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, mode: "read", execute: () => ({ itemId: "item-7" }) }]),
    modelCalls: { record: call => { if (call.stop) call.stop.reason = "unknown"; } },
  });
  const first = await app.steps.run(request, runtime, input);
  assert.deepEqual(first.result.modelCalls.map(call => call.stop?.reason), ["tool_use", "end_turn"]);
  assert.equal(first.result.output, "Saved item-7.");
  assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, "tool-1");
  app.close();
  const replay = await app.open().steps.run(request, runtime, input);
  assert.deepEqual(replay.result, first.result); assert.equal(requests.length, 2);
});

test("older checkpoints without stop evidence remain readable without inventing a reason", async t => {
  const { steps, db } = fixture(t);
  const { runtime, requests } = transport([message("stop_sequence", [{ type: "text", text: "Complete." }])]);
  const first = await steps.run(request, runtime, input);
  assert.deepEqual(first.result.modelCalls[0].stop, { reason: "stop_sequence", nativeReason: "stop_sequence" });
  for (const column of ["report_json", "result_json"]) {
    const saved = JSON.parse(String(db.prepare(`SELECT ${column} FROM small_hour_model_steps`).get()?.[column]));
    delete saved.modelCalls[0].stop;
    db.prepare(`UPDATE small_hour_model_steps SET ${column} = ?`).run(JSON.stringify(saved));
  }
  assert.equal(steps.inspect(request)!.report.modelCalls[0].stop, undefined);
  assert.equal((await steps.run(request, runtime, input)).result.modelCalls[0].stop, undefined);
  assert.equal(requests.length, 1);
});

test("malformed or contradictory saved stop evidence cannot release a result", async t => {
  const { steps, db } = fixture(t);
  const { runtime, requests } = transport([message("end_turn", [{ type: "text", text: "Complete." }])]);
  await steps.run(request, runtime, input);
  const row = db.prepare("SELECT report_json, result_json FROM small_hour_model_steps").get()!;
  const original = JSON.parse(String(row.report_json)), originalResult = JSON.parse(String(row.result_json));
  for (const update of [
    { stop: { reason: "invented" } },
    { stop: { reason: "end_turn", nativeReason: {} } },
    { stop: { reason: "end_turn", nativeReason: "" } },
    { stop: { nativeReason: "end_turn" } },
    { status: "unknown", stop: { reason: "end_turn" } },
    { stop: { reason: "refusal", nativeReason: "refusal" } },
    { stop: { reason: "context_limit" } },
  ]) {
    const report = structuredClone(original); Object.assign(report.modelCalls[0], update);
    const result = structuredClone(originalResult); Object.assign(result.modelCalls[0], update);
    db.prepare("UPDATE small_hour_model_steps SET report_json = ?, result_json = ?").run(JSON.stringify(report), JSON.stringify(result));
    assert.throws(() => steps.inspect(request), { code: "invalid_checkpoint" });
    await assert.rejects(steps.run(request, runtime, input), { code: "invalid_checkpoint" });
  }
  assert.equal(requests.length, 1);
});

test("a refused response without usage preserves the full spending reservation", async t => {
  const app = fixture(t);
  const hooks = app.spend.hooks({ quote: () => ({ scope: "budget", amount: 30, limit: 30, pricing: {} }),
    charge: () => assert.fail("missing usage cannot be priced") });
  const { runtime, requests } = transport([message("refusal", undefined, null)], { modelCalls: hooks });
  await assert.rejects(app.steps.run(request, runtime, input), { code: "provider_refused" });
  const callId = app.steps.inspect(request)!.report.modelCalls[0].callId;
  app.close();
  const reopened = app.open();
  assert.equal(reopened.spend.inspect(callId)?.status, "unknown");
  assert.equal(reopened.spend.inspectBudget("budget").totalAmount, 30);
  assert.deepEqual(reopened.spend.inspect(callId)?.record?.stop, { reason: "refusal", nativeReason: "refusal" });
  assert.equal(requests.length, 1);
});

test("a stopped structured response never reaches the application parser", async t => {
  const { steps } = fixture(t);
  let parsed = 0;
  const { runtime, requests } = transport([message("model_context_window_exceeded", [{ type: "text", text: '{"itemId":"item-7"}' }])]);
  await assert.rejects(steps.run(request, runtime, { agentId: "app", input: input.input,
    structuredOutput: { schema: { type: "object" }, parse: value => { parsed++; return value; } },
  }), { code: "incomplete_stop" });
  assert.equal(parsed, 0); assert.equal(requests.length, 1);
});

test("observer mutations cannot replace the recorded provider outcome", async () => {
  const { runtime } = transport([message("end_turn")]);
  const result = await runtime.turn(input, { checkpoint: report => {
    for (const call of report.modelCalls) if (call.stop) call.stop.reason = "unknown";
  } });
  assert.deepEqual(result.modelCalls[0].stop, { reason: "end_turn", nativeReason: "end_turn" });
});

test("invalid custom-provider stop metadata preserves usage before stopping acceptance", async t => {
  const { steps } = fixture(t);
  let calls = 0, accepted = 0;
  const records: ModelCallRecord[] = [];
  const runtime = new SmallHourRuntime({ provider: { name: "custom", async complete() {
    calls++;
    return { content: [{ type: "text", text: "Complete." }], stopReason: "end_turn", nativeStopReason: { content: "private" },
      usage: { model: "custom", freshInputTokens: 12, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 8 },
    } as unknown as ProviderResponse;
  } }, persona: new StaticPersonaSource("Process."), memory: new EmptyMemorySource(),
  modelCalls: { record: call => { records.push(structuredClone(call)); } },
  outputPolicy: { apply: output => { accepted++; return { accepted: true, output }; } },
  });
  await assert.rejects(steps.run(request, runtime, { ...input, allowedTools: [] }), { code: "invalid_provider_stop" });
  assert.equal(calls, 1); assert.equal(accepted, 0);
  assert.equal(records[0].status, "responded"); assert.equal(records[0].usage?.outputTokens, 8);
  assert.equal(records[0].stop, undefined);
  assert.equal(steps.inspect(request)!.report.usage[0].freshInputTokens, 12);
});
