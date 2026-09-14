import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource } from "../src/index.js";
import { SqliteTaskRunner, type DeliverySink, type TaskWorkflow, type TaskState } from "../src/durable/sqlite.js";

const product = { scope: "account:a", id: "output:7", kind: "publish-result", version: "1", input: {
  destination: "inbox:4", result: { selectedId: "item-7", text: "Saved output", attachmentId: "asset-2" },
} };
const schedule = { concurrencyScope: "inbox:4", dueAt: 100, maxAttempts: 4 };
const accepted = { status: "accepted" as const, receipt: { id: "remote-7", evidence: { provider: "accepted" } } };
const deferred = { status: "deferred" as const, reason: "unavailable_before_send", dueAt: 200, evidence: { requestStarted: false } };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function delivery(state: TaskState | undefined) {
  assert.ok(state); const step = state.steps[0]; assert.equal(step.kind, "delivery");
  if (step.kind !== "delivery") throw new Error("Expected delivery evidence");
  return step.delivery;
}
function workflow(sink: DeliverySink, authorize: TaskWorkflow<DatabaseSync>["authorize"] = () => ({ status: "allow" })): TaskWorkflow<DatabaseSync> {
  return { kind: product.kind, version: product.version, steps: [{ id: "handoff", kind: "delivery", sink }], authorize };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-delivery-")), path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>(); let now = 100;
  const open = (workflows: TaskWorkflow<DatabaseSync>[]) => {
    const db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout = 5000"); connections.add(db);
    const runner = new SqliteTaskRunner(db, workflows, { leaseMs: 100, now: () => now }); runner.initialize();
    return { db, runner, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, path, advance: (time: number) => { now = time; } };
}

test("output staging shares the local effect transaction and dispatch requires its commit", async t => {
  const f = fixture(t); let sends = 0;
  const definition = workflow({ idempotency: "none", async send(saved) { sends++; assert.deepEqual(saved, product); return accepted; } });
  const a = f.open([definition]), b = f.open([definition]);
  a.db.exec("CREATE TABLE effects (id TEXT PRIMARY KEY); BEGIN IMMEDIATE");
  a.db.prepare("INSERT INTO effects VALUES (?)").run("effect-7");
  a.runner.enqueue(product, schedule);
  assert.equal(b.runner.inspect(product), undefined);
  await assert.rejects(a.runner.runNext(), /transaction/i);
  assert.equal(sends, 0); a.db.exec("ROLLBACK");
  assert.equal(a.db.prepare("SELECT count(*) n FROM effects").get()?.n, 0);
  assert.equal(await b.runner.runNext(), undefined);
  a.db.exec("BEGIN IMMEDIATE"); a.db.prepare("INSERT INTO effects VALUES (?)").run("effect-7");
  a.runner.enqueue(product, schedule); a.db.exec("COMMIT"); a.close();
  assert.equal(delivery(b.runner.inspect(product)).status, "queued");
  assert.deepEqual(b.runner.inspect(product)?.steps[0].request, product);
  assert.equal((await b.runner.runNext())?.status, "completed");
  assert.equal(delivery(b.runner.inspect(product)).status, "accepted");
  assert.equal(b.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  assert.equal(sends, 1); assert.equal(await b.runner.runNext(), undefined);
});

test("a saved model result stages one output with its local receipt and transport recovery repeats neither", async t => {
  const f = fixture(t); let models = 0, sends = 0;
  const runtime = new SmallHourRuntime({ persona: new StaticPersonaSource("Select a supplied ID."), memory: new EmptyMemorySource(),
    provider: { name: "fixture", async complete() { models++; return { content: [{ type: "text", text: "item-7" }], stopReason: "end_turn" }; } } });
  const sink = workflow({ idempotency: "none", async send(saved) { sends++; assert.deepEqual(saved, product); return sends === 1 ? deferred : accepted; } });
  const creation: TaskWorkflow<DatabaseSync> = { kind: "create-output", version: "1", authorize: () => ({ status: "allow" }), steps: [
    { id: "select", kind: "model", prepare: () => ({ runtime, input: { agentId: "a", input: "item-7, item-2", allowedTools: [] } }) },
    { id: "save", kind: "local", parseResult: value => value, execute(db, context) {
      assert.equal((context.results.select as { output: string }).output, "item-7");
      db.prepare("INSERT INTO effects VALUES (?)").run("effect-7"); app.runner.enqueue(product, schedule); return { outputId: product.id };
    } },
  ] };
  const app = f.open([creation, sink]); app.db.exec("CREATE TABLE effects (id TEXT PRIMARY KEY)");
  app.runner.enqueue({ ...product, id: "creation:7", kind: creation.kind }, { ...schedule, concurrencyScope: "creation:7" });
  assert.equal((await app.runner.runNext())?.status, "completed");
  assert.equal((await app.runner.runNext())?.status, "deferred"); app.close(); f.advance(200);
  const restarted = f.open([creation, sink]); assert.equal((await restarted.runner.runNext())?.status, "completed");
  assert.equal(models, 1); assert.equal(sends, 2); assert.equal(restarted.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  assert.equal(restarted.db.prepare("SELECT count(*) n FROM small_hour_operation_receipts").get()?.n, 1);
});

test("duplicate dispatch holds one claim while the sink is in flight", async t => {
  const f = fixture(t), entered = gate(), release = gate(); let sends = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; entered.resolve(); await release.promise; return accepted; } });
  const a = f.open([definition]), b = f.open([definition]); a.runner.enqueue(product, schedule);
  const pending = a.runner.runNext(); await entered.promise;
  try { assert.equal(await b.runner.runNext(), undefined); assert.equal(delivery(b.runner.inspect(product)).status, "uncertain"); }
  finally { release.resolve(); }
  assert.equal((await pending)?.status, "completed"); assert.equal(sends, 1);
});

test("lost response after acceptance retries only with the same product and sink idempotency key", async t => {
  const f = fixture(t); const keys: string[] = [], remote = new Map<string, unknown>(); let calls = 0;
  const definition = workflow({ idempotency: "key", async send(saved, context) {
    calls++; keys.push(context.idempotencyKey); assert.deepEqual(saved, product);
    remote.set(context.idempotencyKey, saved); if (calls === 1) throw new Error("response lost"); return accepted;
  } });
  const a = f.open([definition]); a.runner.enqueue(product, schedule);
  assert.equal((await a.runner.runNext())?.status, "uncertain");
  assert.equal(await a.runner.runNext(), undefined); a.close();
  const b = f.open([definition]); assert.equal((await b.runner.retryDelivery(product))?.status, "completed");
  assert.equal(remote.size, 1); assert.equal(calls, 2); assert.equal(new Set(keys).size, 1);
  assert.equal(delivery(b.runner.inspect(product)).status, "accepted");
  assert.equal(await b.runner.runNext(), undefined);
});

test("an ambiguous non-idempotent send holds its scope and cannot be blindly retried", async t => {
  const f = fixture(t); let calls = 0;
  const definition = workflow({ idempotency: "none", async send() { calls++; throw new Error("connection closed after upload"); } });
  const app = f.open([definition]); app.runner.enqueue(product, schedule);
  assert.equal((await app.runner.runNext())?.status, "uncertain");
  app.runner.enqueue({ ...product, id: "output:8" }, schedule);
  assert.equal(await app.runner.runNext(), undefined);
  assert.equal((await app.runner.retryDelivery(product))?.status, "uncertain");
  assert.equal(app.runner.inspect(product)?.attempts, 1); assert.equal(calls, 1);
});

test("reconciliation recovers remote acceptance without another send", async t => {
  const f = fixture(t); let sends = 0, checks = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; throw new Error("receipt lost"); },
    async reconcile(saved, context) { checks++; assert.deepEqual(saved, product); assert.ok(context.idempotencyKey); return accepted; } });
  const app = f.open([definition]); app.runner.enqueue(product, schedule); await app.runner.runNext();
  assert.equal((await app.runner.retryDelivery(product))?.status, "completed");
  assert.equal(sends, 1); assert.equal(checks, 1); assert.equal(delivery(app.runner.inspect(product)).status, "accepted");
});

test("uncertain reconciliation stays blocked and definitive non-acceptance permits a later authorized attempt", async t => {
  const f = fixture(t); let sends = 0, certain = false;
  const definition = workflow({ idempotency: "none", async send() { sends++; if (sends === 1) throw new Error("disconnected"); return accepted; },
    async reconcile() { return certain ? deferred : { status: "uncertain", reason: "provider_still_processing" }; } });
  const app = f.open([definition]); app.runner.enqueue(product, schedule); await app.runner.runNext();
  assert.equal((await app.runner.retryDelivery(product))?.status, "uncertain"); assert.equal(sends, 1);
  certain = true; assert.equal((await app.runner.retryDelivery(product))?.status, "deferred"); assert.equal(sends, 1);
  f.advance(200); assert.equal((await app.runner.runNext())?.status, "completed"); assert.equal(sends, 2);
});

test("revoked permission rejects a queued output without sending it", async t => {
  const f = fixture(t); let allowed = true, sends = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; return accepted; } },
    () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" });
  const app = f.open([definition]); app.runner.enqueue(product, schedule); allowed = false;
  const result = await app.runner.runNext(); assert.equal(result?.status, "rejected");
  assert.equal(delivery(result).status, "rejected"); assert.equal(sends, 0);
});

test("revocation during an ambiguous send cannot erase uncertainty or authorize a resend", async t => {
  const f = fixture(t); let allowed = true, sends = 0;
  const definition = workflow({ idempotency: "key", async send() { sends++; allowed = false; throw new Error("receipt lost"); } },
    () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" });
  const app = f.open([definition]); app.runner.enqueue(product, schedule); await app.runner.runNext();
  assert.equal((await app.runner.retryDelivery(product))?.status, "uncertain"); assert.equal(sends, 1);
  assert.equal(delivery(app.runner.inspect(product)).status, "uncertain");
});

test("late receipts survive claim loss but cannot give the stale worker ownership", async t => {
  const f = fixture(t), entered = gate(), release = gate(); let sends = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; entered.resolve(); await release.promise; return accepted; } });
  const a = f.open([definition]), b = f.open([definition]); a.runner.enqueue(product, schedule);
  const pending = a.runner.runNext(); await entered.promise; f.advance(201);
  try { assert.equal((await b.runner.runNext())?.status, "uncertain"); }
  finally { release.resolve(); }
  await assert.rejects(pending, { code: "claim_lost" });
  assert.equal(delivery(b.runner.inspect(product)).status, "accepted");
  assert.equal((await b.runner.retryDelivery(product))?.status, "completed"); assert.equal(sends, 1);
});

test("cancellation during send preserves acceptance without pretending to undo it", async t => {
  const f = fixture(t);
  const definition = workflow({ idempotency: "none", async send() { other.runner.cancel(product, "owner_cancelled"); return accepted; } });
  const app = f.open([definition]), other = f.open([definition]); app.runner.enqueue(product, schedule);
  const result = await app.runner.runNext(); assert.equal(result?.status, "cancelled"); assert.equal(delivery(result).status, "accepted");
  assert.equal(await other.runner.runNext(), undefined);
});

test("confirmation needs receipt-bound evidence and cannot be inferred from provider acceptance", async t => {
  const f = fixture(t), app = f.open([workflow({ idempotency: "none", async send() { return accepted; } })]);
  app.runner.enqueue(product, schedule); await app.runner.runNext();
  const state = delivery(app.runner.inspect(product)); assert.equal(state.status, "accepted");
  const attemptId = state.attempts[0].id;
  assert.throws(() => app.runner.recordDeliveryOutcome(product, { attemptId: "unrelated", outcome: accepted }));
  assert.throws(() => app.runner.recordDeliveryOutcome(product, { attemptId, outcome: { ...accepted, receipt: { ...accepted.receipt, id: "different" } } }));
  const confirmed = { ...accepted, status: "confirmed" as const, confirmation: { level: "device" as const, evidence: { deviceReceipt: "read-7" } } };
  app.runner.recordDeliveryOutcome(product, { attemptId, outcome: confirmed });
  app.runner.recordDeliveryOutcome(product, { attemptId, outcome: confirmed });
  assert.equal(delivery(app.runner.inspect(product)).status, "confirmed");
  assert.throws(() => app.runner.recordDeliveryOutcome(product, { attemptId, outcome: { ...confirmed, confirmation: { level: "user", evidence: undefined } } }));
});

test("staged identities reject changed payloads and changed recovery contracts", async t => {
  const f = fixture(t), definition = workflow({ idempotency: "none", async send() { return accepted; } });
  const a = f.open([definition]); a.runner.enqueue(product, schedule);
  assert.throws(() => a.runner.enqueue({ ...product, input: { destination: "other" } }, schedule), { code: "contract_conflict" });
  const b = f.open([workflow({ idempotency: "key", async send() { throw new Error("must not run"); } })]);
  await assert.rejects(b.runner.runNext(), { code: "contract_conflict" });
  assert.equal(a.runner.inspect(product)?.attempts, 0);
});

test("delivery tasks cannot contain model or local steps that a transport retry might execute", t => {
  const f = fixture(t), definition = workflow({ idempotency: "none", async send() { return accepted; } });
  assert.throws(() => f.open([{ ...definition, steps: [{ id: "create", kind: "local", execute: () => null, parseResult: v => v }, ...definition.steps] }]));
});

test("ignored attempt writes prevent a remote call and missing evidence cannot claim completion", async t => {
  const f = fixture(t); let calls = 0;
  const app = f.open([workflow({ idempotency: "none", async send() { calls++; return accepted; } })]); app.runner.enqueue(product, schedule);
  app.db.exec("CREATE TRIGGER ignore_delivery BEFORE INSERT ON small_hour_deliveries BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(app.runner.runNext()); assert.equal(calls, 0);
  app.db.exec("UPDATE small_hour_tasks SET status = 'completed', token = NULL, lease_until = NULL");
  assert.throws(() => app.runner.inspect(product), { code: "invalid_task" });
});

test("cancelling an uncertain handoff prevents an idempotent resend while preserving its unknown outcome", async t => {
  const f = fixture(t); let sends = 0;
  const app = f.open([workflow({ idempotency: "key", async send() { sends++; throw new Error("lost response"); } })]);
  app.runner.enqueue(product, schedule); await app.runner.runNext();
  app.runner.cancel(product, "owner_cancelled");
  assert.equal(app.runner.inspect(product)?.cancellationReason, "owner_cancelled");
  assert.equal((await app.runner.retryDelivery(product))?.status, "uncertain"); assert.equal(sends, 1);
});

test("recovery honors the saved sink due time after a lease expires before task finalization", async t => {
  const f = fixture(t); let sends = 0;
  const definition = workflow({ idempotency: "none", async send() {
    sends++; if (sends === 1) { f.advance(201); return { ...deferred, dueAt: 500 }; } return accepted;
  } });
  const app = f.open([definition]); app.runner.enqueue(product, schedule);
  await assert.rejects(app.runner.runNext(), { code: "claim_lost" });
  assert.equal((await app.runner.runNext())?.status, "deferred"); assert.equal(sends, 1);
  f.advance(500); assert.equal((await app.runner.runNext())?.status, "completed"); assert.equal(sends, 2);
});

test("receipt inspection preserves the strongest confirmation across idempotent attempts", async t => {
  const f = fixture(t); let sends = 0;
  const app = f.open([workflow({ idempotency: "key", async send() { if (++sends === 1) throw new Error("lost response"); return accepted; } })]);
  app.runner.enqueue(product, schedule); await app.runner.runNext(); await app.runner.retryDelivery(product);
  const attempts = delivery(app.runner.inspect(product)).attempts;
  app.runner.recordDeliveryOutcome(product, { attemptId: attempts[0].id, outcome: { ...accepted, status: "confirmed", confirmation: { level: "device", evidence: "device-7" } } });
  app.runner.recordDeliveryOutcome(product, { attemptId: attempts[1].id, outcome: { ...accepted, status: "confirmed", confirmation: { level: "user", evidence: "user-7" } } });
  const state = delivery(app.runner.inspect(product)); assert.equal(state.status, "confirmed");
  if (state.status === "confirmed") assert.equal(state.confirmation.level, "user");
});

test("class-based sinks retain their methods and instance state", async t => {
  const f = fixture(t);
  class Sink implements DeliverySink {
    idempotency = "none" as const;
    calls = 0;
    async send() { this.calls++; return accepted; }
  }
  const sink = new Sink(), app = f.open([workflow(sink)]); app.runner.enqueue(product, schedule);
  assert.equal((await app.runner.runNext())?.status, "completed"); assert.equal(sink.calls, 1);
});

test("exhausted sends stay uncertain until receipt evidence arrives and never exceed the saved limit", async t => {
  const f = fixture(t); let sends = 0;
  const app = f.open([workflow({ idempotency: "key", async send() { sends++; throw new Error("lost response"); } })]);
  app.runner.enqueue(product, { ...schedule, maxAttempts: 1 }); await app.runner.runNext();
  assert.equal((await app.runner.retryDelivery(product))?.status, "uncertain"); assert.equal(sends, 1);
  const attemptId = delivery(app.runner.inspect(product)).attempts[0].id;
  app.runner.recordDeliveryOutcome(product, { attemptId, outcome: accepted });
  assert.equal((await app.runner.retryDelivery(product))?.status, "completed"); assert.equal(sends, 1);
});

test("exhausted recovery with definite non-acceptance releases the scope without sending", async t => {
  const f = fixture(t); let sends = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; f.advance(201); return { ...deferred, dueAt: 500 }; } });
  const app = f.open([definition]); app.runner.enqueue(product, { ...schedule, maxAttempts: 1 });
  await assert.rejects(app.runner.runNext(), { code: "claim_lost" });
  assert.equal((await app.runner.runNext())?.status, "failed"); assert.equal(sends, 1);
});

test("current authorization replaces an earlier safe deferral in delivery inspection", async t => {
  const f = fixture(t); let allowed = true, sends = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; return deferred; } },
    () => allowed ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" });
  const app = f.open([definition]); app.runner.enqueue(product, schedule); await app.runner.runNext();
  allowed = false; f.advance(200); const result = await app.runner.runNext();
  assert.equal(result?.status, "rejected"); assert.equal(delivery(result).status, "rejected"); assert.equal(sends, 1);
  assert.equal(delivery(result).attempts[0].outcome.status, "deferred");
});

for (const idempotency of ["key", "none"] as const) test(`process death after remote acceptance preserves ${idempotency} sink recovery rules`, async t => {
  const f = fixture(t), entered = gate(); let requests = 0;
  const remote = new Map<string, unknown>();
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests++; const saved = JSON.parse(body); assert.deepEqual(saved, product);
    remote.set(idempotency === "key" ? String(request.headers["idempotency-key"]) : String(requests), saved);
    if (requests === 1) { entered.resolve(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(accepted));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/delivery-worker.ts", import.meta.url)),
    f.path, url, "dispatch", idempotency, JSON.stringify(product), JSON.stringify(schedule)], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  await Promise.race([entered.promise, exited.then(([code, signal]) => { throw new Error(`Worker exited before sending: ${code}, ${signal}`); })]);
  child.kill("SIGKILL"); assert.deepEqual(await exited, [null, "SIGKILL"]); server.closeAllConnections(); f.advance(201);
  const app = f.open([workflow({ idempotency, async send(saved, context) {
    const response = await fetch(url, { method: "POST", headers: { "idempotency-key": context.idempotencyKey }, body: JSON.stringify(saved) });
    return response.json();
  } })]);
  const result = await app.runner.runNext();
  assert.equal(result?.status, idempotency === "key" ? "completed" : "uncertain");
  assert.equal(requests, idempotency === "key" ? 2 : 1); assert.equal(remote.size, 1);
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
  assert.equal(await app.runner.runNext(), undefined);
});

test("a separate process can commit output with an effect and exit before any handoff", async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/delivery-worker.ts", import.meta.url)),
    f.path, "http://127.0.0.1:1", "stage", "none", JSON.stringify(product), JSON.stringify(schedule)], { stdio: ["ignore", "ignore", "pipe"] });
  assert.deepEqual(await once(child, "exit"), [0, null]);
  let sends = 0; const app = f.open([workflow({ idempotency: "none", async send(saved) { sends++; assert.deepEqual(saved, product); return accepted; } })]);
  assert.equal(delivery(app.runner.inspect(product)).status, "queued");
  assert.equal((await app.runner.runNext())?.status, "completed"); assert.equal(sends, 1);
  assert.equal(app.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
});

test("a contradictory receipt cannot masquerade as definite non-acceptance and authorize a resend", async t => {
  const f = fixture(t); let sends = 0;
  const app = f.open([workflow({ idempotency: "none", async send() { sends++; return { ...deferred, receipt: accepted.receipt }; } })]);
  app.runner.enqueue(product, schedule);
  await assert.rejects(app.runner.runNext(), { code: "invalid_outcome" });
  assert.equal(delivery(app.runner.inspect(product)).status, "uncertain"); f.advance(201);
  assert.equal((await app.runner.runNext())?.status, "uncertain"); assert.equal(sends, 1);
});

for (const stage of ["attempt", "receipt"] as const) test(`failed ${stage} commit preserves the actual remote-effect boundary`, async t => {
  const f = fixture(t); let sends = 0, fail = true;
  const definition = workflow({ idempotency: "none", async send() { sends++; return accepted; } });
  const app = f.open([definition]);
  const database = { prepare: app.db.prepare.bind(app.db), exec(sql: string) {
    if (sql === "COMMIT" && fail) {
      const row = app.db.prepare("SELECT attempts_json FROM small_hour_deliveries").get();
      if (row && JSON.parse(String(row.attempts_json))[0].outcome.status === (stage === "attempt" ? "uncertain" : "accepted")) {
        fail = false; throw new Error("disk failure at commit");
      }
    }
    return app.db.exec(sql);
  } };
  const runner = new SqliteTaskRunner(database, [definition], { leaseMs: 100, now: () => now }); let now = 100;
  runner.enqueue(product, schedule); await assert.rejects(runner.runNext(), /disk failure/);
  assert.equal(sends, stage === "attempt" ? 0 : 1);
  assert.equal(delivery(app.runner.inspect(product)).status, stage === "attempt" ? "queued" : "uncertain");
  now = 201;
  assert.equal((await runner.runNext())?.status, stage === "attempt" ? "completed" : "uncertain");
  assert.equal(sends, 1);
});

test("a sink reason cannot substitute for conflicting receipt identities", async t => {
  const f = fixture(t); let sends = 0;
  const app = f.open([workflow({ idempotency: "key", async send() {
    sends++; return sends === 1 ? { status: "uncertain", reason: "conflicting_receipts" } : accepted;
  } })]);
  app.runner.enqueue(product, schedule); await app.runner.runNext();
  assert.equal((await app.runner.retryDelivery(product))?.status, "completed"); assert.equal(sends, 2);
});

test("an authorization status and due time survive a reason shared with a prior sink deferral", async t => {
  const f = fixture(t); let policy = 0, sends = 0;
  const definition = workflow({ idempotency: "none", async send() { sends++; return deferred; } }, () => policy === 0 ? { status: "allow" }
    : policy === 1 ? { status: "deferred", reason: deferred.reason, dueAt: 500 } : { status: "rejected", reason: deferred.reason });
  const app = f.open([definition]); app.runner.enqueue(product, schedule); await app.runner.runNext();
  policy = 1; f.advance(200); const postponed = delivery(await app.runner.runNext());
  assert.equal(postponed.status, "deferred"); if (postponed.status === "deferred") assert.equal(postponed.dueAt, 500);
  policy = 2; f.advance(500); assert.equal(delivery(await app.runner.runNext()).status, "rejected"); assert.equal(sends, 1);
});
