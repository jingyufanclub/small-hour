import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider } from "../src/index.js";
import { SqliteModelSpendStore, SqliteModelStepStore } from "../src/durable/sqlite.js";

const request = { scope: "app", id: "compose", kind: "compose", version: "1", input: { id: "item-7" } };
const input = { agentId: "app", input: "Describe item-7.", allowedTools: [] };
const recovery = { sideEffectFree: true as const, maxAttempts: 3, maxModelCalls: 3 };
const usage = { model: "fixture", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
const response = { content: [{ type: "text" as const, text: "Item-7 is saved." }], stopReason: "end_turn" as const, usage };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-recovery-spend-")), connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(join(directory, "app.sqlite")); connections.add(db);
    const spend = new SqliteModelSpendStore(db), steps = new SqliteModelStepStore(db);
    spend.initialize(); steps.initialize();
    return { db, spend, steps, close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open };
}
function runtime(spend: SqliteModelSpendStore, provider: ModelProvider, limit = 20) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Describe supplied facts."), memory: new EmptyMemorySource(),
    retry: { attempts: 1 }, modelCalls: spend.hooks({ quote: () => ({ scope: "budget", limit, amount: 10, pricing: { revision: 1 } }),
      charge: tokens => tokens.freshInputTokens + tokens.outputTokens }) });
}
function decision(steps: SqliteModelStepStore) {
  return { action: "retry" as const, checkpoint: steps.inspect(request)!.checkpoint,
    reason: "Authorize another pure model attempt within the remaining budget", evidence: { policy: "pure-model-v1" } };
}

for (const failure of ["transport", "missing-usage", "settlement-write"] as const) {
  test(`recovery after ${failure} retains the old charge and spends only remaining allowance`, async t => {
    const f = fixture(t), app = f.open(); let calls = 0;
    if (failure === "settlement-write") app.db.exec(`CREATE TRIGGER reject_settlement BEFORE UPDATE ON small_hour_model_spend
      BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END`);
    const provider: ModelProvider = { name: "fixture", async complete() {
      calls++;
      if (failure === "transport") throw new Error("response lost");
      return failure === "missing-usage" ? { ...response, usage: undefined, stopReason: "max_tokens" } : response;
    } };
    await assert.rejects(app.steps.run(request, runtime(app.spend, provider), input, { recovery }),
      { code: failure === "transport" ? "provider_failed" : failure === "missing-usage" ? "incomplete_stop" : "model_call_accounting_failed" });
    const first = app.steps.inspect(request)!, oldCall = first.report.modelCalls[0], oldSpend = app.spend.inspect(oldCall.callId);
    assert.equal(oldSpend?.status, failure === "settlement-write" ? "reserved" : "unknown");
    assert.equal(app.spend.inspectBudget("budget").totalAmount, 10);
    if (failure === "settlement-write") {
      assert.equal(oldCall.status, "responded"); assert.deepEqual(oldCall.usage, usage);
      assert.equal(oldCall.accounting, "unrecorded"); app.db.exec("DROP TRIGGER reject_settlement");
    }
    app.close(); const reopened = f.open();
    const model = runtime(reopened.spend, { name: "fixture", async complete() {
      calls++; assert.equal(reopened.spend.inspectBudget("budget").totalAmount, 20); return response;
    } });
    const accepted = await reopened.steps.recover(request, model, input, decision(reopened.steps));
    assert.equal(accepted.result.accepted, true);
    assert.deepEqual(reopened.spend.inspect(oldCall.callId), oldSpend);
    assert.deepEqual(reopened.steps.inspect(request)?.attempts[0].report, first.report);
    assert.equal(reopened.spend.inspectBudget("budget").totalAmount, 13);
    const newCall = accepted.result.modelCalls[0];
    assert.equal(reopened.spend.inspect(newCall.callId)?.status, "accepted"); assert.notEqual(newCall.callId, oldCall.callId);
    await reopened.steps.run(request, model, input, { recovery });
    assert.equal(calls, 2); assert.equal(reopened.spend.inspectBudget("budget").totalAmount, 13);
  });
}

test("an explicit recovery decision cannot release unknown money to buy another provider call", async t => {
  const app = fixture(t).open(); let calls = 0;
  const model = runtime(app.spend, { name: "fixture", async complete() { calls++; throw new Error("response lost"); } }, 10);
  await assert.rejects(app.steps.run(request, model, input, { recovery }), { code: "provider_failed" });
  const oldCall = app.steps.inspect(request)!.report.modelCalls[0];
  await assert.rejects(app.steps.recover(request, model, input, decision(app.steps)), { code: "model_call_denied" });
  assert.equal(calls, 1); assert.equal(app.spend.inspect(oldCall.callId)?.status, "unknown");
  assert.equal(app.spend.inspectBudget("budget").totalAmount, 10);
  const current = app.steps.inspect(request)!;
  assert.equal(current.attempts.length, 2); assert.equal(current.report.modelCalls[0].status, "not_started");
  assert.equal(app.spend.inspect(current.report.modelCalls[0].callId)?.status, "denied");
});

test("a superseded response preserves charge evidence without settling its old reservation", async t => {
  const app = fixture(t).open(); let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const old = app.steps.run(request, runtime(app.spend, { name: "fixture", async complete() {
    calls++; entered(); await gate; return { ...response, requestId: "late-response" };
  } }), input, { recovery });
  const oldFailure = assert.rejects(old, { code: "step_changed" }); await started;
  const oldCall = app.steps.inspect(request)!.report.modelCalls[0];
  assert.equal(app.spend.inspect(oldCall.callId)?.status, "reserved");
  await app.steps.recover(request, runtime(app.spend, { name: "fixture", async complete() { calls++; return response; } }), input, decision(app.steps));
  release(); await oldFailure;
  const state = app.steps.inspect(request)!;
  assert.equal(state.status, "completed");
  assert.equal(state.attempts[0].report.modelCalls[0].requestId, "late-response");
  assert.deepEqual(state.attempts[0].report.modelCalls[0].usage, usage);
  assert.equal(app.spend.inspect(oldCall.callId)?.status, "reserved");
  assert.equal(app.spend.inspectBudget("budget").totalAmount, 13); assert.equal(calls, 2);
});
