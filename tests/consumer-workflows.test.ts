import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { ModelProvider, ProviderRequest } from "../src/index.js";
import type { DeliverySink } from "../src/durable/sqlite.js";
import { selectionApp } from "./fixtures/selection-app.js";

const task = { scope: "owner:a", id: "outfit-1", kind: "select-outfit", version: "1", input: {
  ownerId: "a", candidateIds: ["coat-7", "boots-2"], request: "An outfit for the rain",
} };
const schedule = { concurrencyScope: "owner:a", dueAt: 100, maxAttempts: 3 };
const selected = ["boots-2", "coat-7"];
const receipt = { outfitId: "outfit-1", itemIds: selected };
const delivery = { ...task, id: "outfit-1:delivery", kind: "deliver-outfit", input: { ownerId: "a", ...receipt } };
const accepted = { status: "accepted" as const, receipt: { id: "inbox-9", evidence: { accepted: true } } };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-consumer-"));
  const path = join(directory, "app.sqlite"); const connections = new Set<DatabaseSync>();
  const requests: ProviderRequest[] = []; let sends = 0;
  const provider: ModelProvider = { name: "scripted", capabilities: { structuredOutput: true }, async complete(request) {
    requests.push({ ...structuredClone({ ...request, signal: undefined }), signal: request.signal });
    return { content: [{ type: "text", text: JSON.stringify({ itemIds: selected }) }], stopReason: "end_turn" };
  } };
  const sink: DeliverySink = { idempotency: "key", async send(product) {
    sends++; assert.deepEqual(product, delivery); return accepted;
  } };
  const open = () => {
    const db = new DatabaseSync(path); connections.add(db);
    const runner = selectionApp(db, provider, sink);
    return { db, runner, close() { db.close(); connections.delete(db); } };
  };
  const setup = new DatabaseSync(path);
  setup.exec(`CREATE TABLE owners (id TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
    CREATE TABLE items (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE outfits (id TEXT NOT NULL, owner_id TEXT NOT NULL, item_ids TEXT NOT NULL, PRIMARY KEY(owner_id,id));
    INSERT INTO owners VALUES ('a',1),('b',1);
    INSERT INTO items VALUES ('coat-7','a','Raincoat'),('boots-2','a','Waterproof boots'),('private-3','b','Private item');`);
  setup.close();
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, provider, sink, requests, sends: () => sends };
}

test("selection, receipt and exact output survive a lost delivery acknowledgement and restart", async t => {
  const f = fixture(t); const remote = new Map<string, unknown>(); const keys: string[] = [];
  f.sink.send = async (product, context) => {
    keys.push(context.idempotencyKey); assert.deepEqual(product, delivery);
    remote.set(context.idempotencyKey, structuredClone(product));
    if (keys.length === 1) throw new Error("acknowledgement lost");
    return accepted;
  };
  const first = f.open(); first.runner.enqueue(task, schedule);
  const created = await first.runner.runNext();
  assert.equal(created?.status, "completed");
  assert.deepEqual(created.steps[1].result, receipt);
  assert.deepEqual(JSON.parse(String(first.db.prepare("SELECT item_ids FROM outfits").get()?.item_ids)), selected);
  assert.equal((await first.runner.runNext())?.status, "uncertain");
  first.close();
  const restarted = f.open();
  assert.equal(await restarted.runner.runNext(), undefined);
  assert.equal((await restarted.runner.retryDelivery(delivery))?.status, "completed");
  assert.equal(f.requests.length, 1); assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1);
  assert.equal(remote.size, 1); assert.deepEqual([...remote.values()], [delivery]);
  const stored = restarted.runner.inspect(delivery)?.steps[0];
  assert.equal(stored?.kind, "delivery");
  assert.ok(stored?.kind === "delivery" && stored.delivery.status === "accepted");
  assert.deepEqual(stored.delivery.receipt, accepted.receipt);
  assert.equal(restarted.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 1);
  assert.equal(restarted.db.prepare("SELECT count(*) n FROM small_hour_operation_receipts").get()?.n, 1);
  assert.equal(await restarted.runner.runNext(), undefined);
  assert.deepEqual(f.requests[0].messages, [{ role: "user", content: JSON.stringify({
    request: task.input.request, items: [
      { id: "coat-7", description: "Raincoat" }, { id: "boots-2", description: "Waterproof boots" },
    ],
  }) }]);
  assert.deepEqual(f.requests[0].tools, []);
});

test("failed output staging rolls back the outfit and receipt while retaining the model result", async t => {
  const f = fixture(t); const first = f.open(); first.runner.enqueue(task, schedule);
  first.db.exec(`CREATE TRIGGER unavailable_output BEFORE INSERT ON small_hour_tasks
    WHEN NEW.kind='deliver-outfit' BEGIN SELECT RAISE(ABORT,'output storage unavailable'); END`);
  const failed = await first.runner.runNext();
  assert.equal(failed?.status, "failed");
  assert.equal(failed.steps[0].status, "completed");
  assert.equal(failed.steps[1].status, "not_started");
  assert.equal(first.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 0);
  assert.equal(first.db.prepare("SELECT count(*) n FROM small_hour_operation_receipts").get()?.n, 0);
  assert.equal(first.runner.inspect(delivery), undefined);
  first.close();
  const restarted = f.open();
  assert.equal(await restarted.runner.runNext(), undefined);
  assert.equal(f.requests.length, 1); assert.equal(f.sends(), 0);
});

test("ownership changed during selection preserves the result and prevents saving the outfit", async t => {
  const f = fixture(t); const first = f.open(); const complete = f.provider.complete;
  f.provider.complete = async request => {
    const response = await complete(request);
    first.db.prepare("UPDATE items SET owner_id='b' WHERE id='coat-7'").run();
    return response;
  };
  first.runner.enqueue(task, schedule);
  const rejected = await first.runner.runNext();
  assert.equal(rejected?.status, "rejected"); assert.equal(rejected.reason, "items_unavailable");
  assert.equal(rejected.steps[0].status, "completed");
  assert.equal(first.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 0);
  assert.equal(first.runner.inspect(delivery), undefined);
  assert.equal(f.requests.length, 1); assert.equal(f.sends(), 0);
});

test("a revoked destination after saving rejects delivery without erasing the outfit receipt", async t => {
  const f = fixture(t); const first = f.open(); first.runner.enqueue(task, schedule);
  assert.equal((await first.runner.runNext())?.status, "completed");
  first.db.prepare("UPDATE owners SET allowed=0 WHERE id='a'").run(); first.close();
  const restarted = f.open();
  assert.equal((await restarted.runner.runNext())?.status, "rejected");
  assert.deepEqual(restarted.runner.inspect(task)?.steps[1].result, receipt);
  assert.equal(restarted.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.sends(), 0);
});

test("unoffered or duplicate selections cannot save an outfit or be silently rerolled", async t => {
  for (const itemIds of [["coat-7", "private-3"], ["coat-7", "coat-7"]]) await t.test(JSON.stringify(itemIds), async t => {
    const f = fixture(t); let calls = 0;
    f.provider.complete = async () => {
      calls++; return { content: [{ type: "text", text: JSON.stringify({ itemIds }) }], stopReason: "end_turn" };
    };
    const first = f.open(); first.runner.enqueue(task, schedule);
    assert.equal((await first.runner.runNext())?.status, "uncertain");
    assert.equal(first.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 0);
    assert.equal(first.runner.inspect(delivery), undefined); first.close();
    const restarted = f.open(); assert.equal(await restarted.runner.runNext(), undefined);
    assert.equal(calls, 1); assert.equal(f.sends(), 0);
  });
});


test("a valid subset keeps the model's selection without filling in other offered items", async t => {
  const f = fixture(t);
  f.provider.complete = async () => ({ content: [{ type: "text", text: '{"itemIds":["boots-2"]}' }], stopReason: "end_turn" });
  const app = f.open(); app.runner.enqueue(task, schedule);
  const result = await app.runner.runNext();
  assert.equal(result?.status, "completed");
  assert.deepEqual(result.steps[1].result, { outfitId: "outfit-1", itemIds: ["boots-2"] });
  assert.equal(app.db.prepare("SELECT item_ids FROM outfits").get()?.item_ids, '["boots-2"]');
});

test("unavailable requested items stop before private context reaches the model", async t => {
  const f = fixture(t); const app = f.open();
  app.runner.enqueue({ ...task, input: { ...task.input, candidateIds: ["coat-7", "private-3"] } }, schedule);
  await assert.rejects(app.runner.runNext(), /items_unavailable/);
  assert.equal(f.requests.length, 0); assert.equal(f.sends(), 0);
  assert.equal(app.db.prepare("SELECT count(*) n FROM outfits").get()?.n, 0);
});

test("a mismatched task owner is rejected before context loading or delivery", async t => {
  const f = fixture(t); const app = f.open();
  app.runner.enqueue({ ...task, scope: "owner:b" }, schedule);
  const result = await app.runner.runNext();
  assert.equal(result?.status, "rejected");
  assert.equal(result.reason, "owner_mismatch");
  assert.equal(f.requests.length, 0); assert.equal(f.sends(), 0);
});
