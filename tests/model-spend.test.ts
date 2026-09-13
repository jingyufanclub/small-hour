import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelCallContext, type ModelCallRecord, type ModelProvider } from "../src/index.js";
import { SqliteModelSpendStore, SqliteModelStepStore, type ModelSpendPolicy } from "../src/durable/sqlite.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

const input = { agentId: "app-a", input: "Process the selected work.", allowedTools: [] };
const scope = "app-a:period-1";
const usage = { model: "fixture", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
const response = { content: [{ type: "text" as const, text: "Processed." }], stopReason: "end_turn" as const, usage };
function policy(limit = 10, amount = 10, selectedScope = scope): ModelSpendPolicy {
  return { quote: () => ({ scope: selectedScope, limit, amount, pricing: { perToken: 1 } }),
    charge: (tokens, pricing) => (tokens.freshInputTokens + tokens.outputTokens) * (pricing as { perToken: number }).perToken };
}
function runtime(spend: SqliteModelSpendStore, provider: ModelProvider, options: Partial<ConstructorParameters<typeof SmallHourRuntime>[0]> = {}) {
  return new SmallHourRuntime({ persona: new StaticPersonaSource("Process supplied work."), memory: new EmptyMemorySource(),
    provider, modelCalls: spend.hooks(policy()), ...options });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-spend-"));
  const path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout = 5000"); connections.add(db);
    const spend = new SqliteModelSpendStore(db), steps = new SqliteModelStepStore(db);
    spend.initialize(); steps.initialize();
    return { db, spend, steps, close: () => { db.close(); connections.delete(db); } };
  };
  const app = open();
  app.db.exec("CREATE TABLE provider_calls (id INTEGER PRIMARY KEY)");
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...app, path, open };
}
function onlyCall(db: DatabaseSync): string {
  return String(db.prepare("SELECT call_id FROM small_hour_model_spend WHERE status <> 'denied'").get()?.call_id);
}

test("concurrent jobs share one ceiling and every provider call sees its committed reservation", async t => {
  const app = fixture(t), other = app.open();
  let calls = 0, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider: ModelProvider = { name: "fixture", async complete() {
    calls++;
    assert.equal(other.spend.inspectBudget(scope).reservedAmount, 10);
    entered(); if (calls === 1) await gate; return response;
  } };
  const first = runtime(app.spend, provider).turn(input);
  await started;
  try { await assert.rejects(runtime(other.spend, provider).turn(input), { code: "model_call_denied" }); }
  finally { release(); }
  const result = await first;
  assert.equal(calls, 1);
  assert.equal(app.spend.inspect(result.modelCalls[0].callId)?.status, "accepted");
  assert.equal(other.spend.inspectBudget(scope).totalAmount, 3);
});

test("a confirmed provider rejection releases its reservation before a bounded retry", async t => {
  const { spend } = fixture(t); let calls = 0;
  const result = await runtime(spend, { name: "fixture", isRetryable: () => true, failureInfo: () => ({ status: "rejected" }),
    async complete() { if (++calls === 1) throw new Error("rejected before processing"); return response; } },
  { retry: { attempts: 2, delayMs: () => 0 } }).turn(input);
  assert.equal(calls, 2);
  assert.deepEqual(result.modelCalls.map(call => spend.inspect(call.callId)?.status), ["rejected", "accepted"]);
  assert.equal(spend.inspectBudget(scope).totalAmount, 3);
});

test("an unknown transport outcome consumes the retry budget instead of buying another call", async t => {
  const { spend } = fixture(t); let calls = 0;
  await assert.rejects(runtime(spend, { name: "fixture", isRetryable: () => true,
    async complete() { calls++; throw new Error("connection lost after submission"); } },
  { retry: { attempts: 3, delayMs: () => 0 } }).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1);
  assert.equal(spend.inspectBudget(scope).unknownAmount, 10);
});

test("timeout after submission survives reopen and needs explicit evidence before releasing money", async t => {
  const app = fixture(t); let calls = 0;
  await assert.rejects(runtime(app.spend, { name: "fixture", complete: async () => { calls++; return new Promise(() => {}); } },
    { timeoutMs: 30 }).turn(input), { code: "turn_aborted" });
  const callId = onlyCall(app.db); app.close(); const recovered = app.open();
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  await assert.rejects(runtime(recovered.spend, provider).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1); assert.equal(recovered.spend.inspect(callId)?.status, "reserved");
  assert.throws(() => recovered.spend.reconcile(callId, { status: "rejected", evidence: "" }));
  assert.equal(recovered.spend.inspectBudget(scope).totalAmount, 10);
  const resolution = { status: "rejected" as const, evidence: "provider-review:no-charge-17" };
  recovered.spend.reconcile(callId, resolution); recovered.spend.reconcile(callId, resolution);
  assert.equal(recovered.spend.inspectBudget(scope).totalAmount, 0);
  await runtime(recovered.spend, provider).turn(input); assert.equal(calls, 2);
});

test("missing usage retains the full reservation and a resolved charge is applied exactly once", async t => {
  const { spend } = fixture(t); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return { ...response, usage: undefined }; } };
  const result = await runtime(spend, provider).turn(input), id = result.modelCalls[0].callId;
  assert.equal(spend.inspect(id)?.status, "unknown");
  assert.equal(spend.inspect(id)?.record?.status, "responded");
  await assert.rejects(runtime(spend, provider).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1);
  const resolution = { status: "accepted" as const, amount: 4, evidence: "provider-invoice:line-3" };
  spend.reconcile(id, resolution); spend.reconcile(id, resolution);
  assert.equal(spend.inspectBudget(scope).totalAmount, 4);
  assert.throws(() => spend.reconcile(id, { ...resolution, amount: 0 }), { code: "settlement_conflict" });
  assert.equal(spend.inspectBudget(scope).totalAmount, 4);
});

test("failed reservation writes and an enclosing transaction cannot let a paid call escape", async t => {
  const { db, spend } = fixture(t); let calls = 0;
  const model = runtime(spend, { name: "fixture", async complete() { calls++; return response; } });
  db.exec(`CREATE TRIGGER reject_reservation BEFORE INSERT ON small_hour_model_spend
    BEGIN SELECT RAISE(ABORT, 'reservation unavailable'); END`);
  await assert.rejects(model.turn(input), { code: "model_call_admission_failed" });
  db.exec("DROP TRIGGER reject_reservation; BEGIN");
  db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run();
  await assert.rejects(model.turn(input), { code: "model_call_admission_failed" });
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, 1);
  assert.equal(calls, 0); assert.equal(spend.inspectBudget(scope).totalAmount, 0);
});

test("a silently ignored reservation never authorizes a provider call", async t => {
  const { db, spend } = fixture(t); let calls = 0;
  db.exec(`CREATE TRIGGER ignore_reservation BEFORE INSERT ON small_hour_model_spend BEGIN SELECT RAISE(IGNORE); END`);
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input),
    { code: "model_call_admission_failed" });
  assert.equal(calls, 0);
});

test("a silently ignored settlement cannot report success or continue executing tools", async t => {
  const { db, spend } = fixture(t); let calls = 0, effects = 0;
  db.exec(`CREATE TRIGGER ignore_settlement BEFORE UPDATE ON small_hour_model_spend BEGIN SELECT RAISE(IGNORE); END`);
  await assert.rejects(runtime(spend, { name: "fixture", async complete() {
    calls++; return { ...response, content: [{ type: "tool_use", id: "write-1", name: "save", input: {} }], stopReason: "tool_use" };
  } }, { tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, execute() { effects++; } }]) })
    .turn({ ...input, allowedTools: ["save"] }), { code: "model_call_accounting_failed" });
  assert.equal(calls, 1); assert.equal(effects, 0);
  assert.throws(() => spend.reconcile(onlyCall(db), { status: "rejected", evidence: "provider:no-charge" }));
  assert.equal(spend.inspectBudget(scope).reservedAmount, 10);
});

test("a reservation that cannot commit starts no provider call", async t => {
  const { db, spend } = fixture(t); let calls = 0;
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE reservation_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE reservation_child (parent INTEGER REFERENCES reservation_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER defer_reservation_failure AFTER INSERT ON small_hour_model_spend
      BEGIN INSERT INTO reservation_child VALUES (1); END`);
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input),
    { code: "model_call_admission_failed" });
  assert.equal(calls, 0); assert.equal(spend.inspectBudget(scope).totalAmount, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM reservation_child").get()?.n, 0);
});

test("an accounting write failure stops the tool loop and preserves usage for later reconciliation", async t => {
  const { db, spend, steps } = fixture(t); let calls = 0, effects = 0;
  let fail = true;
  db.function("accounting_fault", () => { const rejected = fail; fail = false; return rejected ? 1 : 0; });
  db.exec(`CREATE TRIGGER reject_accounting BEFORE UPDATE ON small_hour_model_spend
    BEGIN SELECT CASE WHEN accounting_fault() = 1 THEN RAISE(ABORT, 'accounting unavailable') END; END`);
  const model = runtime(spend, { name: "fixture", async complete() {
    calls++; return { ...response, content: [{ type: "tool_use", id: "write-1", name: "save", input: {} }], stopReason: "tool_use" };
  } }, { tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, execute() { effects++; } }]) });
  const request = { scope: "workflow-a", id: "step-1", kind: "process", version: "1", input: {} };
  await assert.rejects(steps.run(request, model, { ...input, allowedTools: ["save"] }), { code: "model_call_accounting_failed" });
  assert.equal(calls, 1); assert.equal(effects, 0);
  const report = steps.inspect(request)!.report;
  assert.deepEqual(report.modelCalls[0].usage, usage);
  assert.equal(report.modelCalls[0].accounting, "unrecorded");
  assert.equal(spend.inspectBudget(scope).reservedAmount, 10);
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1);
  spend.reconcile(report.modelCalls[0].callId, { status: "accepted", amount: 3, evidence: "saved-step-1:provider-usage" });
  assert.equal(spend.inspectBudget(scope).totalAmount, 3);
});

test("completed model-step replay neither dispatches nor charges again and the next step shares the remaining budget", async t => {
  const app = fixture(t); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  const request = { scope: "workflow-a", id: "step-1", kind: "process", version: "1", input: {} };
  const first = await app.steps.run(request, runtime(app.spend, provider), input);
  app.close(); const recovered = app.open();
  const replay = await recovered.steps.run(request, runtime(recovered.spend, provider), input);
  assert.deepEqual(replay.result, first.result); assert.equal(calls, 1);
  assert.equal(recovered.spend.inspectBudget(scope).acceptedAmount, 3);
  await assert.rejects(recovered.steps.run({ ...request, id: "step-2" }, runtime(recovered.spend, provider), input), { code: "model_call_denied" });
  assert.equal(calls, 1);
});

test("scopes remain isolated and changing a limit does not erase recorded or uncertain spending", async t => {
  const { spend } = fixture(t); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return { ...response, usage: undefined }; } };
  await runtime(spend, provider).turn(input);
  await runtime(spend, provider, { modelCalls: spend.hooks(policy(10, 10, "app-b:period-1")) }).turn(input);
  await assert.rejects(runtime(spend, provider, { modelCalls: spend.hooks(policy(5, 1)) }).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 2);
  assert.equal(spend.inspectBudget(scope).totalAmount, 10);
  assert.equal(spend.inspectBudget("app-b:period-1").totalAmount, 10);
});

test("policy committed before reservation is read under the same spending transaction", async t => {
  const app = fixture(t), other = app.open(); let calls = 0, changed = false;
  app.db.exec("CREATE TABLE spending_policy (ceiling INTEGER NOT NULL); INSERT INTO spending_policy VALUES (10)");
  const spend = new SqliteModelSpendStore({ prepare: sql => app.db.prepare(sql), exec(sql) {
    if (sql === "BEGIN IMMEDIATE" && !changed) {
      other.db.prepare("UPDATE spending_policy SET ceiling = 0").run(); changed = true;
    }
    app.db.exec(sql);
  } });
  const current = policy();
  current.quote = () => ({ scope, limit: Number(app.db.prepare("SELECT ceiling FROM spending_policy").get()?.ceiling), amount: 10, pricing: { perToken: 1 } });
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } },
    { modelCalls: spend.hooks(current) }).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 0);
});

test("underestimated charges remain visible and block further spending instead of being capped to the quote", async t => {
  const { spend } = fixture(t); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return { ...response, usage: { ...usage, outputTokens: 18 } }; } };
  await runtime(spend, provider).turn(input);
  assert.equal(spend.inspectBudget(scope).acceptedAmount, 20);
  await assert.rejects(runtime(spend, provider).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1);
});

test("provider HTTP failures pass through durable admission without a hidden second request", async t => {
  for (const status of [429, 500]) await t.test(String(status), async t => {
    const app = fixture(t), observer = app.open(); let requests = 0;
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseURL: "http://fixture.invalid/v1", fetch: async () => {
      requests++;
      assert.equal(observer.spend.inspectBudget(scope).reservedAmount, 10);
      if (requests === 1) return new Response("{}", { status });
      return new Response(JSON.stringify({ model: "fixture", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Processed." } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    } });
    const pending = runtime(app.spend, provider, { retry: { attempts: 3, delayMs: () => 0 } }).turn(input);
    if (status === 429) { await pending; assert.equal(requests, 2); assert.equal(app.spend.inspectBudget(scope).acceptedAmount, 3); }
    else { await assert.rejects(pending, { code: "model_call_denied" }); assert.equal(requests, 1); assert.equal(app.spend.inspectBudget(scope).unknownAmount, 10); }
  });
});

test("output rejection and provider refusal do not refund a measured call", async t => {
  const { spend } = fixture(t);
  const rejected = await runtime(spend, { name: "fixture", async complete() { return response; } },
    { outputPolicy: { apply: () => ({ accepted: false, output: "", issues: ["invalid_fact"] }) } }).turn(input);
  assert.equal(rejected.status, "rejected");
  assert.equal(spend.inspect(rejected.modelCalls[0].callId)?.status, "accepted");
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { return { ...response, stopReason: "refusal" }; } },
    { modelCalls: spend.hooks(policy(20)) }).turn(input), { code: "provider_refused" });
  assert.equal(spend.inspectBudget(scope).acceptedAmount, 6);
});

test("a late provider completion cannot silently release an aborted call's reservation", async t => {
  const { spend, db } = fixture(t); const controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = runtime(spend, { name: "fixture", async complete() { entered(); await gate; return response; } })
    .turn({ ...input, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending, { code: "turn_aborted" });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(spend.inspect(onlyCall(db))?.status, "reserved");
  assert.equal(spend.inspectBudget(scope).totalAmount, 10);
});

test("the persisted price quote owns settlement and duplicate accounting cannot charge twice", async t => {
  const { spend, db } = fixture(t);
  const pricing = { perToken: 1 }, p = policy(); let priced = 0;
  p.quote = () => ({ scope, limit: 10, amount: 10, pricing });
  p.charge = (tokens, saved) => { priced++; return tokens.outputTokens * (saved as typeof pricing).perToken; };
  const hooks = spend.hooks(p);
  const context: ModelCallContext = { ...input, callId: "call-fixed", turnId: "turn-a", provider: "fixture", attempt: 1, hop: 1,
    maxTokens: 10, signal: new AbortController().signal };
  assert.equal(await hooks.admit!(context), true); pricing.perToken = 90;
  assert.throws(() => hooks.admit!(context), { code: "call_exists" });
  const record: ModelCallRecord = { callId: context.callId, provider: "fixture", attempt: 1, hop: 1, status: "responded", usage, accounting: "unrecorded" };
  await hooks.record!(record, context); await hooks.record!(record, context);
  assert.equal(priced, 1); assert.equal(spend.inspectBudget(scope).acceptedAmount, 1);
  assert.throws(() => hooks.record!({ ...record, usage: { ...usage, outputTokens: 0 } }, context), { code: "settlement_conflict" });
  assert.doesNotMatch(String(db.prepare("SELECT context_json FROM small_hour_model_spend").get()?.context_json), /Process the selected work/);
});

test("invalid quotes stop dispatch and invalid prices or usage preserve the reservation", async t => {
  const { spend } = fixture(t); let calls = 0;
  for (const amount of [-1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } },
      { modelCalls: spend.hooks(policy(10, amount)) }).turn(input), { code: "model_call_admission_failed" });
  }
  assert.equal(calls, 0);
  const p = policy(); p.charge = () => NaN;
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } },
    { modelCalls: spend.hooks(p) }).turn(input), { code: "model_call_accounting_failed" });
  assert.equal(calls, 1); assert.equal(spend.inspectBudget(scope).reservedAmount, 10);
  const other = policy(10, 10, "invalid-usage"); other.charge = () => 0;
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return { ...response, usage: { ...usage, outputTokens: -1 } }; } },
    { modelCalls: spend.hooks(other) }).turn(input), { code: "model_call_accounting_failed" });
  assert.equal(spend.inspectBudget("invalid-usage").totalAmount, 10);
});

test("corrupt persisted amounts fail closed before the next provider attempt", async t => {
  const { spend, db } = fixture(t); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  const result = await runtime(spend, provider).turn(input);
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.prepare("UPDATE small_hour_model_spend SET charged_amount = -3").run();
  assert.throws(() => spend.inspect(result.modelCalls[0].callId), { code: "invalid_record" });
  await assert.rejects(runtime(spend, provider).turn(input), { code: "model_call_admission_failed" });
  assert.equal(calls, 1);
});

for (const stage of ["in-provider", "before-settlement"]) test(`process death ${stage} leaves committed money held across restart`, { timeout: 10000 }, async t => {
  const app = fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/model-spend-worker.ts", import.meta.url)), app.path, stage],
    { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr?.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(signal, "SIGKILL", `worker failed: ${code}: ${errors}`);
  app.close(); const recovered = app.open(); let calls = 0;
  await assert.rejects(runtime(recovered.spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 0); assert.equal(recovered.db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, 1);
  assert.equal(recovered.spend.inspectBudget(scope).reservedAmount, 10);
});

test("independent processes cannot both reserve the last available call", { timeout: 10000 }, async t => {
  const app = fixture(t);
  const children = [0, 1].map(() => spawn(process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/model-spend-worker.ts", import.meta.url)), app.path, "compete"],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  const exits = children.map(child => once(child, "close"));
  await Promise.all(children.map(child => once(child, "message")));
  for (const child of children) child.send("go");
  const results = await Promise.all(exits);
  assert.deepEqual(results.map(([code]) => code).sort(), [0, 2]);
  assert.equal(app.db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, 1);
  assert.equal(app.spend.inspectBudget(scope).totalAmount, 10);
});
