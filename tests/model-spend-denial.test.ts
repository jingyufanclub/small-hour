import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource,
  type ModelCallContext, type ModelCallRecord, type ModelProvider } from "../src/index.js";
import { SqliteModelSpendStore, type ModelSpendDecision, type ModelSpendDenial, type ModelSpendPolicy } from "../src/durable/sqlite.js";

const input = { agentId: "app", input: "Private input that must not enter spending records.", allowedTools: [], maxTokens: 32 };
const scopeIds = ["app:period", "owner:authenticated:period"];
const usage = { model: "priced", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
const response = { content: [{ type: "text" as const, text: "Processed." }], stopReason: "end_turn" as const, usage };
const quoted = { scopes: scopeIds.map(scope => ({ scope, limit: 10 })), amount: 5, pricing: { revision: "prices-v1" } };
const denial = () => ({ denied: true, scopes: [...scopeIds], reason: "unknown_model", evidence: "rate-card:prices-v1" } satisfies ModelSpendDenial);
function policy(decision: ModelSpendDecision = denial()): ModelSpendPolicy {
  return { quote: () => decision, charge: () => assert.fail("A denied call must not be priced.") };
}
function context(callId: string): ModelCallContext {
  return { ...input, callId, turnId: "turn", provider: "fixture", model: "unpriced", attempt: 1, hop: 0,
    maxTokens: 32, signal: new AbortController().signal };
}
function runtime(spend: SqliteModelSpendStore, provider: ModelProvider, p = policy()) {
  return new SmallHourRuntime({ persona: new StaticPersonaSource("Process supplied work."), memory: new EmptyMemorySource(),
    provider, modelCalls: spend.hooks(p), retry: { attempts: 3, delayMs: () => 0 } });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-denial-")), path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(path); connections.add(db); db.exec("PRAGMA foreign_keys = ON");
    const spend = new SqliteModelSpendStore(db); spend.initialize();
    return { db, spend, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open };
}

test("an unpriced policy denial survives reopen with identity, scopes and evidence but no invented quote", async t => {
  const app = fixture(t), first = app.open(), selected = denial(); let calls = 0, offered = 0;
  const p = policy(selected), getDecision = p.quote;
  p.quote = call => { offered++; return getDecision(call); };
  let failure: RuntimeError | undefined;
  await assert.rejects(runtime(first.spend, { name: "fixture", model: "unpriced", isRetryable: () => true,
    async complete() { calls++; return response; } }, p).turn(input), error => {
    assert.ok(error instanceof RuntimeError); assert.equal(error.code, "model_call_denied"); failure = error; return true;
  });
  assert.equal(calls, 0); assert.equal(offered, 1);
  const report = failure!.report!;
  assert.equal(report.modelCalls.length, 1); assert.equal(report.modelCalls[0].status, "not_started");
  const callId = report.modelCalls[0].callId, before = first.spend.inspect(callId);
  assert.ok(before);
  assert.deepEqual(before.context, { agentId: input.agentId, turnId: report.turnId, callId, provider: "fixture", model: "unpriced",
    attempt: 1, hop: 1, maxTokens: 32 });
  assert.deepEqual(before, { ...before, status: "denied", quote: null, denial: selected, chargedAmount: 0, record: null, resolution: null });
  assert.ok(Number.isSafeInteger(before.createdAt)); assert.equal(before.updatedAt, before.createdAt);
  const row = first.db.prepare("SELECT * FROM small_hour_model_spend WHERE call_id = ?").get(callId)!;
  assert.equal(row.reserved_amount, 0); assert.equal(row.charged_amount, 0);
  assert.deepEqual(JSON.parse(String(row.quote_json)), selected);
  assert.equal(String(row.context_json).includes(input.input), false);
  selected.reason = "changed"; selected.scopes.push("untrusted");
  first.close(); const reopened = app.open();
  assert.deepEqual(reopened.spend.inspect(callId), before);
  for (const scope of scopeIds) {
    assert.ok(reopened.db.prepare("SELECT call_id FROM small_hour_model_spend_scopes WHERE call_id = ? AND scope = ?").get(callId, scope));
    assert.deepEqual(reopened.spend.inspectBudget(scope), { acceptedAmount: 0, reservedAmount: 0, unknownAmount: 0, totalAmount: 0 });
  }
});

test("denials cannot be settled, reconciled or reused as permission when pricing becomes available", async t => {
  const { db, spend } = fixture(t).open(), call = context("denied-call"), hooks = spend.hooks(policy());
  assert.equal(await hooks.admit!(call), false);
  const before = spend.inspect(call.callId);
  const measured: ModelCallRecord = { callId: call.callId, provider: call.provider, attempt: 1, hop: 0,
    status: "responded", accounting: "unrecorded", usage };
  assert.throws(() => hooks.record!(measured, call), { code: "settlement_conflict" });
  for (const outcome of [{ status: "rejected" as const, evidence: "later" }, { status: "accepted" as const, amount: 0, evidence: "later" }]) {
    assert.throws(() => spend.reconcile(call.callId, outcome), { code: "settlement_conflict" });
  }
  assert.throws(() => spend.hooks(policy(quoted)).admit!(call), { code: "call_exists" });
  assert.deepEqual(spend.inspect(call.callId), before);
  let calls = 0;
  const result = await runtime(spend, { name: "fixture", model: "priced", async complete() { calls++; return response; } },
    { quote: () => quoted, charge: () => 3 }).turn(input);
  assert.equal(calls, 1); assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 2);
  assert.deepEqual(spend.inspect(result.modelCalls[0].callId)?.quote, quoted);
  for (const scope of scopeIds) assert.equal(spend.inspectBudget(scope).totalAmount, 3);
});

test("invalid and mixed policy decisions never save a denial or dispatch", async t => {
  const { db, spend } = fixture(t).open(); let calls = 0;
  const provider: ModelProvider = { name: "fixture", async complete() { calls++; return response; } };
  const denied = denial();
  for (const value of [
    null, {}, { ...denied, denied: false }, { ...denied, denied: "true" },
    { ...denied, scopes: [] }, { ...denied, scopes: [" "] }, { ...denied, scopes: [scopeIds[0], scopeIds[0]] },
    { ...denied, scopes: [{ scope: "app", limit: 0 }] }, { ...denied, scopes: [null] }, { ...denied, scopes: null },
    { ...denied, reason: "" }, { ...denied, evidence: " " }, { ...denied, evidence: undefined },
    { ...denied, amount: 0 }, { ...denied, pricing: {} }, { ...denied, scope: "app" }, { ...denied, limit: 0 },
    { ...quoted, denied: false }, { ...quoted, denied: true, reason: "unknown_model", evidence: "prices-v1" },
  ]) await assert.rejects(runtime(spend, provider, policy(value as ModelSpendDecision)).turn(input), { code: "model_call_admission_failed" });
  assert.equal(calls, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend_scopes").get()?.n, 0);
});

for (const table of ["small_hour_model_spend", "small_hour_model_spend_scopes"]) for (const failure of ["ABORT", "IGNORE"])
  test(`a denial ${table} ${failure.toLowerCase()} saves no partial record and permits no dispatch`, async t => {
    const { db, spend } = fixture(t).open(); let calls = 0;
    db.exec(`CREATE TRIGGER fail_denial BEFORE INSERT ON ${table}
      ${table.endsWith("_scopes") ? "WHEN NEW.scope = 'owner:authenticated:period'" : ""}
      BEGIN SELECT RAISE(${failure}${failure === "ABORT" ? ", 'storage unavailable'" : ""}); END`);
    await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input),
      { code: "model_call_admission_failed" });
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend_scopes").get()?.n, 0);
    db.exec("DROP TRIGGER fail_denial");
    await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } }).turn(input),
      { code: "model_call_denied" });
    assert.equal(calls, 0); assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 1);
  });

test("a policy exception is an admission failure without a fabricated denial", async t => {
  const { db, spend } = fixture(t).open(); let calls = 0;
  await assert.rejects(runtime(spend, { name: "fixture", async complete() { calls++; return response; } },
    { quote: () => { throw new Error("rate card unavailable"); }, charge: () => 0 }).turn(input), { code: "model_call_admission_failed" });
  assert.equal(calls, 0); assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_spend").get()?.n, 0);
});

test("corrupt denial decisions, outcomes and memberships fail inspection without being repaired", async t => {
  const { db, spend } = fixture(t).open(), call = context("denied-call");
  assert.equal(await spend.hooks(policy()).admit!(call), false);
  const before = spend.inspect(call.callId);
  const tamper = [
    ["quote_json", JSON.stringify({ ...denial(), reason: "" })],
    ["quote_json", JSON.stringify({ ...denial(), amount: 0, pricing: null })],
    ["reserved_amount", 1], ["charged_amount", 1], ["status", "reserved"],
    ["record_json", JSON.stringify({ callId: call.callId, provider: call.provider, attempt: 1, hop: 0, status: "not_started", accounting: "unrecorded" })],
    ["resolution_json", JSON.stringify({ status: "rejected", evidence: "unrelated" })],
  ] as const;
  db.exec("PRAGMA ignore_check_constraints = ON");
  for (const [column, value] of tamper) {
    db.exec("SAVEPOINT corrupt");
    db.prepare(`UPDATE small_hour_model_spend SET ${column} = ? WHERE call_id = ?`).run(value, call.callId);
    assert.throws(() => spend.inspect(call.callId), { code: "invalid_record" });
    db.exec("ROLLBACK TO corrupt; RELEASE corrupt");
  }
  db.prepare("UPDATE small_hour_model_spend_scopes SET scope = 'different' WHERE scope = ?").run(scopeIds[0]);
  assert.throws(() => spend.inspect(call.callId), { code: "invalid_record" });
  db.prepare("UPDATE small_hour_model_spend_scopes SET scope = ? WHERE scope = 'different'").run(scopeIds[0]);
  assert.deepEqual(spend.inspect(call.callId), before);
});
