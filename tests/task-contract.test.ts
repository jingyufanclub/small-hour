import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ProviderRequest } from "../src/index.js";
import { SqliteTaskRunner, type TaskState, type TaskWorkflow } from "../src/durable/sqlite.js";
import { canonicalJson } from "../src/durable/json.js";

const task = { scope: "app", id: "reply", kind: "compose", version: "1", input: { instructions: "Use item-7.", text: "Accepted request." } };
const timing = { concurrencyScope: "app", dueAt: 100, maxAttempts: 4 };
const rewritten = { ...task.input, instructions: "Use an unapproved replacement." };
const immutable = /task contract is immutable/i;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-task-contract-")), path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>(), requests: ProviderRequest[] = [];
  let now = 100, incomplete = false;
  const workflow: TaskWorkflow<DatabaseSync> = { kind: task.kind, version: task.version, authorize: () => ({ status: "allow" }), steps: [
    { id: "compose", kind: "model", recovery: { sideEffectFree: true, maxAttempts: 3, maxModelCalls: 3 }, prepare: context => ({
      runtime: new SmallHourRuntime({ persona: new StaticPersonaSource("Follow the accepted request."), memory: new EmptyMemorySource(),
        provider: { name: "fixture", async complete(request) {
          requests.push(request);
          return { content: [{ type: "text", text: "Saved answer." }], stopReason: incomplete ? "max_tokens" : "end_turn" };
        } } }), input: { agentId: "app", input: canonicalJson(context.task.input), allowedTools: [] },
    }) },
    { id: "save", kind: "local", parseResult: value => value, execute(db, context) {
      const output = (context.results.compose as { output: string }).output;
      db.prepare("INSERT INTO effects VALUES (?, ?)").run(context.task.id, output); return output;
    } },
  ] };
  const open = () => {
    const db = new DatabaseSync(path); connections.add(db);
    db.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    const runner = new SqliteTaskRunner(db, [workflow], { leaseMs: 100, now: () => now }); runner.initialize();
    return { db, runner, close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, path, requests, advance: (time: number) => { now = time; }, incomplete: (value: boolean) => { incomplete = value; } };
}

function decision(state: TaskState) {
  const model = state.steps[0].model; assert.ok(model);
  return { stepId: "compose", action: "retry" as const, checkpoint: model.checkpoint,
    reason: "Application permits recovery", evidence: { policy: 1 } };
}

test("accepted input survives another writer before the first model checkpoint", async t => {
  const f = fixture(t), first = f.open(); first.runner.enqueue(task, timing);
  first.db.exec(`CREATE TRIGGER interrupt_checkpoint BEFORE INSERT ON small_hour_model_steps
    BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END`);
  await assert.rejects(first.runner.run(task), /checkpoint unavailable/);
  assert.equal(f.requests.length, 0);
  assert.equal(first.db.prepare("SELECT count(*) n FROM small_hour_model_steps").get()?.n, 0);
  const writer = new DatabaseSync(f.path);
  let mutationError: unknown;
  try { writer.prepare("UPDATE small_hour_tasks SET input_json = ? WHERE scope = ? AND id = ?").run(canonicalJson(rewritten), task.scope, task.id); }
  catch (error) { mutationError = error; }
  finally { writer.close(); }
  first.db.exec("DROP TRIGGER interrupt_checkpoint"); first.close(); f.advance(201);
  const reopened = f.open(), completed = await reopened.runner.run(task);
  assert.equal(completed?.status, "completed"); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].messages[0].content, canonicalJson(task.input));
  assert.match(String(mutationError), immutable);
  assert.deepEqual(completed.input, task.input);
  assert.deepEqual(reopened.db.prepare("SELECT * FROM effects").all().map(row => ({ ...row })), [{ id: task.id, body: "Saved answer." }]);
});

test("explicit model recovery retains the accepted input after an attempted rewrite", async t => {
  const f = fixture(t), first = f.open(); f.incomplete(true); first.runner.enqueue(task, timing);
  const stopped = (await first.runner.run(task))!; assert.equal(stopped.status, "uncertain");
  assert.throws(() => first.db.prepare("UPDATE small_hour_tasks SET input_json = ?").run(canonicalJson(rewritten)), immutable);
  first.close(); f.incomplete(false);
  const reopened = f.open(), completed = await reopened.runner.retryModel(task, decision(stopped));
  assert.equal(completed?.status, "completed");
  assert.deepEqual(f.requests.map(request => request.messages[0].content), [canonicalJson(task.input), canonicalJson(task.input)]);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM effects").get()?.n, 1);
});

for (const [column, replacement] of [
  ["scope", "another-app"], ["id", "another-task"], ["kind", "another-workflow"], ["version", "2"],
  ["input_json", canonicalJson(rewritten)], ["plan_json", canonicalJson([{ id: "other", kind: "local" }])],
  ["schedule_json", canonicalJson({ ...timing, maxAttempts: 100 })], ["concurrency_scope", "independent"],
]) {
  test(`a SQL rewrite cannot change accepted ${column} or partially advance the task`, t => {
    const app = fixture(t).open(), queued = app.runner.enqueue(task, timing);
    assert.throws(() => app.db.prepare(`UPDATE small_hour_tasks SET ${column} = ?, due_at = 900 WHERE scope = ? AND id = ?`)
      .run(replacement, task.scope, task.id), immutable);
    assert.deepEqual(app.runner.inspect(task), queued);
  });
}

for (const conflict of ["ON CONFLICT(scope, id) DO UPDATE SET input_json = excluded.input_json", "REPLACE"]) {
  test(`${conflict === "REPLACE" ? "replacement" : "upsert"} cannot change the accepted task contract`, t => {
    const app = fixture(t).open(), queued = app.runner.enqueue(task, timing);
    const row = app.db.prepare("SELECT * FROM small_hour_tasks").get()!;
    const columns = Object.keys(row), values = columns.map(column => column === "input_json" ? canonicalJson(rewritten) : row[column]);
    const sql = `INSERT ${conflict === "REPLACE" ? "OR REPLACE " : ""}INTO small_hour_tasks (${columns.join(",")})
      VALUES (${columns.map(() => "?").join(",")}) ${conflict === "REPLACE" ? "" : conflict}`;
    assert.throws(() => app.db.prepare(sql).run(...values), immutable);
    assert.deepEqual(app.runner.inspect(task), queued);
  });
}

test("unchanged contract writes preserve execution and application-owned retention", async t => {
  const app = fixture(t).open(); app.runner.enqueue(task, timing);
  app.db.exec(`UPDATE small_hour_tasks SET scope = scope, id = id, kind = kind, version = version, input_json = input_json,
    plan_json = plan_json, schedule_json = schedule_json, concurrency_scope = concurrency_scope`);
  assert.equal((await app.runner.run(task))?.status, "completed");
  app.db.prepare("DELETE FROM small_hour_tasks WHERE scope = ? AND id = ?").run(task.scope, task.id);
  assert.equal(app.runner.inspect(task), undefined);
});

test("initialization protects existing task contracts and joins setup rollback", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(readFileSync(new URL("./fixtures/durable-legacy.sql", import.meta.url), "utf8"));
  const runner = new SqliteTaskRunner(db, [], { leaseMs: 100 });
  const before = db.prepare("SELECT * FROM small_hour_tasks ORDER BY id").all();
  db.exec("BEGIN"); runner.initialize();
  assert.throws(() => db.exec("UPDATE small_hour_tasks SET input_json = '{}'"), immutable);
  db.exec("ROLLBACK");
  assert.deepEqual(db.prepare("SELECT * FROM small_hour_tasks ORDER BY id").all(), before);
  db.exec("SAVEPOINT prove_rollback; UPDATE small_hour_tasks SET input_json = '{}'; ROLLBACK TO prove_rollback; RELEASE prove_rollback");
  runner.initialize(); runner.initialize();
  assert.throws(() => db.exec("UPDATE small_hour_tasks SET input_json = '{}'"), immutable);
  const protectedRows = db.prepare("SELECT * FROM small_hour_tasks ORDER BY id").all();
  assert.deepEqual(protectedRows.map(row => row.input_json), before.map(row => row.input_json));
  assert.deepEqual(protectedRows.map(row => row.id), before.map(row => row.id));
});
