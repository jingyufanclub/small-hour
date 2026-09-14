import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry, type ModelProvider } from "../src/index.js";
import { SqliteTaskRunner, type TaskContext, type TaskWorkflow } from "../src/durable/sqlite.js";
import { workerWorkflow, workerTask } from "./fixtures/task-workflow.js";

const task = { scope: "account:a", id: "job-1", kind: "select-and-save", version: "1", input: { ids: ["item-7", "item-2"] } };
const schedule = { concurrencyScope: "account:a", dueAt: 100, maxAttempts: 3 };
const parse = (value: unknown) => value;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function model(provider: ModelProvider) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use supplied facts."), memory: new EmptyMemorySource() });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-tasks-"));
  const path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  let now = 100;
  const open = (workflows: TaskWorkflow<DatabaseSync>[]) => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    connections.add(db);
    const runner = new SqliteTaskRunner(db, workflows, { leaseMs: 100, now: () => now });
    runner.initialize();
    return { db, runner, close: () => { db.close(); connections.delete(db); } };
  };
  const setup = new DatabaseSync(path);
  setup.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE permission (allowed INTEGER); INSERT INTO permission VALUES (1)");
  setup.exec("CREATE TABLE provider_calls (id INTEGER PRIMARY KEY)");
  setup.close();
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, path, advance: (time: number) => { now = time; } };
}
function workflow(steps: TaskWorkflow<DatabaseSync>["steps"], extra: Partial<TaskWorkflow<DatabaseSync>> = {}): TaskWorkflow<DatabaseSync> {
  return { kind: task.kind, version: task.version, steps, authorize: () => ({ status: "allow" }), ...extra };
}
function save(id = "save") {
  return { id, kind: "local" as const, parseResult: parse, execute: (db: DatabaseSync, context: TaskContext) => {
    db.prepare("INSERT INTO effects (body) VALUES (?)").run(JSON.stringify(context.results));
    return { id: `${id}-receipt`, selectedId: "item-7" };
  } };
}

test("ordered saved results survive restart and feed one local effect without another model call", async t => {
  const f = fixture(t);
  let calls = 0, available = false;
  const definition = workflow([save("prepare"), { id: "select", kind: "model", prepare(context) {
    assert.deepEqual(context.results.prepare, { id: "prepare-receipt", selectedId: "item-7" });
    return { runtime: model({ name: "fixture", async complete(input) {
      calls++; assert.equal(input.messages.at(-1)?.content, '{"id":"prepare-receipt","selectedId":"item-7"}');
      return { content: [{ type: "text", text: "item-7" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: JSON.stringify(context.results.prepare), allowedTools: [] } };
  } }, save("finish")], { authorize: context => context.stepId === "finish" && !available
    ? { status: "deferred", dueAt: 200, reason: "destination_unavailable" } : { status: "allow" } });
  const first = f.open([definition]);
  first.runner.enqueue(task, schedule);
  const deferred = await first.runner.runNext();
  assert.equal(deferred?.status, "deferred"); assert.equal(deferred?.reason, "destination_unavailable");
  assert.equal(first.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  first.close();
  const second = f.open([definition]);
  assert.equal(await second.runner.runNext(), undefined);
  available = true; f.advance(200);
  const completed = await second.runner.runNext();
  assert.equal(completed?.status, "completed"); assert.equal(calls, 1);
  assert.deepEqual(completed?.steps.map(step => step.status), ["completed", "completed", "completed"]);
  assert.equal(second.db.prepare("SELECT count(*) n FROM effects").get()?.n, 2);
  assert.equal(await second.runner.runNext(), undefined);
  assert.deepEqual(second.runner.enqueue(task, schedule), second.runner.inspect(task));
});

test("two workers share one task claim and one concurrency scope while independent work proceeds", async t => {
  const f = fixture(t), entered = gate(), release = gate();
  let calls = 0;
  const definition = workflow([{ id: "model", kind: "model", prepare: () => ({
    runtime: model({ name: "fixture", async complete() {
      calls++; entered.resolve(); await release.promise;
      return { content: [{ type: "text", text: "saved" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: "work", allowedTools: [] },
  }) }]);
  const a = f.open([definition]), b = f.open([definition, workflow([save()], { kind: "independent" })]);
  a.runner.enqueue(task, schedule);
  b.runner.enqueue({ ...task, id: "job-2" }, schedule);
  b.runner.enqueue({ ...task, kind: "independent", id: "job-3" }, { ...schedule, concurrencyScope: "account:b" });
  const pending = a.runner.runNext();
  await entered.promise;
  try {
    assert.equal((await b.runner.runNext())?.id, "job-3");
    assert.equal(await b.runner.runNext(), undefined);
    assert.equal(calls, 1);
  } finally { release.resolve(); }
  assert.equal((await pending)?.status, "completed");
  assert.equal((await b.runner.runNext())?.id, "job-2");
  assert.equal(calls, 2);
});

test("cancellation before entry causes no work and cancellation after a local commit preserves it", async t => {
  const f = fixture(t);
  const definition = workflow([save("first"), { id: "model", kind: "model", prepare: context => ({
    runtime: model({ name: "fixture", async complete() {
      other.runner.cancel(context.task, "owner_cancelled");
      return { content: [{ type: "text", text: "finished response" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: "work", allowedTools: [] },
  }) }, save("second")]);
  const app = f.open([definition]), other = f.open([definition]);
  app.runner.enqueue(task, schedule); app.runner.cancel(task, "owner_cancelled");
  assert.equal(await app.runner.runNext(), undefined);
  assert.equal(app.runner.inspect(task)?.status, "cancelled");
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  app.runner.enqueue({ ...task, id: "job-2" }, schedule);
  const result = await app.runner.runNext();
  assert.equal(result?.status, "cancelled"); assert.equal(result?.reason, "owner_cancelled");
  assert.equal(result?.steps[0].status, "completed");
  assert.equal(result?.steps[2].status, "not_started");
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
});

test("claim takeover during a model call never starts another call or lets the stale worker commit", async t => {
  const f = fixture(t), entered = gate(), release = gate();
  let calls = 0;
  const definition = workflow([{ id: "model", kind: "model", prepare: () => ({
    runtime: model({ name: "fixture", async complete() {
      calls++; entered.resolve(); await release.promise;
      return { content: [{ type: "text", text: "late result" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: "work", allowedTools: [] },
  }) }, save()]);
  const a = f.open([definition]), b = f.open([definition]);
  a.runner.enqueue(task, schedule);
  const pending = a.runner.runNext();
  await entered.promise; f.advance(201);
  try {
    const recovered = await b.runner.runNext();
    assert.equal(recovered?.status, "uncertain");
    assert.equal(recovered?.reason, "model_step_unresolved");
    assert.equal(recovered?.steps[0].model?.report.modelCalls[0].status, "unknown");
    b.runner.enqueue({ ...task, id: "job-2" }, schedule);
    assert.equal(await b.runner.runNext(), undefined);
  } finally { release.resolve(); }
  await assert.rejects(pending, { code: "claim_lost" });
  assert.equal(calls, 1);
  assert.equal(a.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  assert.equal(b.runner.inspect(task)?.status, "uncertain");
  assert.throws(() => b.runner.resolve(task, { status: "failed", reason: "checked", evidence: undefined }));
  b.runner.resolve(task, { status: "failed", reason: "provider_finished_without_effects", evidence: { providerRequest: "verified-1" } });
  assert.equal(b.runner.inspect(task)?.status, "failed");
  assert.equal((await b.runner.runNext())?.id, "job-2");
  assert.equal(calls, 2);
});

test("revoked permission after a model response prevents the next local effect", async t => {
  const f = fixture(t);
  const definition = workflow([save("first"), { id: "model", kind: "model", prepare: () => ({
    runtime: model({ name: "fixture", async complete() {
      app.db.prepare("UPDATE permission SET allowed = 0").run();
      return { content: [{ type: "text", text: "selected item-7" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: "select", allowedTools: [] },
  }) }, save("second")], { authorize: () => app.db.prepare("SELECT allowed FROM permission").get()?.allowed === 1
    ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" } });
  const app = f.open([definition]); app.runner.enqueue(task, schedule);
  const result = await app.runner.runNext();
  assert.equal(result?.status, "rejected"); assert.equal(result?.reason, "permission_revoked");
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  assert.equal(result?.steps[0].status, "completed");
  assert.equal(result?.steps[1].model?.report.modelCalls[0].status, "responded");
  assert.equal(result?.steps[2].status, "not_started");
});

test("recovery reads committed steps without reauthorizing their completed effects", async t => {
  const f = fixture(t);
  let finishAllowed = false;
  const definition = workflow([save("first"), save("second")], { authorize: context => {
    if (context.stepId === "first" && context.task.id === "job-1" && recovered) {
      return { status: "rejected", reason: "first_effect_already_committed" };
    }
    return context.stepId === "second" && !finishAllowed ? { status: "deferred", dueAt: 200, reason: "wait" } : { status: "allow" };
  } });
  let recovered = false;
  const a = f.open([definition]); a.runner.enqueue(task, schedule);
  assert.equal((await a.runner.runNext())?.status, "deferred"); a.close();
  recovered = true; finishAllowed = true; f.advance(200);
  const b = f.open([definition]);
  assert.equal((await b.runner.runNext())?.status, "completed");
  assert.equal(b.db.prepare("SELECT count(*) n FROM effects").get()?.n, 2);
});

test("corrupt terminal state cannot claim completion without the saved steps", async t => {
  const f = fixture(t), app = f.open([workflow([save()])]);
  app.runner.enqueue(task, schedule);
  app.db.prepare("UPDATE small_hour_tasks SET status = 'completed', attempts = 1").run();
  assert.throws(() => app.runner.inspect(task), { code: "invalid_task" });
});

test("a malformed saved resolution cannot be presented as valid task state", async t => {
  const f = fixture(t), app = f.open([workflow([save()])]);
  app.runner.enqueue(task, schedule);
  app.db.prepare("UPDATE small_hour_tasks SET resolution_json = 'false'").run();
  assert.throws(() => app.runner.inspect(task), { code: "invalid_task" });
});

test("local SQL and its receipt roll back together when permission changes before commit", async t => {
  const f = fixture(t);
  let allowed = true;
  const definition = workflow([{ ...save(), execute(db, context) {
    const result = save().execute(db, context); allowed = false; return result;
  } }], { authorize: () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" } });
  const app = f.open([definition]); app.runner.enqueue(task, schedule);
  assert.equal((await app.runner.runNext())?.status, "rejected");
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  assert.equal(app.db.prepare("SELECT count(*) n FROM small_hour_operation_receipts").get()?.n, 0);
});

test("only rolled-back local failures use the app retry policy and saved attempt limit", async t => {
  const f = fixture(t);
  let effects = 0, retryCalls = 0;
  const definition = workflow([{ ...save(), execute(db, context) {
    effects++; save().execute(db, context); throw new Error("storage unavailable");
  } }], { retry: () => { retryCalls++; return { dueAt: 200, reason: "storage_unavailable" }; } });
  const app = f.open([definition]); app.runner.enqueue(task, { ...schedule, maxAttempts: 2 });
  assert.equal((await app.runner.runNext())?.status, "deferred");
  assert.equal(await app.runner.runNext(), undefined);
  f.advance(200);
  assert.equal((await app.runner.runNext())?.status, "failed");
  assert.equal(app.runner.inspect(task)?.reason, "attempt_limit");
  assert.equal(app.runner.inspect(task)?.attempts, 2);
  assert.equal(await app.runner.runNext(), undefined);
  assert.equal(effects, 2); assert.equal(retryCalls, 1);
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
});

test("a rolled-back batch failure does not invent uncertainty from its error class", async t => {
  const f = fixture(t);
  const failure = new AggregateError([new Error("first write rejected"), new Error("second write rejected")], "batch failed");
  const definition = workflow([{ ...save(), execute(db, context) {
    save().execute(db, context); throw failure;
  } }]);
  const app = f.open([definition]); app.runner.enqueue(task, schedule);
  const result = await app.runner.runNext();
  assert.equal(result?.status, "failed"); assert.equal(result?.error, failure);
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  assert.equal(app.db.prepare("SELECT count(*) n FROM small_hour_operation_receipts").get()?.n, 0);
});

test("older workers skip unknown versions and changed manifests cannot execute saved tasks", async t => {
  const f = fixture(t);
  const one = workflow([save()]), two = workflow([save("second")], { version: "2" });
  const old = f.open([one]), current = f.open([two]);
  current.runner.enqueue({ ...task, version: "2" }, schedule);
  assert.equal(await old.runner.runNext(), undefined);
  assert.equal((await current.runner.runNext())?.status, "completed");
  assert.throws(() => old.runner.enqueue(task, schedule), { code: "contract_conflict" });
  old.runner.enqueue({ ...task, id: "old" }, schedule);
  const changed = f.open([workflow([save("different")])]);
  await assert.rejects(changed.runner.runNext(), { code: "contract_conflict" });
  assert.equal(old.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  assert.equal(old.runner.inspect({ ...task, id: "old" })?.status, "queued");
});

test("a refused claim write cannot release execution", async t => {
  const f = fixture(t), app = f.open([workflow([save()])]);
  app.runner.enqueue(task, schedule);
  app.db.exec(`CREATE TRIGGER ignore_claim BEFORE UPDATE ON small_hour_tasks
    WHEN NEW.status = 'running' BEGIN SELECT RAISE(IGNORE); END`);
  await assert.rejects(app.runner.runNext(), { code: "claim_lost" });
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  assert.equal(app.runner.inspect(task)?.status, "queued");
});

test("worker abort during an external call preserves uncertainty and does not run the task retry policy", async t => {
  const f = fixture(t), controller = new AbortController();
  let retries = 0;
  const definition = workflow([{ id: "model", kind: "model", prepare: () => ({
    runtime: model({ name: "fixture", async complete() { controller.abort(); return new Promise(() => {}); } }),
    input: { agentId: "a", input: "work", allowedTools: [], signal: new AbortController().signal },
  }) }, save()], { retry: () => { retries++; return { dueAt: 200, reason: "retry" }; } });
  const app = f.open([definition]); app.runner.enqueue(task, schedule);
  const result = await app.runner.runNext({ signal: controller.signal });
  assert.equal(result?.status, "uncertain"); assert.equal(retries, 0);
  assert.equal(result?.steps[0].model?.report.modelCalls[0].status, "unknown");
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
});

test("permission and claim guards stop model tools before their effects", async t => {
  const f = fixture(t);
  let effects = 0, allowed = true;
  const runtime = new SmallHourRuntime({ provider: { name: "fixture", async complete() {
    allowed = false;
    return { content: [{ type: "tool_use", id: "write-1", name: "write", input: {} }], stopReason: "tool_use" };
  } }, persona: new StaticPersonaSource("Use the tool."), memory: new EmptyMemorySource(),
  tools: new ToolRegistry([{ name: "write", description: "Write", inputSchema: {}, execute: () => { effects++; return {}; } }]) });
  const app = f.open([workflow([{ id: "model", kind: "model", prepare: () => ({ runtime, input: { agentId: "a", input: "write", allowedTools: ["write"] } }) }],
    { authorize: () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" } })]);
  app.runner.enqueue(task, schedule);
  assert.equal((await app.runner.runNext())?.status, "rejected");
  assert.equal(effects, 0);
});

test("cancelling a recovered task keeps its later unknown model work in the concurrency scope", async t => {
  const f = fixture(t), entered = gate(), release = gate();
  const definition = workflow([save("first"), { id: "model", kind: "model", prepare: () => ({
    runtime: model({ name: "fixture", async complete() {
      entered.resolve(); await release.promise;
      return { content: [{ type: "text", text: "late" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: "work", allowedTools: [] },
  }) }, save("second")]);
  const a = f.open([definition]), b = f.open([definition]);
  a.runner.enqueue(task, schedule);
  const pending = a.runner.runNext();
  await entered.promise;
  b.runner.cancel(task, "owner_cancelled"); f.advance(201);
  try {
    const result = await b.runner.runNext();
    assert.equal(result?.status, "uncertain");
    assert.equal(result?.cancellationReason, "owner_cancelled");
    b.runner.enqueue({ ...task, id: "job-2" }, schedule);
    assert.equal(await b.runner.runNext(), undefined);
  } finally { release.resolve(); }
  await assert.rejects(pending, { code: "claim_lost" });
  assert.equal(b.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
});

test("a local step cannot commit after its claim expires", async t => {
  const f = fixture(t);
  const definition = workflow([{ ...save(), execute(db, context) {
    const result = save().execute(db, context); f.advance(201); return result;
  } }]);
  const app = f.open([definition]); app.runner.enqueue(task, schedule);
  await assert.rejects(app.runner.runNext(), { code: "claim_lost" });
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  assert.equal(app.db.prepare("SELECT count(*) n FROM small_hour_operation_receipts").get()?.n, 0);
});

test("model output rejection remains rejected and cannot be relabelled as completed", async t => {
  const f = fixture(t);
  const runtime = new SmallHourRuntime({ persona: new StaticPersonaSource("Use facts."), memory: new EmptyMemorySource(),
    provider: { name: "fixture", async complete() { return { content: [{ type: "text", text: "unsupported" }], stopReason: "end_turn" }; } },
    outputPolicy: { apply: () => ({ accepted: false, output: "", issues: ["unsupported_fact"] }) } });
  const app = f.open([workflow([{ id: "model", kind: "model", prepare: () => ({ runtime, input: { agentId: "a", input: "work", allowedTools: [] } }) }])]);
  app.runner.enqueue(task, schedule);
  const result = await app.runner.runNext();
  assert.equal(result?.status, "rejected"); assert.equal(result?.reason, "model_output_rejected");
  assert.equal(result?.steps[0].model?.status, "completed");
  app.db.prepare("UPDATE small_hour_tasks SET status = 'completed', reason = NULL").run();
  assert.throws(() => app.runner.inspect(task), { code: "invalid_task" });
});

test("attempt exhaustion retains an interrupted model call and its occupied scope", async t => {
  const f = fixture(t), entered = gate(), release = gate();
  let calls = 0;
  const definition = workflow([{ id: "model", kind: "model", prepare: () => ({
    runtime: model({ name: "fixture", async complete() {
      calls++; entered.resolve(); await release.promise;
      return { content: [{ type: "text", text: "late" }], stopReason: "end_turn" };
    } }), input: { agentId: "a", input: "work", allowedTools: [] },
  }) }]);
  const a = f.open([definition]), b = f.open([definition]);
  a.runner.enqueue(task, { ...schedule, maxAttempts: 1 });
  const pending = a.runner.runNext(); await entered.promise; f.advance(201);
  try {
    const recovered = await b.runner.runNext();
    assert.equal(recovered?.status, "uncertain"); assert.equal(recovered?.reason, "attempt_limit");
    assert.equal(recovered?.steps[0].model?.report.modelCalls[0].status, "unknown");
    b.runner.enqueue({ ...task, id: "job-2" }, schedule);
    assert.equal(await b.runner.runNext(), undefined);
  } finally { release.resolve(); }
  await assert.rejects(pending, { code: "claim_lost" }); assert.equal(calls, 1);
});

function worker(path: string, stage: string) {
  const script = fileURLToPath(new URL("./fixtures/task-worker.ts", import.meta.url));
  return spawn(process.execPath, ["--import", "tsx", script, path, stage], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}
for (const stage of ["after-local", "in-model", "after-model"]) {
  test(`process death ${stage} retains committed effects and resumes only established work`, { timeout: 10000 }, async t => {
    const f = fixture(t), child = worker(f.path, stage);
    let errors = ""; child.stderr?.setEncoding("utf8").on("data", value => { errors += value; });
    t.after(() => child.kill("SIGKILL"));
    const [code, signal] = await once(child, "close");
    assert.equal(signal, "SIGKILL", `worker failed: ${code}: ${errors}`);
    const app = f.open([]);
    const recovered = new SqliteTaskRunner(app.db, [workerWorkflow(app.db)], { leaseMs: 100, now: () => 201 });
    const result = await recovered.runNext();
    assert.equal(result?.status, stage === "in-model" ? "uncertain" : "completed");
    assert.equal(app.db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, 1);
    assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, stage === "in-model" ? 1 : 2);
    if (stage !== "in-model") assert.deepEqual(result?.steps[2].result, { eventId: "event-7", output: "item-7" });
  });
}

test("independent processes cannot execute the same claimed task", { timeout: 10000 }, async t => {
  const f = fixture(t), first = worker(f.path, "race");
  t.after(() => first.kill("SIGKILL"));
  assert.deepEqual(await once(first, "message"), ["entered", undefined]);
  const firstClose = once(first, "close"), second = worker(f.path, "race");
  t.after(() => second.kill("SIGKILL"));
  const secondClose = once(second, "close");
  try {
    const [result] = await once(second, "message");
    assert.deepEqual(result, { status: "idle" });
    assert.equal((await secondClose)[0], 0);
  } finally { first.send("release"); }
  assert.equal((await firstClose)[0], 0);
  const app = f.open([]);
  assert.equal(app.db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, 1);
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 2);
  assert.equal(app.runner.inspect(workerTask)?.status, "completed");
});
