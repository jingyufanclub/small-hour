import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource,
  type ModelCallHooks, type ModelProvider, type ProviderResponse } from "../src/index.js";
import { SqliteModelCallStore, SqliteTaskRunner, type ModelRecoveryContract, type TaskState, type TaskWorkflow } from "../src/durable/sqlite.js";

const task = { scope: "app", id: "reply", kind: "compose", version: "1", input: { itemId: "item-7" } };
const schedule = { concurrencyScope: "app", dueAt: 0, maxAttempts: 2 };
const usage = { model: "fixture", freshInputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
const response: ProviderResponse = { content: [{ type: "text", text: "Saved item-7." }], stopReason: "end_turn", usage };
const recovery = { sideEffectFree: true as const, maxAttempts: 2, maxModelCalls: 2, admissionDenials: "pause" as const };
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
function fixture(t: TestContext, options: {
  recovery?: ModelRecoveryContract; transportAttempts?: number;
  hooks?: (hooks: ModelCallHooks) => ModelCallHooks;
  failureInfo?: ModelProvider["failureInfo"];
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-admission-")), connections = new Set<DatabaseSync>();
  let now = 100, limit = 0, calls = 0, allowed = true;
  let complete: ModelProvider["complete"] = async () => response;
  const open = () => {
    const db = new DatabaseSync(join(directory, "app.sqlite")); connections.add(db);
    db.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    const spend = new SqliteModelCallStore(db); spend.initialize();
    const hooks = spend.hooks({ quote: () => ({ scope: "budget", limit, amount: 10, pricing: { revision: 1 } }), charge: () => 2 });
    const runtime = new SmallHourRuntime({ provider: { name: "fixture", isRetryable: () => true, failureInfo: options.failureInfo,
      complete: request => { calls++; assert.equal(request.messages[0].content, '{"itemId":"item-7"}'); return complete(request); } },
      persona: new StaticPersonaSource("Use supplied facts."), memory: new EmptyMemorySource(),
      modelCalls: options.hooks?.(hooks) ?? hooks, retry: { attempts: options.transportAttempts ?? 1, delayMs: () => 0 } });
    const workflow: TaskWorkflow<DatabaseSync> = { kind: task.kind, version: task.version,
      authorize: () => allowed ? { status: "allow" } : { status: "rejected", reason: "revoked" },
      retry: () => ({ reason: "local_write_failed", dueAt: now }), steps: [
        { id: "save", kind: "local", parseResult: value => value, execute: (db, context) => {
          db.prepare("INSERT INTO effects VALUES (?, 'prepared')").run(context.task.id + "/input"); return context.task.input;
        } },
        { id: "compose", kind: "model", recovery: options.recovery ?? recovery,
          prepare: context => ({ runtime, input: { agentId: "app", input: JSON.stringify(context.results.save), allowedTools: [] } }) },
        { id: "stage", kind: "local", parseResult: value => value, execute: (db, context) => {
          const result = context.results.compose as { output: string };
          db.prepare("INSERT INTO effects VALUES (?, ?)").run(context.task.id + "/output", result.output); return result.output;
        } },
      ] };
    const runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, now: () => now }); runner.initialize();
    return { db, spend, runner, close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, setLimit: (value: number) => { limit = value; }, setAllowed: (value: boolean) => { allowed = value; },
    advance: (value: number) => { now = value; }, respond: (value: ModelProvider["complete"]) => { complete = value; }, calls: () => calls };
}
function decision(state: TaskState) {
  const step = state.steps.find(step => step.kind === "model" && step.status === "unresolved");
  assert.ok(step?.model);
  return { stepId: step.id, action: "retry" as const, checkpoint: step.model.checkpoint,
    reason: "Application authorizes another admission check", evidence: { policyRevision: 1 } };
}

test("repeated budget refusals preserve the saved task and both retry allowances across restart", async t => {
  const f = fixture(t); let app = f.open(); app.runner.enqueue(task, schedule);
  let state = (await app.runner.run(task))!;
  const callIds: string[] = [];
  for (let count = 1; count <= 12; count++) {
    assert.equal(state.status, "paused"); assert.equal(state.reason, "model_admission_denied");
    assert.equal(state.attempts, count); assert.equal(state.admissionPauses, count);
    assert.equal(f.calls(), 0); assert.equal(await app.runner.run(task), undefined);
    const call = state.steps[1].model!.report.modelCalls[0]; callIds.push(call.callId);
    assert.equal(call.admission, "denied"); assert.equal(app.spend.inspect(call.callId)?.status, "denied");
    if (count === 6) {
      const { error: _, ...saved } = state;
      app.close(); app = f.open(); assert.deepEqual(app.runner.inspect(task), saved);
    }
    if (count < 12) state = (await app.runner.retryModel(task, decision(state)))!;
  }
  f.setLimit(10);
  const done = (await app.runner.retryModel(task, decision(state)))!;
  assert.equal(done.status, "completed"); assert.equal(done.attempts - done.admissionPauses, 1);
  assert.equal(f.calls(), 1); assert.equal(new Set(callIds).size, 12);
  assert.equal(done.steps[1].model!.attempts.length, 13);
  for (const callId of callIds) assert.equal(app.spend.inspect(callId)?.status, "denied");
  assert.deepEqual(app.db.prepare("SELECT * FROM effects ORDER BY id").all().map(row => ({ ...row })), [
    { id: "reply/input", body: "prepared" }, { id: "reply/output", body: "Saved item-7." },
  ]);
  assert.equal(app.spend.inspectBudget("budget").totalAmount, 2);
  assert.equal(await app.runner.run(task), undefined); assert.equal(f.calls(), 1);
});

test("legacy counting still bounds admission denials without pause opt-in", async t => {
  const { admissionDenials: _, ...legacy } = recovery;
  const f = fixture(t, { recovery: legacy }), app = f.open(); app.runner.enqueue(task, schedule);
  const first = (await app.runner.run(task))!;
  const second = (await app.runner.retryModel(task, decision(first)))!;
  f.setLimit(100);
  const stopped = (await app.runner.retryModel(task, decision(second)))!;
  assert.equal(stopped.status, "uncertain"); assert.equal(stopped.reason, "attempt_limit");
  assert.equal(stopped.admissionPauses, 0); assert.equal(f.calls(), 0);
});

for (const prior of ["unknown", "charged"] as const) {
  test(`budget pauses preserve ${prior} spending and genuine attempt limits`, async t => {
    const f = fixture(t), app = f.open(); f.setLimit(10);
    f.respond(async () => { if (prior === "unknown") throw new Error("response lost"); return { ...response, stopReason: "max_tokens" }; });
    app.runner.enqueue(task, schedule);
    let state = (await app.runner.run(task))!;
    assert.equal(state.status, "uncertain");
    const oldCall = state.steps[1].model!.report.modelCalls[0];
    const oldSpend = app.spend.inspect(oldCall.callId);
    f.setLimit(0);
    for (let i = 0; i < 4; i++) {
      state = (await app.runner.retryModel(task, decision(state)))!;
      assert.equal(state.status, "paused"); assert.equal(state.attempts - state.admissionPauses, 1);
      assert.deepEqual(app.spend.inspect(oldCall.callId), oldSpend); assert.equal(f.calls(), 1);
    }
    f.setLimit(20);
    state = (await app.runner.retryModel(task, decision(state)))!;
    assert.equal(f.calls(), 2); assert.equal(state.status, "uncertain");
    state = (await app.runner.retryModel(task, decision(state)))!;
    assert.equal(state.reason, "attempt_limit"); assert.equal(f.calls(), 2);
    assert.deepEqual(app.spend.inspect(oldCall.callId), oldSpend);
    assert.equal(app.spend.inspectBudget("budget").totalAmount, prior === "unknown" ? 20 : 4);
  });
}

test("a refusal after a dispatched transport retry does not credit the model or task attempt", async t => {
  const f = fixture(t, { transportAttempts: 2, recovery: { ...recovery, maxAttempts: 1 } }), app = f.open();
  f.setLimit(10); f.respond(async () => { throw new Error("response lost"); });
  app.runner.enqueue(task, schedule);
  let state = (await app.runner.run(task))!;
  assert.equal(state.status, "uncertain"); assert.equal(state.admissionPauses, 0);
  assert.deepEqual(state.steps[1].model!.report.modelCalls.map(call => call.status), ["unknown", "not_started"]);
  f.setLimit(100); state = (await app.runner.retryModel(task, decision(state)))!;
  assert.equal(state.status, "uncertain"); assert.equal(f.calls(), 1);
  assert.equal(app.spend.inspectBudget("budget").unknownAmount, 10);
});

test("an admission exception is not a proven refusal", async t => {
  const f = fixture(t, { hooks: () => ({ admit: () => { throw new Error("admission storage unavailable"); } }) }), app = f.open();
  app.runner.enqueue(task, { ...schedule, maxAttempts: 1 });
  const state = (await app.runner.run(task))!;
  assert.equal(state.status, "uncertain"); assert.equal(state.admissionPauses, 0);
  assert.equal(state.steps[1].model!.report.modelCalls[0].admission, undefined);
  assert.equal((await app.runner.retryModel(task, decision(state)))?.reason, "attempt_limit");
  assert.equal(f.calls(), 0);
});

for (const bound of ["model_attempt", "model_call", "task_claim"] as const) {
  test(`${bound} allowance still stops actual failures after an admission pause`, async t => {
    const f = fixture(t, { recovery: { ...recovery, maxAttempts: bound === "model_attempt" ? 1 : 5,
      maxModelCalls: bound === "model_call" ? 1 : 5 } }), app = f.open();
    app.runner.enqueue(task, { ...schedule, maxAttempts: bound === "task_claim" ? 1 : 5 });
    let state = (await app.runner.run(task))!;
    assert.equal(state.status, "paused");
    f.setLimit(100); f.respond(async () => { throw new Error("response lost"); });
    state = (await app.runner.retryModel(task, decision(state)))!;
    assert.equal(state.status, "uncertain"); assert.equal(f.calls(), 1);
    state = (await app.runner.retryModel(task, decision(state)))!;
    assert.equal(f.calls(), 1); assert.equal(state.status, "uncertain");
    if (bound === "task_claim") assert.equal(state.reason, "attempt_limit");
    else assert.equal((state.error as { code: string }).code, "recovery_limit");
    assert.equal(state.admissionPauses, 1);
  });
}

test("a provider rejection consumes an attempt even when its charge is zero", async t => {
  const f = fixture(t, { failureInfo: () => ({ status: "rejected" }) }), app = f.open();
  f.setLimit(100); f.respond(async () => { throw new Error("provider rejected locally"); });
  app.runner.enqueue(task, { ...schedule, maxAttempts: 1 });
  const state = (await app.runner.run(task))!;
  assert.equal(state.status, "uncertain"); assert.equal(state.admissionPauses, 0);
  assert.equal(state.steps[1].model!.report.modelCalls[0].admission, undefined);
  assert.equal((await app.runner.retryModel(task, decision(state)))?.reason, "attempt_limit");
  assert.equal(f.calls(), 1); assert.equal(app.spend.inspectBudget("budget").totalAmount, 0);
});

test("an invalid admission return does not create refusal evidence", async t => {
  const f = fixture(t, { hooks: () => ({ admit: () => undefined as unknown as boolean }) }), app = f.open();
  app.runner.enqueue(task, schedule);
  const state = (await app.runner.run(task))!;
  assert.equal(state.status, "uncertain"); assert.equal(state.admissionPauses, 0);
  assert.equal(state.steps[1].model!.report.modelCalls[0].admission, undefined); assert.equal(f.calls(), 0);
});

test("failed spending admission storage neither dispatches nor credits a pause", async t => {
  const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
  app.db.exec(`CREATE TRIGGER reject_admission BEFORE INSERT ON model_calls
    BEGIN SELECT RAISE(ABORT, 'admission unavailable'); END`);
  const state = (await app.runner.run(task))!;
  assert.equal(state.status, "uncertain"); assert.equal(state.admissionPauses, 0); assert.equal(f.calls(), 0);
  assert.equal(app.db.prepare("SELECT count(*) n FROM model_calls").get()?.n, 0);
});

test("adding pause permission cannot change the contract of saved work", async t => {
  const { admissionDenials: _, ...legacy } = recovery;
  const options: { recovery: ModelRecoveryContract } = { recovery: legacy };
  const f = fixture(t, options), app = f.open(); app.runner.enqueue(task, schedule);
  const state = (await app.runner.run(task))!;
  app.close(); options.recovery = recovery;
  const reopened = f.open();
  await assert.rejects(reopened.runner.retryModel(task, decision(state)), { code: "contract_conflict" });
  assert.equal(reopened.runner.inspect(task)?.attempts, 1); assert.equal(f.calls(), 0);
});

test("the admission counter upgrade joins setup rollback and preserves old task evidence", async t => {
  const { admissionDenials: _, ...legacy } = recovery;
  const f = fixture(t, { recovery: legacy }), app = f.open(); app.runner.enqueue(task, schedule);
  await app.runner.run(task);
  const before = app.runner.inspect(task)!;
  app.db.exec("ALTER TABLE small_hour_tasks DROP COLUMN admission_pauses");
  app.db.exec("BEGIN"); app.runner.initialize(); app.db.exec("ROLLBACK");
  assert.equal(app.db.prepare("SELECT name FROM pragma_table_info('small_hour_tasks') WHERE name = 'admission_pauses'").get(), undefined);
  app.runner.initialize(); app.runner.initialize();
  assert.deepEqual(app.runner.inspect(task), before);
  f.setLimit(10);
  assert.equal((await app.runner.retryModel(task, decision(before)))?.status, "completed");
  assert.equal(f.calls(), 1); assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 2);
});

test("contradictory refusal evidence and unsupported pause credits fail before re-entry", async t => {
  const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
  const paused = (await app.runner.run(task))!;
  const model = paused.steps[1].request;
  app.db.prepare("UPDATE small_hour_model_steps SET report_json = json_set(report_json, '$.report.modelCalls[0].status', 'unknown') WHERE scope = ? AND id = ?")
    .run(model.scope, model.id);
  await assert.rejects(app.runner.retryModel(task, decision(paused)), { code: "invalid_checkpoint" });
  assert.equal(f.calls(), 0);
  app.db.prepare("UPDATE small_hour_model_steps SET report_json = json_set(report_json, '$.report.modelCalls[0].status', 'not_started') WHERE scope = ? AND id = ?")
    .run(model.scope, model.id);
  app.db.exec("UPDATE small_hour_tasks SET attempts = 2, admission_pauses = 2");
  await assert.rejects(app.runner.retryModel(task, decision(paused)), { code: "invalid_task" });
  assert.equal(f.calls(), 0);
});

test("an admission race pauses the losing task and admits it after the first reservation settles", async t => {
  const f = fixture(t), a = f.open(), b = f.open(), entered = gate(), release = gate();
  const other = { ...task, id: "other" }; f.setLimit(12);
  f.respond(async () => { entered.resolve(); await release.promise; return response; });
  a.runner.enqueue(task, schedule); b.runner.enqueue(other, { ...schedule, concurrencyScope: "other" });
  assert.equal(b.spend.inspectBudget("budget").totalAmount, 0);
  const pending = a.runner.run(task); await entered.promise;
  const paused = (await b.runner.run(other))!;
  assert.equal(paused.status, "paused"); assert.equal(f.calls(), 1);
  assert.equal(b.spend.inspectBudget("budget").reservedAmount, 10);
  release.resolve(); assert.equal((await pending)?.status, "completed");
  assert.equal((await b.runner.retryModel(other, decision(paused)))?.status, "completed");
  assert.equal(f.calls(), 2); assert.equal(b.spend.inspectBudget("budget").totalAmount, 4);
});

test("a paused task releases its concurrency scope but requires explicit resumption", async t => {
  const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
  const paused = (await app.runner.run(task))!;
  const { error: _, ...saved } = paused;
  app.runner.enqueue({ ...task, id: "other" }, schedule); f.setLimit(20);
  assert.equal((await app.runner.runNext())?.id, "other"); assert.equal(f.calls(), 1);
  assert.deepEqual(app.runner.inspect(task), saved);
  assert.equal((await app.runner.retryModel(task, decision(paused)))?.status, "completed");
  assert.equal(f.calls(), 2);
});

test("competing resumptions retain one claim and one provider call", async t => {
  const f = fixture(t), a = f.open(), b = f.open(), entered = gate(), release = gate();
  a.runner.enqueue(task, schedule); const paused = (await a.runner.run(task))!, selected = decision(paused);
  f.setLimit(10); f.respond(async () => { entered.resolve(); await release.promise; return response; });
  const pending = a.runner.retryModel(task, selected); await entered.promise;
  try { await assert.rejects(b.runner.retryModel(task, selected), { code: "task_changed" }); }
  finally { release.resolve(); }
  assert.equal((await pending)?.status, "completed"); assert.equal(f.calls(), 1);
  await assert.rejects(b.runner.retryModel(task, selected), { code: "task_changed" });
});

test("a late admission refusal cannot credit or replace the worker that recovered an expired claim", async t => {
  const entered = gate(), release = gate(); let admissions = 0;
  const f = fixture(t, { hooks: hooks => ({ ...hooks, admit: async context => {
    if (++admissions === 1) { entered.resolve(); await release.promise; }
    return hooks.admit!(context);
  } }) }), a = f.open(), b = f.open();
  a.runner.enqueue(task, { ...schedule, maxAttempts: 4 });
  const old = a.runner.run(task), stale = assert.rejects(old, { code: "claim_lost" });
  await entered.promise; f.advance(201);
  const uncertain = (await b.runner.run(task))!;
  assert.equal(uncertain.status, "uncertain"); f.setLimit(10);
  const completed = (await b.runner.retryModel(task, decision(uncertain)))!;
  assert.equal(completed.status, "completed"); assert.equal(f.calls(), 1);
  const accepted = completed.steps[1].result;
  release.resolve(); await stale;
  const final = b.runner.inspect(task)!;
  assert.equal(final.status, "completed"); assert.equal(final.admissionPauses, 0);
  assert.deepEqual(final.steps[1].result, accepted); assert.equal(f.calls(), 1);
  const late = final.steps[1].model!.attempts[0];
  assert.equal(late.status, "superseded"); assert.equal(late.report.modelCalls[0].admission, "denied");
  assert.equal(b.spend.inspect(late.report.modelCalls[0].callId)?.status, "denied");
  assert.equal(b.spend.inspectBudget("budget").totalAmount, 2);
});

for (const stop of ["cancel", "permission"] as const) {
  test(`${stop} after a budget pause prevents execution without crediting the same refusal twice`, async t => {
    const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
    const paused = (await app.runner.run(task))!; f.setLimit(10);
    if (stop === "cancel") {
      assert.equal(app.runner.cancel(task, "cancelled_by_app").status, "cancelled");
      await assert.rejects(app.runner.retryModel(task, decision(paused)), { code: "task_changed" });
    } else {
      f.setAllowed(false);
      assert.equal((await app.runner.retryModel(task, decision(paused)))?.status, "rejected");
    }
    assert.equal(app.runner.inspect(task)?.admissionPauses, 1); assert.equal(f.calls(), 0);
    assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  });
}

test("a missing final model checkpoint cannot restore an attempt allowance", async t => {
  const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
  app.db.exec(`CREATE TRIGGER reject_failure BEFORE UPDATE ON small_hour_model_steps WHEN NEW.status = 'failed'
    BEGIN SELECT RAISE(ABORT, 'failed checkpoint unavailable'); END`);
  const state = (await app.runner.run(task))!;
  assert.equal(state.status, "uncertain"); assert.equal(state.admissionPauses, 0); assert.equal(f.calls(), 0);
  assert.equal(state.steps[1].model!.status, "started");
});

test("a rejected task pause write cannot partially credit the claim", async t => {
  const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
  app.db.exec(`CREATE TRIGGER reject_pause BEFORE UPDATE ON small_hour_tasks WHEN NEW.status = 'paused'
    BEGIN SELECT RAISE(ABORT, 'pause unavailable'); END`);
  await assert.rejects(app.runner.run(task), /pause unavailable/);
  const state = app.runner.inspect(task)!;
  assert.equal(state.status, "running"); assert.equal(state.admissionPauses, 0); assert.equal(state.attempts, 1);
  assert.equal(state.steps[1].model!.status, "failed"); assert.equal(f.calls(), 0);
});

test("accepted output survives a later local failure after resuming from budget pause", async t => {
  const f = fixture(t), app = f.open(); app.runner.enqueue(task, schedule);
  const paused = (await app.runner.run(task))!; f.setLimit(10);
  app.db.exec(`CREATE TRIGGER reject_output BEFORE INSERT ON effects WHEN NEW.id = 'reply/output'
    BEGIN SELECT RAISE(ABORT, 'output unavailable'); END`);
  const deferred = (await app.runner.retryModel(task, decision(paused)))!;
  assert.equal(deferred.status, "deferred"); assert.equal(f.calls(), 1);
  const result = deferred.steps[1].model!.status === "completed" && deferred.steps[1].model!.result;
  app.db.exec("DROP TRIGGER reject_output"); app.close();
  const reopened = f.open(), done = (await reopened.runner.run(task))!;
  assert.equal(done.status, "completed"); assert.deepEqual(done.steps[1].result, result); assert.equal(f.calls(), 1);
  assert.equal(reopened.db.prepare("SELECT body FROM effects WHERE id = 'reply/output'").get()?.body, "Saved item-7.");
});
