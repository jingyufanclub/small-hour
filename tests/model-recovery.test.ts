import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider, type ProviderResponse,
  type RuntimeOptions } from "../src/index.js";
import { SqliteModelStepStore, type ModelRecoveryContract } from "../src/durable/model-steps.js";

const request = { scope: "app", id: "select", kind: "selection", version: "1", input: { id: "item-7" } };
const input = { agentId: "app", input: "Select item-7.", allowedTools: [] };
const recovery: ModelRecoveryContract = { sideEffectFree: true, maxAttempts: 3, maxModelCalls: 4 };
const text = (value = "item-7"): ProviderResponse => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const truncated: ProviderResponse = { ...text("partial"), stopReason: "max_tokens" };
function runtime(provider: ModelProvider, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use the supplied ID."), memory: new EmptyMemorySource(),
    retry: { attempts: 1, delayMs: () => 0 }, ...options });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-recovery-"));
  const path = join(directory, "app.sqlite"), connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(path); connections.add(db);
    const store = new SqliteModelStepStore(db); store.initialize();
    return { db, store, close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), path, open };
}
function decision(store: SqliteModelStepStore) {
  return { action: "retry" as const, checkpoint: store.inspect(request)!.checkpoint,
    reason: "The prior attempt produced no accepted result.", evidence: { reviewId: "review-1" } };
}

test("ordinary re-entry preserves incomplete work until an explicit recovery decision", async t => {
  const { store } = fixture(t); let calls = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return truncated; } });
  await assert.rejects(store.run(request, model, input), { code: "incomplete_stop" });
  await assert.rejects(store.run(request, model, input), { code: "step_unresolved" });
  assert.equal(calls, 1);
});

test("an opted-in text step retries explicitly after reopen and replays its accepted result", async t => {
  const app = fixture(t); let calls = 0;
  const turnIds: string[] = [];
  const model = runtime({ name: "fixture", async complete() { return ++calls === 1 ? truncated : text(); } },
    { modelCalls: { admit: context => { turnIds.push(context.turnId); return true; } } });
  await assert.rejects(app.store.run(request, model, input, { recovery }), { code: "incomplete_stop" });
  const previous = app.store.inspect(request)!;
  app.close(); const recovered = app.open();
  await assert.rejects(recovered.store.run(request, model, input, { recovery }), { code: "step_unresolved" });
  const approved = decision(recovered.store);
  const result = await recovered.store.recover(request, model, input, approved);
  assert.equal(result.replayed, false); assert.equal(result.result.output, "item-7");
  assert.notEqual(result.attemptId, previous.attemptId);
  const state = recovered.store.inspect(request)!;
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0].status, "failed");
  assert.deepEqual(state.attempts[0].recovery, approved);
  assert.deepEqual(state.attempts[0].report, previous.report);
  assert.deepEqual(turnIds, [previous.report.turnId, previous.report.turnId]);
  assert.equal(state.attempts[0].report.modelCalls[0].attempt, 1);
  assert.equal(state.attempts[1].report.modelCalls[0].attempt, 1);
  assert.notEqual(state.attempts[0].report.modelCalls[0].callId, state.attempts[1].report.modelCalls[0].callId);
  const replay = await recovered.store.run(request, model, input, { recovery });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, result.result);
  await assert.rejects(recovered.store.recover(request, model, input, approved), { code: "stale_checkpoint" });
  assert.equal(calls, 2);
});

test("structured recovery preserves the selected object without regenerating completed work", async t => {
  const { store } = fixture(t); let calls = 0;
  const structured = { agentId: input.agentId, input: input.input, structuredOutput: {
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    parse: (value: unknown) => { assert.deepEqual(value, { id: "item-7" }); return value as { id: string }; },
  } };
  const model = runtime({ name: "fixture", capabilities: { structuredOutput: true }, async complete() {
    return ++calls === 1 ? text('{"id":"invented"}') : text('{"id":"item-7"}');
  } });
  await assert.rejects(store.run(request, model, structured, { recovery }), { code: "structured_output_invalid" });
  const result = await store.recover(request, model, structured, decision(store));
  assert.deepEqual(result.result.value, { id: "item-7" });
  const replay = await store.recover(request, model, structured, decision(store));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, result.result); assert.equal(calls, 2);
});

test("recovery requires initial opt-in, explicit tool exclusion, unchanged input, and bounded limits", async t => {
  const { store } = fixture(t); let calls = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return truncated; } });
  for (const changed of [
    { ...input, allowedTools: undefined },
    { ...input, allowedTools: ["write"] },
    { ...input, choice: { description: "choose", inputSchema: {}, onChoice: () => assert.fail("choice effect") } },
  ]) await assert.rejects(store.run(request, model, changed, { recovery }), { code: "invalid_request" });
  for (const invalid of [{ ...recovery, sideEffectFree: false }, { ...recovery, maxAttempts: 0 }, { ...recovery, maxModelCalls: Infinity }]) {
    await assert.rejects(store.run(request, model, input, { recovery: invalid as ModelRecoveryContract }), { code: "invalid_request" });
  }
  assert.equal(store.inspect(request), undefined); assert.equal(calls, 0);
  await assert.rejects(store.run(request, model, input, { recovery }), { code: "incomplete_stop" });
  await assert.rejects(store.recover(request, model, { ...input, input: "Select another ID." }, decision(store)), { code: "contract_conflict" });
  await assert.rejects(store.run(request, model, input, { recovery: { ...recovery, maxAttempts: 10 } }), { code: "contract_conflict" });
  assert.equal(calls, 1);
  const legacy = { ...request, id: "legacy" };
  await assert.rejects(store.run(legacy, model, input), { code: "incomplete_stop" });
  await assert.rejects(store.recover(legacy, model, input, { ...decision(store), checkpoint: store.inspect(legacy)!.checkpoint }), { code: "recovery_not_allowed" });
  assert.equal(calls, 2);
});

test("the cumulative call ceiling applies before admission even on the first runtime and a fresh retry runtime", async t => {
  const { store } = fixture(t); let calls = 0, admissions = 0;
  const make = () => runtime({ name: "fixture", isRetryable: () => true, async complete() { calls++; throw new Error("connection uncertain"); } },
    { retry: { attempts: 5, delayMs: () => 0 }, modelCalls: { admit: () => { admissions++; return true; } } });
  const bounded = { ...recovery, maxModelCalls: 2 };
  await assert.rejects(store.run(request, make(), input, { recovery: bounded }), { code: "recovery_limit" });
  assert.equal(calls, 2); assert.equal(admissions, 2);
  const before = store.inspect(request)!;
  assert.equal(before.report.modelCalls.filter(call => call.status === "unknown").length, 2);
  await assert.rejects(store.recover(request, make(), input, decision(store)), { code: "recovery_limit" });
  assert.equal(calls, 2); assert.equal(admissions, 2); assert.deepEqual(store.inspect(request), before);
});

test("attempt limits cannot be reset while unknown calls and costs remain in history", async t => {
  const { store } = fixture(t); let calls = 0;
  const make = () => runtime({ name: "fixture", async complete() { calls++; throw new Error("response lost"); } });
  await assert.rejects(store.run(request, make(), input, { recovery: { ...recovery, maxAttempts: 2 } }), { code: "provider_failed" });
  await assert.rejects(store.recover(request, make(), input, decision(store)), { code: "provider_failed" });
  const state = store.inspect(request)!;
  assert.deepEqual(state.attempts.map(attempt => attempt.report.modelCalls[0].status), ["unknown", "unknown"]);
  assert.ok(state.attempts.every(attempt => attempt.report.modelCalls[0].usage === undefined));
  await assert.rejects(store.recover(request, make(), input, decision(store)), { code: "recovery_limit" });
  assert.equal(calls, 2);
});

test("a takeover fences the late worker while preserving its response only in archived evidence", async t => {
  const app = fixture(t), other = app.open(); let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const old = app.store.run(request, runtime({ name: "fixture", async complete() {
    calls++; entered(); await gate; return { ...text("stale output"), requestId: "old-response", usage: {
      model: "fixture", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1,
    } };
  } }), input, { recovery });
  const oldFailure = assert.rejects(old, { code: "step_changed" });
  await enteredPromise;
  const approved = decision(other.store);
  const result = await other.store.recover(request, runtime({ name: "fixture", async complete() { calls++; return text("current output"); } }), input, approved);
  await assert.rejects(app.store.recover(request, runtime({ name: "fixture", async complete() { assert.fail("stale dispatch"); } }), input, approved), { code: "stale_checkpoint" });
  const checkpoint = other.store.inspect(request)!.checkpoint;
  const acceptedReport = other.store.inspect(request)!.report;
  release(); await oldFailure;
  const state = other.store.inspect(request)!;
  assert.equal(state.status, "completed");
  assert.deepEqual(state.report, acceptedReport);
  assert.deepEqual(state.status === "completed" && state.result, result.result);
  assert.equal(state.attempts[0].status, "superseded");
  assert.equal(state.attempts[0].report.modelCalls[0].status, "responded");
  assert.equal(state.attempts[0].report.modelCalls[0].requestId, "old-response");
  assert.notEqual(state.checkpoint, checkpoint);
  assert.equal(state.status === "completed" && state.result.output, "current output");
  assert.doesNotMatch(String(other.db.prepare("SELECT report_json FROM small_hour_model_steps").get()?.report_json), /stale output|current output/);
  assert.equal(calls, 2);
});

test("a completed output rejection replays without another attempt", async t => {
  const { store } = fixture(t); let calls = 0, checks = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return text(); } }, {
    outputPolicy: { apply: output => { checks++; return { accepted: false, output, issues: ["unacceptable_output"] }; } },
  });
  const first = await store.run(request, model, input, { recovery });
  const replay = await store.recover(request, model, input, decision(store));
  assert.equal(replay.replayed, true); assert.equal(replay.result.status, "rejected");
  assert.deepEqual(replay.result, first.result);
  assert.equal(store.inspect(request)!.attempts.length, 1); assert.equal(calls, 1); assert.equal(checks, 1);
});

test("a final guard failure cannot commit an accepted result", async t => {
  const { store } = fixture(t); let active = true, calls = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return text(); } }, { outputPolicy: {
    apply: output => { active = false; return { accepted: true, output }; },
  } });
  await assert.rejects(store.run(request, model, input, { recovery, assertActive() { if (!active) throw new Error("authority changed"); } }));
  assert.equal(store.inspect(request)?.status, "failed"); assert.equal(calls, 1);
});

test("two concurrent recovery decisions cannot both start from one inspected checkpoint", async t => {
  const app = fixture(t), other = app.open(); let calls = 0, release!: () => void;
  await assert.rejects(app.store.run(request, runtime({ name: "fixture", async complete() { calls++; return truncated; } }), input, { recovery }));
  const approved = decision(app.store), gate = new Promise<void>(resolve => { release = resolve; });
  const model = runtime({ name: "fixture", async complete() { calls++; await gate; return text(); } });
  const first = app.store.recover(request, model, input, approved);
  await assert.rejects(other.store.recover(request, model, input, approved), { code: "stale_checkpoint" });
  release(); await first;
  assert.equal(calls, 2); assert.equal(other.store.inspect(request)!.attempts.length, 2);
});

test("corrupt recovery contracts, history, and evidence cannot authorize another attempt", async t => {
  const { store, db } = fixture(t); let calls = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return truncated; } });
  await assert.rejects(store.run(request, model, input, { recovery }));
  await assert.rejects(store.recover(request, model, input, decision(store)));
  const approved = decision(store);
  const row = db.prepare("SELECT turn_json, report_json FROM small_hour_model_steps").get()!;
  const originalTurn = JSON.parse(String(row.turn_json)), originalReport = JSON.parse(String(row.report_json));
  const corruptions: Array<(turn: any, report: any) => void> = [
    turn => { turn.recovery.maxAttempts = 0; },
    turn => { turn.recovery.sideEffectFree = false; },
    turn => { turn.turnId = "different-turn"; },
    (_turn, report) => { report.attempts[0].recovery.checkpoint = "not-an-inspected-checkpoint"; },
    (_turn, report) => { delete report.attempts[0].recovery.evidence; },
    (_turn, report) => { report.attempts[0].attemptId = store.inspect(request)!.attemptId; },
    (_turn, report) => { report.report.choice = { id: "different-authority" }; },
    (_turn, report) => { report.attempts[0].status = "completed"; },
  ];
  for (const corrupt of corruptions) {
    db.prepare("UPDATE small_hour_model_steps SET turn_json = ?, report_json = ?").run(row.turn_json, row.report_json);
    const turn = structuredClone(originalTurn), report = structuredClone(originalReport);
    corrupt(turn, report);
    db.prepare("UPDATE small_hour_model_steps SET turn_json = ?, report_json = ?").run(JSON.stringify(turn), JSON.stringify(report));
    assert.throws(() => store.inspect(request), { code: "invalid_checkpoint" });
    await assert.rejects(store.recover(request, model, input, approved), { code: "invalid_checkpoint" });
  }
  assert.equal(calls, 2);
});

for (const stage of ["before-takeover", "after-takeover", "after-provider"]) {
  test(`process death ${stage} preserves recovery ownership and requires another explicit decision`, { timeout: 10000 }, async t => {
    const app = fixture(t);
    app.db.exec("CREATE TABLE provider_calls (id INTEGER PRIMARY KEY)");
    const model = runtime({ name: "fixture", async complete() {
      app.db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run(); return truncated;
    } });
    await assert.rejects(app.store.run(request, model, input, { recovery }));
    const before = app.store.inspect(request)!;
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/model-recovery-worker.ts", import.meta.url)), app.path, stage],
      { stdio: ["ignore", "ignore", "pipe"] });
    let errors = ""; child.stderr?.setEncoding("utf8").on("data", chunk => { errors += chunk; });
    const [code, signal] = await once(child, "close");
    assert.equal(signal, "SIGKILL", `worker failed: ${code}: ${errors}`);
    app.close(); const reopened = app.open(), state = reopened.store.inspect(request)!;
    assert.equal(state.attempts.length, stage === "before-takeover" ? 1 : 2);
    if (stage === "before-takeover") assert.equal(state.checkpoint, before.checkpoint);
    if (stage === "after-takeover") assert.equal(state.report.modelCalls.length, 0);
    if (stage === "after-provider") {
      assert.equal(state.report.modelCalls[0].status, "responded");
      assert.deepEqual(state.report.modelCalls[0].stop, { reason: "end_turn" });
    }
    let calls = 0;
    const next = runtime({ name: "fixture", async complete() { calls++; return text(); } });
    await assert.rejects(reopened.store.run(request, next, input, { recovery }), { code: "step_unresolved" });
    assert.equal(calls, 0);
    const result = await reopened.store.recover(request, next, input, decision(reopened.store));
    assert.equal(result.result.output, "item-7"); assert.equal(calls, 1);
    assert.equal(reopened.db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, stage === "after-provider" ? 2 : 1);
  });
}
