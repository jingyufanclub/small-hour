import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteOperationStore, type LocalOperation, type OperationRequest } from "../src/durable/sqlite.js";

const request: OperationRequest = {
  scope: "wardrobe:owner-a", id: "save-1", kind: "save-outfit", version: "1",
  input: { itemIds: ["coat-7", "boots-2"], occasion: "studio" },
};

type Outfit = { outfitId: number; itemIds: string[] };
function parseOutfit(value: unknown): Outfit {
  assert.ok(value && typeof value === "object");
  const result = value as Outfit;
  assert.ok(Number.isSafeInteger(result.outfitId) && result.outfitId > 0);
  assert.ok(Array.isArray(result.itemIds) && result.itemIds.every(id => typeof id === "string"));
  return result;
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-operations-"));
  const path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  function open() {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    connections.add(db);
    const store = new SqliteOperationStore(db);
    store.initialize();
    return { db, store, close: () => { db.close(); connections.delete(db); } };
  }
  t.after(() => {
    for (const db of connections) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const initial = open();
  initial.db.exec(`
    CREATE TABLE outfits (id INTEGER PRIMARY KEY, item_ids TEXT NOT NULL);
    CREATE TABLE creatures (id TEXT PRIMARY KEY, energy INTEGER NOT NULL);
    INSERT INTO creatures VALUES ('creature-a', 2);
    CREATE TABLE pending_outputs (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, kind TEXT NOT NULL);
  `);
  return { ...initial, path, open };
}

function saveOutfit(db: DatabaseSync): Outfit {
  const itemIds = ["coat-7", "boots-2"];
  const result = db.prepare("INSERT INTO outfits (item_ids) VALUES (?)").run(JSON.stringify(itemIds));
  return { outfitId: Number(result.lastInsertRowid), itemIds };
}

test("a lost outfit-save response replays the original outfit after reopening the database", (t) => {
  const app = fixture(t);
  const first = app.store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  assert.equal(first.replayed, false);
  assert.deepEqual(first.receipt, { scope: request.scope, id: request.id, kind: request.kind,
    version: request.version, result: { outfitId: 1, itemIds: ["coat-7", "boots-2"] } });
  app.close();

  const recovered = app.open();
  const replay = recovered.store.commit(request, {
    execute: () => assert.fail("a duplicate must not save another outfit"), parseResult: parseOutfit,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(recovered.store.find(request, parseOutfit), first.receipt);
  assert.equal(recovered.db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 1);
});

type ActionResult = { eventId: number; outputId: number; energy: number };
function parseAction(value: unknown): ActionResult {
  assert.ok(value && typeof value === "object");
  const result = value as ActionResult;
  for (const field of [result.eventId, result.outputId, result.energy]) assert.ok(Number.isSafeInteger(field));
  return result;
}
const actionRequest: OperationRequest = {
  scope: "game:creature-a", id: "owner-action-1", kind: "rest", version: "1", input: { amount: 3 },
};
function rest(db: DatabaseSync): ActionResult {
  db.prepare("UPDATE creatures SET energy = energy + ? WHERE id = ?").run(3, "creature-a");
  const eventId = Number(db.prepare("INSERT INTO events (subject, kind) VALUES (?, ?)")
    .run("creature-a", "rested").lastInsertRowid);
  const energy = Number(db.prepare("SELECT energy FROM creatures WHERE id = ?").get("creature-a")?.energy);
  const outputId = Number(db.prepare("INSERT INTO pending_outputs (event_id, payload) VALUES (?, ?)")
    .run(eventId, JSON.stringify({ eventId, energy })).lastInsertRowid);
  return { eventId, outputId, energy };
}

test("a game action and its pending owner output roll back when the receipt cannot be saved", (t) => {
  const { db, store } = fixture(t);
  db.exec(`CREATE TRIGGER reject_receipt BEFORE UPDATE OF result_json ON small_hour_operation_receipts
    WHEN NEW.scope = 'game:creature-a' BEGIN SELECT RAISE(ABORT, 'receipt storage unavailable'); END`);
  assert.throws(() => store.commit(actionRequest, { execute: rest, parseResult: parseAction }), /receipt storage unavailable/);
  assert.equal(db.prepare("SELECT energy FROM creatures WHERE id = 'creature-a'").get()?.energy, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM pending_outputs").get()?.n, 0);
  assert.equal(store.find(actionRequest, parseAction), undefined);

  db.exec("DROP TRIGGER reject_receipt");
  const accepted = store.commit(actionRequest, { execute: rest, parseResult: parseAction });
  const duplicate = store.commit(actionRequest, { execute: () => assert.fail("no second rest"), parseResult: parseAction });
  assert.deepEqual(duplicate.receipt, accepted.receipt);
  assert.equal(db.prepare("SELECT energy FROM creatures WHERE id = 'creature-a'").get()?.energy, 5);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM pending_outputs").get()?.n, 1);
  assert.deepEqual(JSON.parse(String(db.prepare("SELECT payload FROM pending_outputs").get()?.payload)),
    { eventId: accepted.receipt.result.eventId, energy: 5 });
});

test("the application's outer transaction controls when effects and receipts become durable", (t) => {
  const { db, store, open } = fixture(t);
  const observer = open();
  db.exec("BEGIN");
  store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  assert.equal(observer.store.find(request, parseOutfit), undefined);
  db.exec("ROLLBACK");
  assert.equal(store.find(request, parseOutfit), undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);

  db.exec("BEGIN");
  store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  db.exec("COMMIT");
  assert.equal(observer.store.find(request, parseOutfit)?.result.outfitId, 1);
});

test("a failed operation preserves unrelated work in the application's transaction", (t) => {
  const { db, store } = fixture(t);
  db.exec("BEGIN");
  db.prepare("INSERT INTO events (subject, kind) VALUES (?, ?)").run("other", "observed");
  assert.throws(() => store.commit(request, { execute: connection => {
    saveOutfit(connection);
    throw new Error("outfit validation failed");
  }, parseResult: parseOutfit }), /outfit validation failed/);
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);
  assert.equal(store.find(request, parseOutfit), undefined);
});

test("an operation ID cannot be reused for a changed decision or contract", (t) => {
  const { store, db } = fixture(t);
  store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  for (const changed of [
    { ...request, input: { itemIds: ["hat-9"], occasion: "studio" } },
    { ...request, input: { itemIds: ["boots-2", "coat-7"], occasion: "studio" } },
    { ...request, kind: "delete-outfit" }, { ...request, version: "2" },
  ]) {
    assert.throws(() => store.commit(changed, { execute: () => assert.fail("conflict executed"), parseResult: parseOutfit }),
      { code: "contract_conflict" });
    assert.throws(() => store.find(changed, parseOutfit), { code: "contract_conflict" });
  }
  const reordered = { ...request, input: { occasion: "studio", itemIds: ["coat-7", "boots-2"] } };
  assert.equal(store.commit(reordered, { execute: saveOutfit, parseResult: parseOutfit }).replayed, true);
  const separate = store.commit({ ...request, scope: "wardrobe:owner-b" }, { execute: saveOutfit, parseResult: parseOutfit });
  assert.equal(separate.replayed, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 2);
});

test("invalid or incompatible saved results cannot trigger a second effect or false success", (t) => {
  const { db, store } = fixture(t);
  store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  for (const invalid of ['{', '{"outfitId":"wrong","itemIds":[]}', null]) {
    db.prepare("UPDATE small_hour_operation_receipts SET result_json = ?").run(invalid);
    assert.throws(() => store.find(request, parseOutfit), { code: "invalid_receipt" });
    assert.throws(() => store.commit(request, { execute: () => assert.fail("damaged receipt reran action"), parseResult: parseOutfit }),
      { code: "invalid_receipt" });
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 1);
});

test("invalid input is rejected before any application code or receipt write", (t) => {
  const { db, store } = fixture(t);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [undefined, { missing: undefined }, { value: NaN }, { value: Infinity },
    { date: new Date() }, { bigint: 1n }, cycle, [, "boots-2"], { callback: () => "ignored" }]) {
    assert.throws(() => store.commit({ ...request, input }, {
      execute: () => assert.fail("invalid input reached effect"), parseResult: parseOutfit,
    }), { code: "invalid_request" });
  }
  for (const field of ["id", "scope", "kind", "version"] as const) {
    assert.throws(() => store.commit({ ...request, [field]: " " }, {
      execute: () => assert.fail("empty identity reached effect"), parseResult: parseOutfit,
    }), { code: "invalid_request" });
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM small_hour_operation_receipts").get()?.n, 0);
});

test("invalid results roll back the application mutation instead of creating an unreplayable receipt", (t) => {
  const { db, store } = fixture(t);
  for (const result of [{ outfitId: "invalid", itemIds: [] }, { outfitId: 1, itemIds: [undefined] }, undefined]) {
    assert.throws(() => store.commit(request, { execute: connection => {
      saveOutfit(connection);
      return result as unknown as Outfit;
    }, parseResult: parseOutfit }), { code: "invalid_result" });
    assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);
    assert.equal(store.find(request, parseOutfit), undefined);
  }
});

test("result validation cannot replace the saved operation result", (t) => {
  const { db, store } = fixture(t);
  const replace = (value: unknown): Outfit => ({ ...parseOutfit(value), itemIds: ["unselected-hat"] });
  assert.throws(() => store.commit(request, { execute: saveOutfit, parseResult: replace }), { code: "invalid_result" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);
  store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  assert.throws(() => store.find(request, replace), { code: "invalid_receipt" });
});

test("asynchronous work is rejected and a returned promise cannot commit local writes", async (t) => {
  const { db, store } = fixture(t);
  let started = false;
  const asynchronous = { execute: async () => { started = true; return saveOutfit(db); }, parseResult: parseOutfit };
  assert.throws(() => store.commit(request, asynchronous as unknown as LocalOperation<DatabaseSync, Outfit>),
    { code: "async_operation" });
  assert.equal(started, false);

  const promise = { execute: (connection: DatabaseSync) => Promise.resolve(saveOutfit(connection)), parseResult: parseOutfit };
  assert.throws(() => store.commit(request, promise as unknown as LocalOperation<DatabaseSync, Outfit>),
    { code: "async_operation" });
  await Promise.resolve();
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);
  assert.equal(store.find(request, parseOutfit), undefined);
});

test("recursive re-entry cannot perform the same operation twice", (t) => {
  const { db, store } = fixture(t);
  assert.throws(() => store.commit(request, { execute: connection => {
    saveOutfit(connection);
    return new SqliteOperationStore(connection).commit(request, {
      execute: () => assert.fail("recursive operation executed"), parseResult: parseOutfit,
    }).receipt.result;
  }, parseResult: parseOutfit }), { code: "invalid_receipt" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);
});

function worker(path: string, mode: string) {
  const script = fileURLToPath(new URL("./fixtures/operation-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, path, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  assert.ok(child.stdout && child.stderr);
  let output = "", errors = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const completed = once(child, "close").then(([code, signal]) => ({ code, signal, output, errors }));
  const ready = Promise.race([
    once(child, "message"),
    completed.then(result => { throw new Error(`Worker exited before ready: ${result.errors}`); }),
  ]);
  return { child, completed, ready };
}

test("two processes delivering the same request commit one outfit", { timeout: 10000 }, async (t) => {
  const { db, path } = fixture(t);
  const first = worker(path, "commit"), second = worker(path, "commit");
  t.after(() => { first.child.kill(); second.child.kill(); });
  await Promise.all([first.ready, second.ready]);
  first.child.send("go");
  second.child.send("go");
  const results = await Promise.all([first.completed, second.completed]);
  for (const result of results) assert.equal(result.code, 0, result.errors);
  const [a, b] = results.map(result => JSON.parse(result.output));
  assert.deepEqual(a.receipt, b.receipt);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 1);
});

test("process death inside a local operation leaves no partial effect or receipt", { timeout: 10000 }, async (t) => {
  const { db, path, store } = fixture(t);
  const attempt = worker(path, "crash");
  t.after(() => attempt.child.kill());
  await attempt.ready;
  attempt.child.send("go");
  const result = await attempt.completed;
  assert.equal(result.signal, "SIGKILL", result.errors);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 0);
  assert.equal(store.find(request, parseOutfit), undefined);
  const recovered = store.commit(request, { execute: saveOutfit, parseResult: parseOutfit });
  assert.equal(recovered.replayed, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outfits").get()?.n, 1);
});
