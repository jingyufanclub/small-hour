import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider, type RuntimeOptions } from "../src/index.js";
import { SqliteTaskRunner, type TaskState, type TaskWorkflow, type ModelStepRecoveryDecision } from "../src/durable/sqlite.js";

const task = { scope: "app", id: "work-1", kind: "compose", version: "1", input: { itemId: "item-7" } };
const schedule = { concurrencyScope: "app", dueAt: 100, maxAttempts: 5 };
const recovery = { sideEffectFree: true as const, maxAttempts: 3, maxModelCalls: 3 };
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
function runtime(provider: ModelProvider, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use the supplied item."), memory: new EmptyMemorySource(),
    retry: { attempts: 1 }, ...options });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-retry-model-")), connections = new Set<DatabaseSync>();
  let now = 100;
  const open = (definition: TaskWorkflow<DatabaseSync>) => {
    const db = new DatabaseSync(join(directory, "app.sqlite")); connections.add(db);
    db.exec("CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    const runner = new SqliteTaskRunner(db, [definition], { leaseMs: 100, now: () => now }); runner.initialize();
    return { db, runner, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, advance: (value: number) => { now = value; } };
}
function definition(model: SmallHourRuntime, extra: Partial<TaskWorkflow<DatabaseSync>> = {}): TaskWorkflow<DatabaseSync> {
  return { kind: task.kind, version: task.version, authorize: () => ({ status: "allow" }), steps: [
    { id: "save", kind: "local", parseResult: value => value, execute: db => {
      db.prepare("INSERT INTO effects (body) VALUES ('item-7')").run(); return { itemId: "item-7" };
    } },
    { id: "compose", kind: "model", recovery, prepare: context => ({ runtime: model,
      input: { agentId: "app", input: JSON.stringify(context.results.save), allowedTools: [] } }) },
    { id: "stage", kind: "local", parseResult: value => value, execute: (db, context) => {
      const result = context.results.compose as { output: string; accepted: boolean };
      assert.equal(result.accepted, true);
      db.prepare("INSERT INTO effects (body) VALUES (?)").run(result.output); return { output: result.output };
    } },
  ], ...extra };
}
function decision(state: TaskState): ModelStepRecoveryDecision & { stepId: string } {
  const step = state.steps.find(step => step.kind === "model" && step.status === "unresolved");
  assert.ok(step?.model);
  return { stepId: step.id, action: "retry", checkpoint: step.model.checkpoint, reason: "Pure model retry authorized",
    evidence: { policyRevision: "pure-model-v1", authorization: "current" } };
}

test("authorized composition recovery reuses the committed action and stages only the accepted reply", async t => {
  const f = fixture(t); let calls = 0;
  const workflow = definition(runtime({ name: "fixture", async complete() {
    calls++;
    return { content: [{ type: "text", text: calls === 1 ? "partial" : "Saved item-7." }], stopReason: calls === 1 ? "max_tokens" : "end_turn" };
  } }));
  const first = f.open(workflow); first.runner.enqueue(task, schedule);
  const stopped = (await first.runner.runNext())!;
  assert.equal(stopped.status, "uncertain"); assert.equal(await first.runner.runNext(), undefined);
  assert.equal(first.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  const selected = decision(stopped); first.close();
  const reopened = f.open(workflow);
  const completed = (await reopened.runner.retryModel(task, selected))!;
  assert.equal(completed.status, "completed"); assert.equal(completed.attempts, 2);
  assert.equal(completed.steps[1].model?.attempts.length, 2);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM effects WHERE body = 'item-7'").get()?.n, 1);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM effects WHERE body = 'Saved item-7.'").get()?.n, 1);
  assert.equal(calls, 2);
  assert.equal(reopened.runner.enqueue(task, schedule).status, "completed");
  assert.equal(await reopened.runner.runNext(), undefined);
  await assert.rejects(reopened.runner.retryModel(task, selected), { code: "task_changed" });
  assert.equal(calls, 2);
});

test("a standalone structured selection recovers without reselecting an accepted ID", async t => {
  const f = fixture(t); let calls = 0, parses = 0;
  const model = runtime({ name: "fixture", capabilities: { structuredOutput: true }, async complete() {
    calls++; return { content: [{ type: "text", text: '{"itemId":"item-7"}' }], stopReason: calls === 1 ? "max_tokens" : "end_turn" };
  } });
  const workflow = definition(model, { steps: [{ id: "select", kind: "model", recovery, prepare: () => ({ runtime: model,
    input: { agentId: "app", input: "Select item-7.", structuredOutput: { schema: { type: "object" }, parse: value => {
      parses++; assert.deepEqual(value, { itemId: "item-7" }); return value;
    } } },
  }) }] });
  const { runner } = f.open(workflow); runner.enqueue(task, schedule);
  const first = (await runner.runNext())!; assert.equal(parses, 0);
  const completed = (await runner.retryModel(task, decision(first)))!;
  assert.equal(completed.status, "completed");
  assert.deepEqual((completed.steps[0].result as { value: unknown }).value, { itemId: "item-7" });
  assert.equal(calls, 2); assert.ok(parses > 0);
  assert.equal(await runner.runNext(), undefined); assert.equal(calls, 2);
});

test("stale decisions and changed recovery limits cannot purchase another task attempt", async t => {
  const f = fixture(t); let calls = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return { content: [], stopReason: "max_tokens" }; } });
  const workflow = definition(model), app = f.open(workflow); app.runner.enqueue(task, schedule);
  const first = (await app.runner.runNext())!, selected = decision(first);
  assert.equal((await app.runner.retryModel(task, selected))?.status, "uncertain");
  await assert.rejects(app.runner.retryModel(task, selected), { code: "task_changed" });
  assert.equal(app.runner.inspect(task)?.attempts, 2); assert.equal(calls, 2);
  const changed = f.open({ ...workflow, steps: workflow.steps.map(step => step.kind === "model"
    ? { ...step, recovery: { ...recovery, maxModelCalls: 100 } } : step) });
  await assert.rejects(changed.runner.retryModel(task, decision(app.runner.inspect(task)!)), { code: "contract_conflict" });
  assert.equal(calls, 2); assert.equal(app.runner.inspect(task)?.attempts, 2);
});

test("legacy and malformed recovery requests leave task claims untouched", async t => {
  const f = fixture(t); let calls = 0;
  const workflow = definition(runtime({ name: "fixture", async complete() { calls++; throw new Error("response lost"); } }));
  workflow.steps = workflow.steps.map(step => step.kind === "model" ? { ...step, recovery: undefined } : step);
  const { runner } = f.open(workflow); runner.enqueue(task, schedule);
  const first = (await runner.runNext())!, selected = decision(first);
  await assert.rejects(runner.retryModel(task, selected), { code: "invalid_request" });
  await assert.rejects(runner.retryModel(task, { ...selected, checkpoint: "invented" }), { code: "invalid_request" });
  assert.equal(runner.inspect(task)?.attempts, 1); assert.equal(calls, 1);
});

test("recovery contract mutation cannot increase a submitted task's model allowance", async t => {
  const f = fixture(t); let calls = 0;
  const original = { sideEffectFree: true as const, maxAttempts: 3, maxModelCalls: 1 };
  const workflow = definition(runtime({ name: "fixture", async complete() { calls++; throw new Error("response lost"); } }));
  workflow.steps = workflow.steps.map(step => step.kind === "model" ? { ...step, recovery: original } : step);
  const { runner } = f.open(workflow); runner.enqueue(task, schedule);
  original.maxModelCalls = 100;
  const first = (await runner.runNext())!;
  assert.equal((await runner.retryModel(task, decision(first)))?.status, "uncertain");
  assert.equal(calls, 1);
});

test("task attempt exhaustion and model call exhaustion remain independent limits", async t => {
  for (const limit of ["task", "model"] as const) {
    await t.test(limit, async t => {
      const f = fixture(t); let calls = 0;
      const model = runtime({ name: "fixture", async complete() { calls++; return { content: [], stopReason: "max_tokens" }; } });
      const workflow = definition(model);
      if (limit === "model") workflow.steps = workflow.steps.map(step => step.kind === "model"
        ? { ...step, recovery: { ...recovery, maxModelCalls: 1 } } : step);
      const { runner } = f.open(workflow); runner.enqueue(task, { ...schedule, maxAttempts: limit === "task" ? 1 : 5 });
      const first = (await runner.runNext())!;
      const result = await runner.retryModel(task, decision(first));
      assert.equal(result?.status, "uncertain"); assert.equal(calls, 1);
      assert.equal(result?.steps[2].status, "not_started");
      if (limit === "task") assert.equal(result?.reason, "attempt_limit");
    });
  }
});

test("recovery rechecks current permission and cancellation before another model call", async t => {
  for (const blocked of ["permission", "cancellation"] as const) await t.test(blocked, async t => {
    const f = fixture(t); let calls = 0, allowed = true;
    const workflow = definition(runtime({ name: "fixture", async complete() { calls++; throw new Error("response lost"); } }), {
      authorize: () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" },
    });
    const { runner, db } = f.open(workflow); runner.enqueue(task, schedule);
    const first = (await runner.runNext())!, selected = decision(first);
    if (blocked === "permission") allowed = false;
    else runner.cancel(task, "owner_cancelled");
    const result = await runner.retryModel(task, selected);
    assert.equal(result?.status, "uncertain"); assert.equal(calls, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
    if (blocked === "cancellation") assert.equal(result?.cancellationReason, "owner_cancelled");
  });
});

test("competing recovery cannot claim a running attempt or repeat its effects", async t => {
  const f = fixture(t), entered = gate(), release = gate(); let calls = 0;
  const workflow = definition(runtime({ name: "fixture", async complete() {
    if (++calls === 1) throw new Error("response lost");
    entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Saved." }], stopReason: "end_turn" };
  } }));
  const a = f.open(workflow), b = f.open(workflow); a.runner.enqueue(task, schedule);
  const selected = decision((await a.runner.runNext())!);
  const pending = a.runner.retryModel(task, selected); await entered.promise;
  try { await assert.rejects(b.runner.retryModel(task, selected), { code: "task_changed" }); }
  finally { release.resolve(); }
  assert.equal((await pending)?.status, "completed"); assert.equal(calls, 2);
  assert.equal(a.db.prepare("SELECT count(*) n FROM effects").get()?.n, 2);
});

test("permission revoked during recovery prevents accepting or staging the generated reply", async t => {
  const f = fixture(t), entered = gate(), release = gate(); let calls = 0, allowed = true;
  const workflow = definition(runtime({ name: "fixture", async complete() {
    if (++calls === 1) throw new Error("response lost");
    entered.resolve(); await release.promise;
    return { content: [{ type: "text", text: "Must not be staged." }], stopReason: "end_turn" };
  } }), { authorize: () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" } });
  const { runner, db } = f.open(workflow); runner.enqueue(task, schedule);
  const pending = runner.retryModel(task, decision((await runner.runNext())!)); await entered.promise;
  allowed = false; release.resolve();
  const result = (await pending)!;
  assert.equal(result.status, "rejected"); assert.equal(result.steps[1].status, "unresolved");
  assert.equal(result.steps[1].model?.report.modelCalls[0].status, "responded");
  assert.equal(result.steps[2].status, "not_started");
  assert.equal(db.prepare("SELECT count(*) n FROM effects").get()?.n, 1); assert.equal(calls, 2);
});

test("a superseded worker's late response cannot replace the recovered output", async t => {
  const f = fixture(t), entered = gate(), release = gate(); let calls = 0;
  const workflow = definition(runtime({ name: "fixture", async complete() {
    const first = ++calls === 1;
    if (first) { entered.resolve(); await release.promise; }
    return { content: [{ type: "text", text: first ? "obsolete output" : "Current output." }], stopReason: "end_turn" };
  } }));
  const a = f.open(workflow), b = f.open(workflow); a.runner.enqueue(task, schedule);
  const old = a.runner.runNext(); await entered.promise;
  f.advance(201);
  const uncertain = (await b.runner.runNext())!;
  assert.equal(uncertain.status, "uncertain");
  const completed = await b.runner.retryModel(task, decision(uncertain));
  assert.equal(completed?.status, "completed");
  release.resolve(); await assert.rejects(old);
  const current = b.runner.inspect(task)!;
  assert.equal(current.status, "completed");
  assert.equal((current.steps[1].result as { output: string }).output, "Current output.");
  assert.equal(current.steps[1].model?.attempts[0].report.modelCalls[0].stop?.reason, "end_turn");
  assert.equal(b.db.prepare("SELECT count(*) n FROM effects WHERE body = 'obsolete output'").get()?.n, 0);
  assert.equal(calls, 2);
});
