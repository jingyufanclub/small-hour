import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelCallContext, type ModelProvider } from "../src/index.js";
import { SqliteModelSpendStore, type ModelSpendPolicy } from "../src/durable/sqlite.js";

const input = { agentId: "app", input: "Process selected work.", allowedTools: [] };
const usage = { model: "fixture", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
const response = { content: [{ type: "text" as const, text: "Processed." }], stopReason: "end_turn" as const, usage };
const limits = [{ scope: "app:month", limit: 10 }, { scope: "account:a:month", limit: 10 }];
function policy(scopes = limits, amount = 10): ModelSpendPolicy {
  return { quote: () => ({ scopes, amount, pricing: { revision: "1" } }), charge: () => 3 };
}
function runtime(spend: SqliteModelSpendStore, provider: ModelProvider, p = policy(), attempts = 1) {
  return new SmallHourRuntime({ persona: new StaticPersonaSource("Process supplied work."), memory: new EmptyMemorySource(),
    provider, modelCalls: spend.hooks(p), retry: { attempts, delayMs: () => 0 } });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-scopes-")), path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  const open = (initialize = true) => {
    const db = new DatabaseSync(path); connections.add(db); db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    const spend = new SqliteModelSpendStore(db); if (initialize) spend.initialize();
    return { db, spend, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, open };
}
function context(callId: string): ModelCallContext {
  return { ...input, callId, turnId: "turn", provider: "fixture", attempt: 1, hop: 0, maxTokens: 10, signal: new AbortController().signal };
}

test("a provider sees one committed reservation in every applicable budget and one final charge", async t => {
  const app = fixture(t), first = app.open(), observer = app.open(); let calls = 0;
  const result = await runtime(first.spend, { name: "fixture", async complete() {
    calls++;
    for (const { scope } of limits) assert.equal(observer.spend.inspectBudget(scope).reservedAmount, 10);
    assert.equal(observer.db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 1);
    return response;
  } }).turn(input);
  assert.equal(calls, 1);
  assert.deepEqual(observer.spend.inspect(result.modelCalls[0].callId)?.quote, policy().quote(context("unused")));
  for (const { scope } of limits) assert.equal(observer.spend.inspectBudget(scope).acceptedAmount, 3);
  assert.equal(observer.db.prepare("SELECT sum(charged_amount) n FROM small_hour_model_spend").get()?.n, 3);
});

for (const exhausted of limits) test(`exhausting ${exhausted.scope} denies the call without holding the other allowance`, async t => {
  const { spend, db } = fixture(t).open(); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  const first = await runtime(spend, provider, { quote: () => ({ scope: exhausted.scope, limit: 10, amount: 10, pricing: {} }), charge: () => 10 }).turn(input);
  await assert.rejects(runtime(spend, provider).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1);
  for (const { scope } of limits) assert.equal(spend.inspectBudget(scope).totalAmount, scope === exhausted.scope ? 10 : 0);
  const denied = String(db.prepare("SELECT call_id FROM small_hour_model_spend WHERE call_id <> ?").get(first.modelCalls[0].callId)?.call_id);
  assert.equal(spend.inspect(denied)?.status, "denied");
});

for (const failure of ["ABORT", "IGNORE"]) test(`a ${failure.toLowerCase()} on the second membership rolls back the whole admission`, async t => {
  const { spend, db } = fixture(t).open(); let calls = 0;
  db.exec(`CREATE TRIGGER fail_membership BEFORE INSERT ON small_hour_model_spend_scopes
    WHEN NEW.scope = 'account:a:month' BEGIN SELECT RAISE(${failure}${failure === "ABORT" ? ", 'unavailable'" : ""}); END`);
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input),
    { code: "model_call_admission_failed" });
  assert.equal(calls, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend_scopes").get()?.n, 0);
  for (const { scope } of limits) assert.equal(spend.inspectBudget(scope).totalAmount, 0);
});

test("unknown calls keep every allowance across restart until one evidenced reconciliation settles them", async t => {
  const app = fixture(t), first = app.open(); let calls = 0;
  const result = await runtime(first.spend, { name: "fixture", async complete() { calls++; return { ...response, usage: undefined }; } }).turn(input);
  const id = result.modelCalls[0].callId; first.close(); const reopened = app.open();
  for (const { scope } of limits) assert.equal(reopened.spend.inspectBudget(scope).unknownAmount, 10);
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  await assert.rejects(runtime(reopened.spend, provider).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 1);
  const resolution = { status: "accepted" as const, amount: 4, evidence: "provider-invoice:line-3" };
  reopened.spend.reconcile(id, resolution); reopened.spend.reconcile(id, resolution);
  assert.throws(() => reopened.spend.reconcile(id, { ...resolution, amount: 0 }), { code: "settlement_conflict" });
  for (const { scope } of limits) assert.deepEqual(reopened.spend.inspectBudget(scope),
    { acceptedAmount: 4, reservedAmount: 0, unknownAmount: 0, totalAmount: 4 });
  await runtime(reopened.spend, provider, policy(limits, 6)).turn(input);
  for (const { scope } of limits) assert.equal(reopened.spend.inspectBudget(scope).totalAmount, 7);
});

test("known rejection releases every hold for a bounded retry and repeated settlement never charges twice", async t => {
  const { spend } = fixture(t).open(); let calls = 0, prices = 0;
  const p = policy(); p.charge = () => { prices++; return 3; };
  const hooks = spend.hooks(p);
  const model = new SmallHourRuntime({ persona: new StaticPersonaSource("Process."), memory: new EmptyMemorySource(),
    modelCalls: { admit: hooks.admit, record: async (record, context) => { await hooks.record!(record, context); await hooks.record!(record, context); } },
    provider: { name: "fixture", isRetryable: () => true, failureInfo: () => ({ status: "rejected" }), async complete() {
      if (++calls === 1) throw new Error("not processed"); return response;
    } }, retry: { attempts: 2, delayMs: () => 0 } });
  const result = await model.turn(input);
  assert.equal(calls, 2); assert.equal(prices, 1);
  assert.deepEqual(result.modelCalls.map(call => spend.inspect(call.callId)?.status), ["rejected", "accepted"]);
  for (const { scope } of limits) assert.equal(spend.inspectBudget(scope).totalAmount, 3);
});

test("lowered limits and underestimated charges preserve exposure in all budgets", async t => {
  const { spend } = fixture(t).open(); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  await runtime(spend, provider).turn(input);
  await assert.rejects(runtime(spend, provider, policy([{ ...limits[0], limit: 2 }, limits[1]], 1)).turn(input), { code: "model_call_denied" });
  const p = policy(limits, 7); p.charge = () => 20;
  await runtime(spend, provider, p).turn(input);
  for (const { scope } of limits) assert.equal(spend.inspectBudget(scope).totalAmount, 23);
  await assert.rejects(runtime(spend, provider, policy(limits, 0)).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 2);
});

test("empty, duplicate, mixed and malformed scope policies never enter the provider", async t => {
  const { spend } = fixture(t).open(); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  for (const fields of [
    { scopes: [] }, { scopes: [limits[0], limits[0]] }, { scopes: [limits[0], { ...limits[0], limit: 20 }] },
    { scopes: limits, scope: "legacy", limit: 10 }, { scopes: [{ scope: "", limit: 10 }] },
    { scopes: [{ scope: "app", limit: -1 }] }, { scopes: [{ scope: "app" }] }, { scopes: null }, {},
  ]) {
    const p = { quote: () => ({ ...fields, amount: 1, pricing: {} }), charge: () => 1 } as ModelSpendPolicy;
    await assert.rejects(runtime(spend, provider, p).turn(input), { code: "model_call_admission_failed" });
  }
  assert.equal(calls, 0);
});

function legacyDatabase(db: DatabaseSync) {
  db.exec(`CREATE TABLE small_hour_model_spend (
    call_id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, context_json TEXT NOT NULL, quote_json TEXT NOT NULL,
    reserved_amount INTEGER NOT NULL, status TEXT NOT NULL, charged_amount INTEGER, record_json TEXT, resolution_json TEXT,
    format_version INTEGER NOT NULL);
    CREATE INDEX small_hour_model_spend_scope ON small_hour_model_spend(scope)`);
  for (const status of ["accepted", "reserved", "unknown", "rejected", "denied"]) {
    const call = context(status), quote = { scope: limits[0].scope, limit: 30, amount: 5, pricing: { revision: "legacy" } };
    const record = ["accepted", "unknown", "rejected"].includes(status) ? { callId: call.callId, provider: call.provider, attempt: call.attempt,
      hop: call.hop, accounting: "unrecorded", status: status === "accepted" ? "responded" : status,
      ...(status === "accepted" ? { usage } : {}) } : null;
    const { input: _, signal: __, allowedTools: ___, ...identity } = call as typeof call & { allowedTools: string[] };
    db.prepare("INSERT INTO small_hour_model_spend VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)")
      .run(call.callId, quote.scope, JSON.stringify(identity), JSON.stringify(quote), 5, status,
        status === "accepted" ? 3 : ["denied", "rejected"].includes(status) ? 0 : null, record && JSON.stringify(record));
  }
}

test("migration preserves single-scope history and blocks legacy admission while overlap includes previous charges", async t => {
  const app = fixture(t), legacy = app.open(false); legacyDatabase(legacy.db);
  const prior = legacy.db.prepare("SELECT context_json, quote_json, record_json FROM small_hour_model_spend WHERE call_id = 'accepted'").get();
  legacy.spend.initialize(); legacy.spend.initialize();
  assert.deepEqual(legacy.db.prepare("SELECT context_json, quote_json, record_json FROM small_hour_model_spend WHERE call_id = 'accepted'").get(), prior);
  assert.equal(legacy.spend.inspectBudget(limits[0].scope).totalAmount, 13);
  assert.equal(legacy.spend.inspect("accepted")?.quote.scope, limits[0].scope);
  assert.equal(legacy.spend.inspect("unknown")?.status, "unknown");
  assert.throws(() => legacy.db.prepare("SELECT SUM(reserved_amount) FROM small_hour_model_spend WHERE scope = ?").get(limits[0].scope), /no such column/);
  let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  await assert.rejects(runtime(legacy.spend, provider, policy(limits, 1)).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 0);
  await runtime(legacy.spend, provider, policy([{ ...limits[0], limit: 20 }, limits[1]], 7)).turn(input);
  assert.equal(legacy.spend.inspectBudget(limits[0].scope).totalAmount, 16);
  assert.equal(legacy.spend.inspectBudget(limits[1].scope).totalAmount, 3);
  legacy.spend.reconcile("reserved", { status: "rejected", evidence: "provider:no-charge" });
  legacy.close(); const reopened = app.open();
  assert.equal(reopened.spend.inspectBudget(limits[0].scope).totalAmount, 11);
});

test("invalid legacy data aborts the entire migration without discarding earlier reservations", t => {
  const { db, spend } = fixture(t).open(false); legacyDatabase(db);
  db.prepare("UPDATE small_hour_model_spend SET quote_json = '{}' WHERE call_id = 'unknown'").run();
  assert.throws(() => spend.initialize(), { code: "invalid_record" });
  assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend WHERE format_version = 1 AND scope = ?").get(limits[0].scope)?.n, 5);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'small_hour_model_spend_scopes'").get(), undefined);
});

for (const competition of ["shared", "account"]) test(`independent processes cannot overspend the ${competition} allowance`, { timeout: 15000 }, async t => {
  const app = fixture(t), { db, spend } = app.open(); db.exec("CREATE TABLE provider_calls (id INTEGER PRIMARY KEY)");
  const children = ["a", "b"].map(account => spawn(process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/model-spend-scopes-worker.ts", import.meta.url)), app.path, competition, account],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  let errors = ""; for (const child of children) child.stderr?.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const exits = children.map(child => once(child, "close"));
  await Promise.all(children.map(child => once(child, "message")));
  for (const child of children) child.send("go");
  const results = await Promise.all(exits);
  assert.deepEqual(results.map(([code]) => code).sort(), [0, 2], errors);
  assert.equal(db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, 1);
  assert.equal(spend.inspectBudget("app:month").unknownAmount, 10);
  assert.equal(spend.inspectBudget("account:a:month").totalAmount + spend.inspectBudget("account:b:month").totalAmount, 10);
});

for (const stage of ["in-provider", "before-settlement"]) test(`process death ${stage} retains every committed allowance`, { timeout: 15000 }, async t => {
  const app = fixture(t), first = app.open(); first.db.exec("CREATE TABLE provider_calls (id INTEGER PRIMARY KEY)");
  const child = spawn(process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/model-spend-scopes-worker.ts", import.meta.url)), app.path, stage, "a"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr?.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const [code, signal] = await once(child, "close"); assert.equal(signal, "SIGKILL", `${code}: ${errors}`);
  first.close(); const recovered = app.open(); let calls = 0;
  await assert.rejects(runtime(recovered.spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input), { code: "model_call_denied" });
  assert.equal(calls, 0);
  for (const { scope } of limits) assert.equal(recovered.spend.inspectBudget(scope).reservedAmount, 10);
});
