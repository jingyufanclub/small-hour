import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelCallContext, type ModelProvider } from "../src/index.js";
import { SqliteModelCallStore, SqliteModelStepStore, SqliteOperationStore, SqliteTaskRunner,
  type TaskWorkflow } from "../src/durable/sqlite.js";

const request = { scope: "app", id: "work", kind: "compose", version: "1", input: { item: "item-7" } };
const timing = { concurrencyScope: "app", dueAt: 100, maxAttempts: 4 };
const input = { agentId: "app", input: "Use item-7.", allowedTools: [] };
const recovery = { sideEffectFree: true as const, maxAttempts: 3, maxModelCalls: 3 };
const response = { content: [{ type: "text" as const, text: "item-7" }], stopReason: "end_turn" as const };
const call: ModelCallContext = { agentId: "app", turnId: "turn", callId: "call", provider: "fixture", model: "fixture",
  attempt: 1, hop: 0, maxTokens: 100, input: "Use item-7.", signal: new AbortController().signal };

function stamps(value: unknown) {
  assert.ok(value && typeof value === "object");
  const record = value as Record<string, unknown>;
  return { createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function runtime(provider: ModelProvider) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use supplied facts."),
    memory: new EmptyMemorySource(), retry: { attempts: 1 } });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-lifecycle-")), connections = new Set<DatabaseSync>();
  const path = join(directory, "app.sqlite");
  let time = 100;
  const clock = { now: () => time };
  const open = (forbidden: string[] = []) => {
    const db = new DatabaseSync(path); connections.add(db);
    db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS effects (value TEXT NOT NULL)");
    db.setAuthorizer((_action, table) => table !== null && forbidden.includes(table) ? constants.SQLITE_DENY : constants.SQLITE_OK);
    return db;
  };
  const close = (db: DatabaseSync) => { db.close(); connections.delete(db); };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, close, clock, advance: (value: number) => { time = value; } };
}

test("local and model work survives reopen and authorized recovery with delivery storage denied", async t => {
  const f = fixture(t); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() {
    calls++; return { ...response, stopReason: calls === 1 ? "max_tokens" : "end_turn" };
  } };
  const workflow: TaskWorkflow<DatabaseSync> = { kind: request.kind, version: request.version,
    authorize: () => ({ status: "allow" }), steps: [
      { id: "prepare", kind: "local", parseResult: value => value, execute(db) {
        db.prepare("INSERT INTO effects VALUES ('prepared')").run(); return { item: "item-7" };
      } },
      { id: "compose", kind: "model", recovery, prepare: () => ({ runtime: runtime(provider), input }) },
      { id: "stage", kind: "local", parseResult: value => value, execute(db) {
        db.prepare("INSERT INTO effects VALUES ('staged')").run(); return "staged";
      } },
    ] };
  let db = f.open(["small_hour_deliveries"]);
  let runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock });
  runner.initialize(); runner.enqueue(request, timing);
  const failed = (await runner.runNext())!;
  assert.equal(failed.status, "uncertain");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM effects").get()?.n, 1);
  const model = failed.steps[1].model!;
  f.close(db); f.advance(200);
  db = f.open(["small_hour_deliveries"]);
  runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock }); runner.initialize();
  assert.equal(runner.inspect(request)?.status, "uncertain");
  const result = (await runner.retryModel(request, { stepId: "compose", action: "retry", checkpoint: model.checkpoint,
    reason: "pure model recovery authorized", evidence: { policy: "current" } }))!;
  assert.equal(result.status, "completed"); assert.equal(calls, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM effects").get()?.n, 2);
  const completed = runner.inspect(request);
  f.advance(300); runner.initialize();
  assert.deepEqual(runner.enqueue(request, timing), completed);
  assert.equal(await runner.runNext(), undefined);
  assert.equal(calls, 2);
});

for (const kind of ["local", "model", "delivery"] as const) {
  test(`${kind} workflows use only their own evidence store across restart`, async t => {
    const f = fixture(t); let effects = 0;
    const step = kind === "local"
      ? { id: "step", kind, parseResult: (value: unknown) => value, execute(db: DatabaseSync) {
        effects++; db.prepare("INSERT INTO effects VALUES ('saved')").run(); return "saved";
      } }
      : kind === "model" ? { id: "step", kind, prepare: () => ({ input, runtime: runtime({ name: "fixture", async complete() {
        effects++; return response;
      } }) }) }
      : { id: "step", kind, sink: { idempotency: "key" as const, async send() {
        effects++; return { status: "accepted" as const, receipt: { id: "remote-7", evidence: "accepted" } };
      } } };
    const required = { local: "small_hour_operation_receipts", model: "small_hour_model_steps", delivery: "small_hour_deliveries" };
    const forbidden = Object.entries(required).filter(([key]) => key !== kind).map(([, table]) => table);
    const workflow: TaskWorkflow<DatabaseSync> = { kind: request.kind, version: request.version, steps: [step], authorize: () => ({ status: "allow" }) };
    let db = f.open(forbidden), runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock });
    runner.initialize(); runner.enqueue(request, timing);
    assert.equal((await runner.runNext())?.status, "completed");
    f.close(db); db = f.open(forbidden);
    runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock }); runner.initialize();
    assert.equal(runner.inspect(request)?.status, "completed");
    assert.equal(runner.enqueue(request, timing).status, "completed");
    assert.equal(await runner.runNext(), undefined); assert.equal(effects, 1);
  });
}

test("operation receipt timestamps preserve atomic creation and completion through replay and rollback", t => {
  const f = fixture(t), db = f.open(), store = new SqliteOperationStore(db, f.clock); store.initialize();
  const operation = { parseResult: (value: unknown) => value, execute(connection: DatabaseSync) {
    connection.prepare("INSERT INTO effects VALUES ('committed')").run(); return { id: "item-7" };
  } };
  const first = store.commit(request, { ...operation, execute(connection) { const result = operation.execute(connection); f.advance(150); return result; } });
  assert.deepEqual(stamps(first.receipt), { createdAt: 100, updatedAt: 150 });
  f.advance(200); store.initialize();
  assert.deepEqual(store.find(request, value => value), first.receipt);
  assert.deepEqual(store.commit(request, operation), { ...first, replayed: true });
  db.exec("BEGIN"); store.commit({ ...request, id: "rolled-back" }, operation); db.exec("ROLLBACK");
  assert.equal(store.find({ ...request, id: "rolled-back" }, value => value), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM effects").get()?.n, 1);
});

test("model lifecycle times survive reopen and completed replay without another provider call", async t => {
  const f = fixture(t); let calls = 0, db = f.open(), store = new SqliteModelStepStore(db, f.clock); store.initialize();
  const model = runtime({ name: "fixture", async complete() { calls++; f.advance(160); return response; } });
  const first = await store.run(request, model, input);
  assert.deepEqual(stamps(first), { createdAt: 100, updatedAt: 160 });
  assert.deepEqual(stamps(store.inspect(request)), { createdAt: 100, updatedAt: 160 });
  f.close(db); f.advance(200); db = f.open(); store = new SqliteModelStepStore(db, f.clock); store.initialize();
  assert.deepEqual(await store.run(request, model, input), { ...first, replayed: true });
  assert.equal(calls, 1);
});

test("task times distinguish submission, execution and no-op cancellation from due and lease times", async t => {
  const f = fixture(t), db = f.open();
  const workflow: TaskWorkflow<DatabaseSync> = { kind: request.kind, version: request.version, authorize: () => ({ status: "allow" }),
    steps: [{ id: "save", kind: "local", parseResult: value => value, execute: () => { f.advance(150); return "saved"; } }] };
  const runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock }); runner.initialize();
  assert.deepEqual(stamps(runner.enqueue(request, { ...timing, dueAt: 120 })), { createdAt: 100, updatedAt: 100 });
  f.advance(110); assert.equal(await runner.runNext(), undefined);
  f.advance(120); const completed = (await runner.runNext())!;
  assert.deepEqual(stamps(completed), { createdAt: 100, updatedAt: 150 });
  assert.equal(completed.dueAt, 120); assert.equal(completed.leaseUntil, null);
  const local = completed.steps[0]; assert.ok(local.kind === "local" && local.status === "completed");
  assert.deepEqual(stamps(local.receipt), { createdAt: 120, updatedAt: 150 });
  f.advance(200); assert.deepEqual(runner.cancel(request, "too late"), completed);
  assert.deepEqual(runner.enqueue(request, { ...timing, dueAt: 120 }), completed);
});

test("spending timestamps follow admission and evidence while one charge covers all scopes", t => {
  const f = fixture(t), db = f.open(), spend = new SqliteModelCallStore(db, f.clock); spend.initialize();
  const hooks = spend.hooks({ quote: () => ({ amount: 10, pricing: null,
    scopes: [{ scope: "account", limit: 20 }, { scope: "service", limit: 20 }] }), charge: () => 3 });
  assert.equal(hooks.admit!(call), true);
  assert.deepEqual(stamps(spend.inspect(call.callId)), { createdAt: 100, updatedAt: 100 });
  const unknown = { callId: call.callId, provider: call.provider, attempt: 1, hop: 0, status: "unknown" as const, accounting: "unrecorded" as const };
  f.advance(130); hooks.record!(unknown, call);
  assert.deepEqual(stamps(spend.inspect(call.callId)), { createdAt: 100, updatedAt: 130 });
  f.advance(160); hooks.record!(unknown, call);
  assert.deepEqual(stamps(spend.inspect(call.callId)), { createdAt: 100, updatedAt: 130 });
  const decision = { status: "accepted" as const, amount: 4, evidence: "invoice-7" };
  const settled = spend.reconcile(call.callId, decision);
  assert.deepEqual(stamps(settled), { createdAt: 100, updatedAt: 160 });
  f.advance(200); spend.initialize(); assert.deepEqual(spend.reconcile(call.callId, decision), settled);
  assert.equal(spend.inspectBudget("account").totalAmount, 4); assert.equal(spend.inspectBudget("service").totalAmount, 4);
  assert.deepEqual(db.prepare("SELECT MIN(created_at) createdAt, MAX(updated_at) updatedAt FROM model_call_scopes").get(),
    Object.assign(Object.create(null), { createdAt: 100, updatedAt: 100 }));
});

test("delivery evidence timestamps advance only when new evidence is retained", async t => {
  const f = fixture(t), db = f.open();
  const workflow: TaskWorkflow<DatabaseSync> = { kind: request.kind, version: request.version, authorize: () => ({ status: "allow" }),
    steps: [{ id: "send", kind: "delivery", sink: { idempotency: "key", async send() {
      f.advance(150); return { status: "uncertain", reason: "connection_lost" };
    } } }] };
  const runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock }); runner.initialize(); runner.enqueue(request, timing);
  const started = (await runner.runNext())!.steps[0].delivery!;
  assert.deepEqual(stamps(started), { createdAt: 100, updatedAt: 150 });
  const attemptId = started.attempts[0].id;
  f.advance(155);
  assert.deepEqual(runner.recordDeliveryOutcome(request, { attemptId,
    outcome: { status: "uncertain", reason: "connection_lost" } }).steps[0].delivery, started);
  f.advance(160); const outcome = { status: "accepted" as const, receipt: { id: "remote-7", evidence: "receipt" } };
  const accepted = runner.recordDeliveryOutcome(request, { attemptId, outcome }).steps[0].delivery!;
  assert.deepEqual(stamps(accepted), { createdAt: 100, updatedAt: 160 });
  f.advance(180); assert.deepEqual(runner.recordDeliveryOutcome(request, { attemptId, outcome }).steps[0].delivery, accepted);
  assert.deepEqual(runner.recordDeliveryOutcome(request, { attemptId, outcome: { status: "uncertain", reason: "late_timeout" } }).steps[0].delivery, accepted);
  const confirmed = runner.recordDeliveryOutcome(request, { attemptId,
    outcome: { ...outcome, status: "confirmed", confirmation: { level: "device", evidence: "ack-7" } } }).steps[0].delivery!;
  assert.deepEqual(stamps(confirmed), { createdAt: 100, updatedAt: 180 });
});

test("repeated cancellation does not change the time of a running task's first cancellation request", async t => {
  const f = fixture(t), db = f.open();
  let markStarted!: () => void, finish!: (value: typeof response) => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const output = new Promise<typeof response>(resolve => { finish = resolve; });
  const workflow: TaskWorkflow<DatabaseSync> = { kind: request.kind, version: request.version, authorize: () => ({ status: "allow" }),
    steps: [{ id: "compose", kind: "model", prepare: () => ({ input, runtime: runtime({ name: "fixture", async complete() {
      markStarted(); return output;
    } }) }) }] };
  const runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, ...f.clock }); runner.initialize(); runner.enqueue(request, timing);
  const pending = runner.runNext(); await started;
  f.advance(130); const cancelled = runner.cancel(request, "requested");
  assert.equal(cancelled.status, "running"); assert.equal(cancelled.cancellationReason, "requested");
  assert.deepEqual(stamps(cancelled), { createdAt: 100, updatedAt: 130 });
  f.advance(150); assert.deepEqual(runner.cancel(request, "duplicate request"), cancelled);
  finish(response); await pending;
});

test("a backward clock cannot move stored evidence earlier or reset admission time", t => {
  const f = fixture(t), db = f.open(), spend = new SqliteModelCallStore(db, f.clock); spend.initialize();
  const hooks = spend.hooks({ quote: () => ({ amount: 10, pricing: null, scope: "account", limit: 20 }), charge: () => 3 });
  hooks.admit!(call); f.advance(80);
  const settled = spend.reconcile(call.callId, { status: "accepted", amount: 3, evidence: "invoice-7" });
  assert.deepEqual(stamps(settled), { createdAt: 100, updatedAt: 100 });
  assert.equal(settled.chargedAmount, 3);
});

const legacySql = readFileSync(new URL("./fixtures/durable-legacy.sql", import.meta.url), "utf8");

test("published records upgrade with unknown history and retain replay and pending work", async t => {
  const f = fixture(t), db = f.open(); db.exec("DROP TABLE effects"); db.exec(legacySql); f.advance(1000);
  const operations = new SqliteOperationStore(db, f.clock), models = new SqliteModelStepStore(db, f.clock),
    spending = new SqliteModelCallStore(db, f.clock);
  operations.initialize(); models.initialize();
  assert.throws(() => spending.initialize(), { code: "invalid_record" });
  const localRequest = { ...request, id: "local" };
  const local = operations.commit(localRequest, { execute() { assert.fail("A saved local effect must not run again"); }, parseResult: value => value });
  assert.equal(local.replayed, true); assert.equal(local.receipt.result, "saved");
  assert.deepEqual(stamps(local.receipt), { createdAt: null, updatedAt: null });
  const saved = await models.run({ ...request, id: "model" }, runtime({ name: "fixture", async complete() {
    assert.fail("A saved model result must not buy another call");
  } }), input);
  assert.equal(saved.replayed, true); assert.equal(saved.result.status, "reply");
  assert.deepEqual(stamps(saved), { createdAt: null, updatedAt: null });
  assert.equal(models.inspect({ ...request, id: "model" })!.checkpoint,
    "sha256:91b7788f8e850053e5ef573496c9921e1ec051cfcbeaa4a27c67d0b4a53e1b7d");
  const recoverRequest = { ...request, id: "recover" }, unfinished = models.inspect(recoverRequest)!;
  assert.equal(unfinished.status, "failed"); assert.deepEqual(stamps(unfinished), { createdAt: null, updatedAt: null });
  assert.equal(unfinished.checkpoint, "sha256:b54676392049593568952c8b4dcd7dd13928ab58cc80947c8f57f1fa1b50d06a");
  const recovered = await models.recover(recoverRequest, runtime({ name: "fixture", async complete() { return response; } }), input,
    { action: "retry", checkpoint: unfinished.checkpoint, reason: "pure recovery authorized", evidence: "current-policy" });
  assert.deepEqual(stamps(recovered), { createdAt: null, updatedAt: 1000 });
  const workflows: TaskWorkflow<DatabaseSync>[] = [
    { kind: "compose", version: "1", authorize: () => ({ status: "allow" }), steps: [
      { id: "save", kind: "local", parseResult: value => value, execute(connection) {
        connection.prepare("INSERT INTO effects VALUES ('task')").run(); return "task";
      } },
    ] },
    { kind: "deliver", version: "1", authorize: () => ({ status: "allow" }), steps: [
      { id: "send", kind: "delivery", sink: { idempotency: "key", async send() { assert.fail("An accepted delivery must not be sent again"); } } },
    ] },
  ];
  const runner = new SqliteTaskRunner(db, workflows, { leaseMs: 100, ...f.clock }); runner.initialize();
  const completed = runner.inspect({ ...request, id: "completed-task" })!;
  assert.equal(completed.status, "completed"); assert.deepEqual(stamps(completed), { createdAt: null, updatedAt: null });
  const delivered = runner.inspect({ ...request, id: "delivery-task" })!;
  assert.equal(delivered.status, "completed");
  assert.deepEqual(stamps(delivered.steps[0].delivery), { createdAt: null, updatedAt: null });
  assert.equal((await runner.runNext())?.id, "queued-task");
  assert.deepEqual(stamps(runner.inspect({ ...request, id: "queued-task" })), { createdAt: null, updatedAt: 1000 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM effects").get()?.n, 3);
  f.advance(1200); runner.initialize(); models.initialize();
  assert.deepEqual(runner.inspect({ ...request, id: "completed-task" }), completed);
  assert.deepEqual(runner.inspect({ ...request, id: "delivery-task" }), delivered);
});

test("a failed metadata migration rolls back its schema and preserves the original receipt", t => {
  const f = fixture(t), db = f.open(); db.exec("DROP TABLE effects"); db.exec(legacySql);
  const before = db.prepare("SELECT * FROM small_hour_operation_receipts WHERE scope = 'app' AND id = 'local'").get();
  let alters = 0;
  db.setAuthorizer(action => action === constants.SQLITE_ALTER_TABLE && ++alters === 2 ? constants.SQLITE_DENY : constants.SQLITE_OK);
  const store = new SqliteOperationStore(db, f.clock);
  assert.throws(() => store.initialize(), /not authorized/);
  db.setAuthorizer(null);
  assert.deepEqual(db.prepare("SELECT * FROM small_hour_operation_receipts WHERE scope = 'app' AND id = 'local'").get(), before);
  store.initialize();
  const replay = store.commit({ ...request, id: "local" }, { execute() { assert.fail("Migration failure cannot repeat the effect"); }, parseResult: value => value });
  assert.equal(replay.replayed, true); assert.equal(replay.receipt.result, "saved");
  assert.deepEqual(stamps(replay.receipt), { createdAt: null, updatedAt: null });
});

test("invalid persisted lifecycle times prevent completed receipt replay", t => {
  const f = fixture(t), db = f.open(), store = new SqliteOperationStore(db, f.clock); store.initialize();
  store.commit(request, { execute: () => "saved", parseResult: value => value });
  db.exec("PRAGMA ignore_check_constraints = ON; UPDATE small_hour_operation_receipts SET updated_at = -1");
  assert.throws(() => store.find(request, value => value), { code: "invalid_receipt" });
  assert.throws(() => store.commit(request, { execute() { assert.fail("Invalid evidence cannot authorize re-execution"); }, parseResult: value => value }),
    { code: "invalid_receipt" });
});
