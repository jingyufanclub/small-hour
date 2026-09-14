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
  type ModelProvider, type StructuredTurnInput } from "../src/index.js";
import { SqliteModelStepStore, SqliteOperationStore, type OperationRequest } from "../src/durable/sqlite.js";

type Selection = { itemIds: string[] };
const request: OperationRequest = {
  scope: "wardrobe:owner-a", id: "choose-1", kind: "choose-outfit", version: "1",
  input: { availableIds: ["coat-7", "boots-2", "hat-9"], occasion: "studio" },
};
function parseSelection(value: unknown): Selection {
  assert.ok(value && typeof value === "object");
  const selected = value as Selection;
  assert.ok(Array.isArray(selected.itemIds) && selected.itemIds.length > 0);
  assert.ok(selected.itemIds.every(id => ["coat-7", "boots-2", "hat-9"].includes(id)));
  return selected;
}
const turn: StructuredTurnInput<Selection> = {
  agentId: "owner-a", input: "Choose an outfit for the studio.",
  structuredOutput: { schema: { type: "object", properties: { itemIds: { type: "array", items: { type: "string" } } } }, parse: parseSelection },
};
function runtime(provider: ModelProvider, options: Partial<ConstructorParameters<typeof SmallHourRuntime>[0]> = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Choose from supplied IDs."),
    memory: new EmptyMemorySource(), ...options });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-steps-"));
  const path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    connections.add(db);
    const steps = new SqliteModelStepStore(db);
    const operations = new SqliteOperationStore(db);
    steps.initialize(); operations.initialize();
    return { db, steps, operations, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const app = open();
  app.db.exec(`CREATE TABLE outfits (id INTEGER PRIMARY KEY, item_ids TEXT NOT NULL);
    CREATE TABLE game_events (id INTEGER PRIMARY KEY, energy INTEGER NOT NULL);
    CREATE TABLE outputs (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE provider_calls (id INTEGER PRIMARY KEY);`);
  return { ...app, path, open };
}
function choosingProvider(onCall: () => void = () => {}): ModelProvider {
  return { name: "fixture", capabilities: { structuredOutput: true }, async complete() {
    onCall();
    return { content: [{ type: "text", text: '{"itemIds":["coat-7","boots-2"]}' }], stopReason: "end_turn" };
  } };
}

test("a saved wardrobe choice survives restart and feeds one local save without asking the model again", async t => {
  const app = fixture(t);
  let calls = 0;
  const model = runtime(choosingProvider(() => { calls++; }));
  const first = await app.steps.run(request, model, turn);
  assert.deepEqual(first.result.value.itemIds, ["coat-7", "boots-2"]);
  app.close();
  const recovered = app.open();
  const replay = await recovered.steps.run(request, model, turn);
  assert.equal(calls, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  const save = { ...request, id: "save-1", kind: "save-outfit", input: replay.result.value };
  const operation = { execute: (db: DatabaseSync) => {
    const id = Number(db.prepare("INSERT INTO outfits (item_ids) VALUES (?)").run(JSON.stringify(replay.result.value.itemIds)).lastInsertRowid);
    return { id, itemIds: replay.result.value.itemIds };
  }, parseResult: (value: unknown) => value as { id: number; itemIds: string[] } };
  const saved = recovered.operations.commit(save, operation);
  assert.deepEqual(recovered.operations.commit(save, operation).receipt, saved.receipt);
  assert.equal(recovered.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 1);
  assert.deepEqual(saved.receipt.result.itemIds, first.result.value.itemIds);
});

test("a committed game action feeds presentation once and a restart stages the exact saved reply", async t => {
  const app = fixture(t);
  const action = app.operations.commit({ scope: "game:one", id: "rest-1", kind: "rest", version: "1", input: { energy: 5 } }, {
    execute: db => ({ eventId: Number(db.prepare("INSERT INTO game_events (energy) VALUES (5)").run().lastInsertRowid), energy: 5 }),
    parseResult: value => value as { eventId: number; energy: number },
  });
  const presentation = { scope: "game:one", id: "voice-1", kind: "present-action", version: "1", input: action.receipt.result };
  let calls = 0;
  const model = runtime({ name: "fixture", async complete(input) {
    calls++;
    assert.equal(input.messages.at(-1)?.content, JSON.stringify(action.receipt.result));
    return { content: [{ type: "text", text: "Rested; energy is 5." }], stopReason: "end_turn" };
  } });
  const input = { agentId: "one", input: JSON.stringify(action.receipt.result), allowedTools: [] };
  const first = await app.steps.run(presentation, model, input);
  app.close();
  const recovered = app.open();
  const replay = await recovered.steps.run(presentation, model, input);
  assert.equal(calls, 1);
  assert.equal(replay.result.output, first.result.output);
  recovered.operations.commit({ ...presentation, id: "stage-1", kind: "stage-output", input: { body: replay.result.output } }, {
    execute: db => ({ outputId: Number(db.prepare("INSERT INTO outputs (body) VALUES (?)").run(replay.result.output).lastInsertRowid) }),
    parseResult: value => value as { outputId: number },
  });
  assert.equal(recovered.db.prepare("SELECT count(*) n FROM game_events").get()?.n, 1);
  assert.equal(recovered.db.prepare("SELECT body FROM outputs").get()?.body, first.result.output);
});

test("a pending attempt blocks concurrent re-entry and exposes its provider state", async t => {
  const app = fixture(t), observer = app.open();
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model = runtime({ ...choosingProvider(), async complete(input) {
    calls++; entered(); await gate;
    return choosingProvider().complete(input);
  } });
  const pending = app.steps.run(request, model, turn);
  await started;
  assert.equal(observer.steps.inspect(request)?.status, "started");
  assert.equal(observer.steps.inspect(request)?.report.modelCalls[0].status, "unknown");
  try { await assert.rejects(observer.steps.run(request, model, turn), { code: "step_unresolved" }); }
  finally { release(); }
  await pending;
  assert.equal(calls, 1);
});

test("changed workflow versions, inputs and offered tools cannot reuse a step identity", async t => {
  const { steps } = fixture(t);
  let calls = 0;
  const model = runtime(choosingProvider(() => { calls++; }));
  await steps.run(request, model, turn);
  for (const changed of [{ ...request, version: "2" }, { ...request, kind: "choose-shoes" }, { ...request, input: { availableIds: ["hat-9"] } }]) {
    await assert.rejects(steps.run(changed, model, turn), { code: "contract_conflict" });
  }
  await assert.rejects(steps.run(request, model, { ...turn, input: "Choose something else." }), { code: "contract_conflict" });
  await assert.rejects(steps.run(request, model, { agentId: turn.agentId, input: turn.input, allowedTools: ["save"] }), { code: "contract_conflict" });
  assert.equal(calls, 1);
  await steps.run({ ...request, scope: "wardrobe:owner-b" }, model, turn);
  assert.equal(calls, 2);
});

test("unrelated caller metadata is neither persisted nor treated as model-step input", async t => {
  const { db, steps } = fixture(t);
  let calls = 0;
  const model = runtime(choosingProvider(() => { calls++; }));
  const supplied = { ...turn, transportMetadata: { privateMarker: "unrelated-private-transport-data" } };
  await steps.run(request, model, supplied);
  assert.doesNotMatch(String(db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json), /unrelated-private-transport-data/);
  assert.equal((await steps.run(request, model, turn)).replayed, true);
  assert.equal(calls, 1);
});

test("invalid saved output stops before a new provider call or downstream effect", async t => {
  const { db, steps } = fixture(t);
  let calls = 0, effects = 0;
  const model = runtime(choosingProvider(() => { calls++; }));
  await steps.run(request, model, turn);
  const original = String(db.prepare("SELECT result_json FROM small_hour_model_steps").get()?.result_json);
  const wrongIds = JSON.parse(original); wrongIds.value.itemIds = ["unavailable-item"];
  for (const invalid of ["{", JSON.stringify(wrongIds), null]) {
    db.prepare("UPDATE small_hour_model_steps SET result_json = ?").run(invalid);
    await assert.rejects(async () => { await steps.run(request, model, turn); effects++; }, { code: "invalid_checkpoint" });
  }
  db.prepare("UPDATE small_hour_model_steps SET result_json = ?").run(original);
  await assert.rejects(steps.run(request, model, { ...turn, structuredOutput: {
    ...turn.structuredOutput, parse: () => ({ itemIds: ["hat-9"] }),
  } }), { code: "invalid_checkpoint" });
  assert.equal(calls, 1); assert.equal(effects, 0);
});

test("failed checkpoint writes never release an accepted result or silently rerun the model", async t => {
  const { db, steps } = fixture(t);
  let calls = 0;
  const model = runtime(choosingProvider(() => { calls++; }));
  db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF result_json ON small_hour_model_steps
    WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END`);
  await assert.rejects(steps.run(request, model, turn), /checkpoint unavailable/);
  db.exec("DROP TRIGGER reject_completion");
  await assert.rejects(steps.run(request, model, turn), { code: "step_unresolved" });
  assert.equal(calls, 1);
  assert.notEqual(steps.inspect(request)?.status, "completed");
});

test("incompatible saved report states cannot reach a downstream consumer", async t => {
  const { db, steps } = fixture(t);
  let calls = 0;
  const model = runtime(choosingProvider(() => { calls++; }));
  await steps.run(request, model, turn);
  const row = db.prepare("SELECT report_json, result_json FROM small_hour_model_steps").get();
  const report = JSON.parse(String(row?.report_json)), result = JSON.parse(String(row?.result_json));
  report.modelCalls[0].status = result.modelCalls[0].status = ["responded"];
  db.prepare("UPDATE small_hour_model_steps SET report_json = ?, result_json = ?")
    .run(JSON.stringify(report), JSON.stringify(result));
  assert.throws(() => steps.inspect(request), { code: "invalid_checkpoint" });
  await assert.rejects(steps.run(request, model, turn), { code: "invalid_checkpoint" });
  assert.equal(calls, 1);
});

test("a failed progress write stops the tool loop before any following model call", async t => {
  const { db, steps } = fixture(t);
  let calls = 0, reads = 0;
  let rejectProgress = true;
  db.function("checkpoint_storage", () => {
    const rejected = rejectProgress;
    rejectProgress = false;
    return rejected ? 1 : 0;
  });
  db.exec(`CREATE TRIGGER reject_tool_progress BEFORE UPDATE OF report_json ON small_hour_model_steps
    WHEN json_extract(NEW.report_json, '$.toolCalls[0].status') = 'completed' AND NEW.status = 'started'
    BEGIN SELECT CASE WHEN checkpoint_storage() = 1 THEN RAISE(ABORT, 'progress storage unavailable') END; END`);
  const model = runtime({ name: "fixture", async complete() {
    if (++calls === 1) return { content: [{ type: "tool_use", id: "read-1", name: "lookup", input: {} }], stopReason: "tool_use" };
    return { content: [{ type: "text", text: "Found it." }], stopReason: "end_turn" };
  } }, { tools: new ToolRegistry([{ name: "lookup", description: "Read", inputSchema: {}, mode: "read", execute: () => { reads++; return { id: "coat-7" }; } }]) });
  await assert.rejects(steps.run(request, model, { agentId: "owner-a", input: "Find the coat.", allowedTools: ["lookup"] }), { code: "checkpoint_failed" });
  assert.equal(reads, 1); assert.equal(calls, 1);
  assert.equal(steps.inspect(request)?.report.toolCalls[0].status, "completed");
});

test("a choice accepted before a callback failure remains available without another choice call", async t => {
  const { steps } = fixture(t);
  let calls = 0;
  const model = runtime({ name: "fixture", async complete() {
    calls++;
    return { content: [{ type: "tool_use", id: "choice-1", name: "small_hour_choose", input: { itemIds: ["coat-7", "boots-2"] } }], stopReason: "tool_use" };
  } });
  const input = { agentId: "owner-a", input: "Choose the outfit.", allowedTools: [], choice: {
    description: "Choose an outfit", inputSchema: turn.structuredOutput.schema, parse: parseSelection,
    onChoice: () => { throw new Error("application callback unavailable"); },
  } };
  await assert.rejects(steps.run(request, model, input));
  assert.deepEqual(parseSelection(steps.inspect(request)?.report.choice).itemIds, ["coat-7", "boots-2"]);
  await assert.rejects(steps.run(request, model, input), { code: "step_unresolved" });
  assert.equal(calls, 1);
});

test("a failed pre-call checkpoint retains the fact that the provider never started", async t => {
  const { db, steps } = fixture(t);
  db.exec(`CREATE TRIGGER reject_call_start BEFORE UPDATE OF report_json ON small_hour_model_steps
    WHEN json_extract(NEW.report_json, '$.modelCalls[0].status') = 'unknown' AND NEW.status = 'started'
    BEGIN SELECT RAISE(ABORT, 'call checkpoint unavailable'); END`);
  let calls = 0;
  await assert.rejects(steps.run(request, runtime(choosingProvider(() => { calls++; })), turn), { code: "checkpoint_failed" });
  assert.equal(calls, 0);
  assert.equal(steps.inspect(request)?.report.modelCalls[0].status, "not_started");
});

test("a failed pre-tool checkpoint retains the fact that the application effect never started", async t => {
  const { db, steps } = fixture(t);
  db.exec(`CREATE TRIGGER reject_tool_start BEFORE UPDATE OF report_json ON small_hour_model_steps
    WHEN json_extract(NEW.report_json, '$.toolCalls[0].status') = 'unknown' AND NEW.status = 'started'
    BEGIN SELECT RAISE(ABORT, 'tool checkpoint unavailable'); END`);
  let writes = 0;
  const model = runtime({ name: "fixture", async complete() {
    return { content: [{ type: "tool_use", id: "save-1", name: "save", input: {} }], stopReason: "tool_use" };
  } }, { tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, execute: () => { writes++; } }]) });
  await assert.rejects(steps.run(request, model, { agentId: "owner-a", input: "Save.", allowedTools: ["save"] }), { code: "checkpoint_failed" });
  assert.equal(writes, 0);
  assert.equal(steps.inspect(request)?.report.toolCalls[0].status, "not_started");
});

test("cancellation before entry starts neither a checkpoint nor a provider attempt", async t => {
  const { steps } = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(steps.run(request, runtime(choosingProvider(() => assert.fail("cancelled request called the model"))),
    { ...turn, signal: controller.signal }), { code: "turn_aborted" });
  assert.equal(steps.inspect(request), undefined);
});

test("an ignored started marker cannot release context loading or a provider call", async t => {
  const { db, steps } = fixture(t);
  db.exec("CREATE TRIGGER ignore_start BEFORE INSERT ON small_hour_model_steps BEGIN SELECT RAISE(IGNORE); END");
  let loads = 0, calls = 0;
  const model = runtime(choosingProvider(() => { calls++; }), { memory: { load: async () => { loads++; return []; } } });
  await assert.rejects(steps.run(request, model, turn));
  assert.equal(loads, 0); assert.equal(calls, 0);
  assert.equal(steps.inspect(request), undefined);
});

test("an asynchronous authority guard cannot permit durable execution", async t => {
  const { steps } = fixture(t);
  let calls = 0;
  for (const assertActive of [async () => {}, () => Promise.resolve()]) {
    await assert.rejects(steps.run(request, runtime(choosingProvider(() => { calls++; })), turn, { assertActive }), { code: "invalid_request" });
    assert.equal(steps.inspect(request), undefined);
  }
  assert.equal(calls, 0);
});

test("an asynchronous replay validator is rejected before execution", async t => {
  const { steps } = fixture(t);
  let calls = 0;
  const invalid = { ...turn, structuredOutput: { ...turn.structuredOutput, parse: async () => {
    throw new Error("asynchronous validation is unavailable");
  } } } as unknown as StructuredTurnInput<Selection>;
  await assert.rejects(steps.run(request, runtime(choosingProvider(() => { calls++; })), invalid), { code: "invalid_request" });
  assert.equal(calls, 0);
  assert.equal(steps.inspect(request), undefined);
});

test("a rejected presentation stays rejected when its completed step is replayed", async t => {
  const { steps } = fixture(t);
  let calls = 0;
  const model = runtime({ name: "fixture", async complete() {
    calls++; return { content: [{ type: "text", text: "Unaccepted presentation." }], stopReason: "end_turn" };
  } }, { outputPolicy: { apply: () => ({ accepted: false, output: "", issues: ["unsupported_fact"] }) } });
  const input = { agentId: "one", input: "Present the accepted event.", allowedTools: [] };
  const first = await steps.run(request, model, input);
  const second = await steps.run(request, model, input);
  assert.equal(first.result.status, "rejected");
  assert.equal(second.result.accepted, false);
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 1);
});

test("an outer transaction cannot hide the started marker while a provider call escapes", async t => {
  const { db, steps } = fixture(t);
  let calls = 0;
  db.exec("BEGIN");
  db.prepare("INSERT INTO outfits (item_ids) VALUES ('unrelated')").run();
  await assert.rejects(steps.run(request, runtime(choosingProvider(() => { calls++; })), turn));
  assert.equal(calls, 0);
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT count(*) n FROM outfits").get()?.n, 1);
  assert.equal(steps.inspect(request), undefined);
});

test("cancellation preserves partial tool receipts and prevents implicit recovery work", async t => {
  const { db, steps, operations } = fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const model = runtime({ name: "fixture", async complete() {
    calls++;
    if (calls === 1) return { content: [{ type: "tool_use", id: "save-tool", name: "save", input: {} }], stopReason: "tool_use" };
    controller.abort();
    return new Promise(() => {});
  } }, { tools: new ToolRegistry([{ name: "save", description: "Save an outfit", inputSchema: {}, execute: (_, context) => {
    operations.commit({ ...request, id: "save-1", kind: "save", input: {} }, {
      execute: connection => { connection.prepare("INSERT INTO outfits (item_ids) VALUES ('coat-7')").run(); return { id: "outfit-1" }; },
      parseResult: value => value as { id: string },
    });
    context.recordReceipt("save-1"); return { id: "outfit-1" };
  } }]) });
  const input = { agentId: "owner-a", input: "Save the selected outfit.", allowedTools: ["save"], signal: controller.signal };
  await assert.rejects(steps.run(request, model, input), { code: "turn_aborted" });
  const state = steps.inspect(request);
  assert.equal(state?.status, "failed");
  assert.equal(state?.report.toolCalls[0].status, "completed");
  assert.deepEqual(state?.report.toolCalls[0].receiptIds, ["save-1"]);
  assert.equal(state?.report.modelCalls[1].status, "unknown");
  await assert.rejects(steps.run(request, model, { ...input, signal: undefined }), { code: "step_unresolved" });
  assert.equal(db.prepare("SELECT count(*) n FROM outfits").get()?.n, 1);
  assert.equal(calls, 2);
});

test("durable turns preserve allowlists and leave transient retries with the bounded runtime", async t => {
  const { steps } = fixture(t);
  let calls = 0, writes = 0;
  const denied = runtime({ name: "fixture", async complete() {
    return { content: [{ type: "tool_use", id: "write-1", name: "save", input: {} }], stopReason: "tool_use" };
  } }, { tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, execute: () => { writes++; } }]), toolErrorMode: "throw" });
  await assert.rejects(steps.run(request, denied, { agentId: "owner-a", input: "Only inspect.", allowedTools: [] }));
  assert.equal(writes, 0);
  assert.equal(steps.inspect(request)?.report.toolCalls[0].status, "not_started");
  const retrying = runtime({ ...choosingProvider(), isRetryable: () => true, async complete(input) {
    if (++calls === 1) throw new Error("temporary connection failure");
    return choosingProvider().complete(input);
  } }, { retry: { attempts: 2, delayMs: () => 0 } });
  const retried = { ...request, id: "choose-2" };
  const first = await steps.run(retried, retrying, turn);
  assert.equal(first.result.modelCalls.length, 2);
  await steps.run(retried, retrying, turn);
  assert.equal(calls, 2);
});

async function crashWorker(path: string, stage: string) {
  const script = fileURLToPath(new URL("./fixtures/model-step-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, path, stage], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr?.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(signal, "SIGKILL", `worker failed: ${code}: ${errors}`);
}
for (const stage of ["before-provider", "in-provider", "after-provider", "after-checkpoint"]) {
  test(`process death ${stage} preserves the decision or stops before another model call`, { timeout: 10000 }, async t => {
    const app = fixture(t);
    await crashWorker(app.path, stage);
    const identity = { scope: "worker", id: "step-1", kind: "choose", version: "1", input: {} };
    const input = { ...turn, agentId: "worker", input: "Choose." };
    let calls = 0;
    const model = runtime(choosingProvider(() => { calls++; }));
    const state = app.steps.inspect(identity);
    if (stage === "after-checkpoint") {
      assert.equal(state?.status, "completed");
      assert.deepEqual((await app.steps.run(identity, model, input)).result.value.itemIds, ["coat-7", "boots-2"]);
    } else {
      assert.equal(state?.status, "started");
      await assert.rejects(app.steps.run(identity, model, input), { code: "step_unresolved" });
      if (stage === "after-provider") assert.equal(state?.report.modelCalls[0].status, "responded");
    }
    assert.equal(calls, 0);
    assert.equal(app.db.prepare("SELECT count(*) n FROM provider_calls").get()?.n, stage === "before-provider" ? 0 : 1);
  });
}
