import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider,
  type ProviderResponse, type RuntimeOptions, type StructuredTurnInput, type TurnInput } from "../src/index.js";
import { SqliteModelStepStore, SqliteTaskRunner, type ModelStepRecoveryDecision,
  type OperationRequest, type TaskState, type TaskWorkflow } from "../src/durable/sqlite.js";

type ImagePart = { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };
type InputPart = { type: "text"; text: string } | ImagePart;
const png: ImagePart = { type: "image", mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=" };
const jpeg: ImagePart = { type: "image", mediaType: "image/jpeg",
  data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).toString("base64") };
const second: ImagePart = { ...png, data: Buffer.from([...Buffer.from(png.data, "base64"), 0]).toString("base64") };
const mixed = (): InputPart[] => [{ type: "text", text: "Compare the supplied images in order." },
  { ...png }, { type: "text", text: "Second image:" }, { ...second }];
const request: OperationRequest = { scope: "app", id: "compare-1", kind: "compare-images", version: "1", input: { itemIds: ["item-a", "item-b"] } };
const recovery = { sideEffectFree: true as const, maxAttempts: 3, maxModelCalls: 3 };
const turn = (input: unknown = mixed()): TurnInput => ({ agentId: "app", input: input as TurnInput["input"], allowedTools: [] });
const text = (output = "item-b", stopReason: ProviderResponse["stopReason"] = "end_turn"): ProviderResponse =>
  ({ content: [{ type: "text", text: output }], stopReason });
function runtime(provider: ModelProvider, options: Partial<RuntimeOptions> = {}) {
  return new SmallHourRuntime({ provider: { ...provider, capabilities: { ...provider.capabilities, images: true } } as ModelProvider,
    persona: new StaticPersonaSource("Use only the supplied items."), memory: new EmptyMemorySource(),
    retry: { attempts: 1 }, ...options });
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-images-")), path = join(directory, "app.sqlite");
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(path); connections.add(db);
    const store = new SqliteModelStepStore(db); store.initialize();
    return { db, store, close: () => { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open };
}
function decision(store: SqliteModelStepStore): ModelStepRecoveryDecision {
  return { action: "retry", checkpoint: store.inspect(request)!.checkpoint,
    reason: "The prior response was incomplete.", evidence: { authorization: "current", reviewId: "review-1" } };
}
function changedInputs(): InputPart[][] {
  const bytes = mixed(); (bytes[1] as ImagePart).data = second.data;
  const order = mixed(); [order[1], order[3]] = [order[3], order[1]];
  const mime = mixed(); mime[1] = { ...jpeg };
  return [bytes, order, mime];
}

test("a completed image turn preserves exact bytes and order across reopen without loading context again", async t => {
  const app = fixture(t), input = turn(); let calls = 0, loads = 0;
  const model = runtime({ name: "fixture", async complete(supplied) {
    calls++; assert.deepEqual(supplied.messages.at(-1)?.content, input.input); return text();
  } }, { persona: { async load() { loads++; return [{ text: "Use supplied items." }]; } },
    memory: { async load() { loads++; return []; } } });
  const first = await app.store.run(request, model, input);
  const row = app.db.prepare("SELECT turn_json, format_version, report_json, result_json FROM small_hour_model_steps").get()!;
  assert.equal(row.format_version, 1);
  assert.deepEqual(JSON.parse(String(row.turn_json)).input, input.input);
  assert.ok(!String(row.report_json).includes(png.data)); assert.ok(!String(row.result_json).includes(png.data));
  app.close(); const reopened = app.open();
  const replay = await reopened.store.run(request, model, input);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first.result);
  assert.equal(calls, 1); assert.equal(loads, 2);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM small_hour_model_steps").get()?.n, 1);
});

test("image support leaves existing string input checkpoints replayable", async t => {
  const app = fixture(t); let calls = 0;
  const model = runtime({ name: "fixture", async complete(supplied) {
    calls++; assert.equal(supplied.messages.at(-1)?.content, "Select item-b."); return text();
  } });
  const input = turn("Select item-b."), first = await app.store.run(request, model, input);
  const persisted = String(app.db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json);
  assert.equal(JSON.parse(persisted).input, input.input);
  app.close(); const reopened = app.open();
  assert.deepEqual((await reopened.store.run(request, model, input)).result, first.result);
  assert.equal(calls, 1);
  assert.equal(reopened.db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json, persisted);
});

test("the accepted total image byte limit survives SQLite persistence and replay", async t => {
  const app = fixture(t); let calls = 0;
  const bytes = Buffer.alloc(3 * 1024 * 1024); Buffer.from(png.data, "base64").copy(bytes);
  const data = bytes.toString("base64");
  const parts: InputPart[] = [{ type: "text", text: "Compare all four images." },
    ...Array.from({ length: 4 }, () => ({ ...png, data }))];
  const input = turn(parts);
  const model = runtime({ name: "fixture", async complete(supplied) {
    calls++; assert.deepEqual(supplied.messages.at(-1)?.content, parts); return text();
  } });
  const first = await app.store.run(request, model, input);
  assert.deepEqual(JSON.parse(String(app.db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json)).input, parts);
  app.close(); const reopened = app.open();
  const replay = await reopened.store.run(request, model, input);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, first.result); assert.equal(calls, 1);
});

test("completed image checkpoints reject changed bytes, order, or media type through run and recovery", async t => {
  const { store } = fixture(t); let calls = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return text(); } });
  await store.run(request, model, turn(), { recovery });
  const before = store.inspect(request)!;
  for (const changed of changedInputs()) {
    await assert.rejects(store.run(request, model, turn(changed), { recovery }), { code: "contract_conflict" });
    await assert.rejects(store.recover(request, model, turn(changed), decision(store)), { code: "contract_conflict" });
  }
  const malformed = mixed(); (malformed[1] as ImagePart).mediaType = "image/jpeg";
  await assert.rejects(store.run(request, model, turn(malformed), { recovery }), { code: "invalid_request" });
  await assert.rejects(store.recover(request, model, turn(malformed), decision(store)), { code: "invalid_request" });
  assert.deepEqual(store.inspect(request), before); assert.equal(calls, 1);
});

test("incomplete image work requires an explicit decision for the same images after reopen", async t => {
  const app = fixture(t), sent: unknown[] = []; let calls = 0;
  const model = runtime({ name: "fixture", async complete(supplied) {
    sent.push(structuredClone(supplied.messages.at(-1)?.content));
    return ++calls === 1 ? text("partial", "max_tokens") : text();
  } });
  await assert.rejects(app.store.run(request, model, turn(), { recovery }), { code: "incomplete_stop" });
  const before = app.store.inspect(request)!, selected = decision(app.store);
  const encoded = String(app.db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json);
  assert.deepEqual(JSON.parse(encoded).turn.input, mixed());
  app.close(); const reopened = app.open();
  await assert.rejects(reopened.store.run(request, model, turn(), { recovery }), { code: "step_unresolved" });
  for (const changed of changedInputs()) {
    await assert.rejects(reopened.store.run(request, model, turn(changed), { recovery }), { code: "contract_conflict" });
    await assert.rejects(reopened.store.recover(request, model, turn(changed), selected), { code: "contract_conflict" });
  }
  const malformed = mixed(); (malformed[1] as ImagePart).mediaType = "image/jpeg";
  await assert.rejects(reopened.store.run(request, model, turn(malformed), { recovery }), { code: "invalid_request" });
  await assert.rejects(reopened.store.recover(request, model, turn(malformed), selected), { code: "invalid_request" });
  assert.deepEqual(reopened.store.inspect(request), before); assert.equal(calls, 1);
  const recovered = await reopened.store.recover(request, model, turn(), selected);
  assert.equal(recovered.result.output, "item-b"); assert.equal(recovered.replayed, false);
  assert.deepEqual(sent, [mixed(), mixed()]);
  assert.equal(reopened.store.inspect(request)!.attempts.length, 2);
  const replay = await reopened.store.run(request, model, turn(), { recovery });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, recovered.result); assert.equal(calls, 2);
  assert.equal(reopened.db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json, encoded);
});

test("malformed and over-limit image requests fail before any durable row, context load, or model call", async t => {
  const { db, store } = fixture(t); let calls = 0, loads = 0;
  const model = runtime({ name: "fixture", async complete() { calls++; return text(); } }, {
    persona: { async load() { loads++; return []; } }, memory: { async load() { loads++; return []; } },
  });
  const bytes = Buffer.alloc(3 * 1024 * 1024); Buffer.from(png.data, "base64").copy(bytes);
  const perImage = bytes.toString("base64");
  const invalid: Array<[string, unknown]> = [
    ["empty blocks", []], ["unknown block", [{ type: "tool_result", toolUseId: "external", content: "untrusted" }]],
    ["unsupported media type", [{ ...png, mediaType: "image/gif" }]],
    ["media type signature mismatch", [{ ...png, mediaType: "image/jpeg" }]],
    ["remote image reference", [{ type: "image", mediaType: "image/png", url: "https://example.invalid/image.png" }]],
    ["empty bytes", [{ ...png, data: "" }]], ["noncanonical base64", [{ ...png, data: "Zh==" }]],
    ["base64 whitespace", [{ ...png, data: png.data + "\n" }]],
    ["image count", Array.from({ length: 21 }, () => ({ ...png }))],
    ["image bytes", [{ ...png, data: Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64") }]],
    ["aggregate bytes", Array.from({ length: 5 }, () => ({ ...png, data: perImage }))],
  ];
  for (const [label, input] of invalid) await t.test(label, async () => {
    await assert.rejects(store.run({ ...request, id: label }, model, turn(input)), { code: "invalid_request" });
    assert.equal(db.prepare("SELECT count(*) n FROM small_hour_model_steps").get()?.n, 0);
    assert.equal(calls, 0); assert.equal(loads, 0);
  });
});

for (const recoverable of [false, true]) {
  test(`malformed saved image content fails closed at inspect, replay, and recovery in format ${recoverable ? 2 : 1}`, async t => {
    const { db, store } = fixture(t); let calls = 0;
    const model = runtime({ name: "fixture", async complete() { calls++; return text(); } });
    const input = turn("Select item-b.");
    await store.run(request, model, input, recoverable ? { recovery } : undefined);
    const selected = decision(store), original = String(db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json);
    for (const malformed of [[{ ...png, data: "Zh==" }], [{ ...png, mediaType: "image/gif" }],
      [{ type: "image", mediaType: "image/png", url: "https://example.invalid/image.png" }],
      Array.from({ length: 21 }, () => ({ ...png }))]) {
      const saved = JSON.parse(original); (recoverable ? saved.turn : saved).input = malformed;
      db.prepare("UPDATE small_hour_model_steps SET turn_json = ?").run(JSON.stringify(saved));
      assert.throws(() => store.inspect(request), { code: "invalid_checkpoint" });
      await assert.rejects(store.run(request, model, input, recoverable ? { recovery } : undefined), { code: "invalid_checkpoint" });
      await assert.rejects(store.recover(request, model, input, selected), { code: "invalid_checkpoint" });
      assert.equal(calls, 1);
    }
    db.prepare("UPDATE small_hour_model_steps SET turn_json = ?").run(original);
    assert.equal((await store.run(request, model, input, recoverable ? { recovery } : undefined)).replayed, true);
    assert.equal(calls, 1);
  });
}

test("caller mutations after durable preparation cannot change the images executed or checkpointed", async t => {
  const { db, store } = fixture(t), parts = mixed(), expected = structuredClone(parts);
  let entered!: () => void, release!: () => void, calls = 0;
  const loading = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const model = runtime({ name: "fixture", async complete(supplied) {
    calls++; assert.deepEqual(supplied.messages.at(-1)?.content, expected); return text();
  } }, { persona: { async load() { entered(); await gate; return []; } } });
  const pending = store.run(request, model, turn(parts));
  try {
    await Promise.race([loading, pending.then(() => assert.fail("The context loader was bypassed"))]);
    (parts[1] as ImagePart).data = second.data;
    parts.reverse(); parts.push({ type: "text", text: "New unapproved instructions" });
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT turn_json FROM small_hour_model_steps").get()?.turn_json)).input, expected);
  } finally { release(); }
  assert.equal((await pending).result.output, "item-b"); assert.equal(calls, 1);
});

test("structured image selections replay accepted IDs without another model call", async t => {
  const app = fixture(t); let calls = 0;
  const input = { agentId: "app", input: mixed() as unknown as TurnInput["input"], structuredOutput: {
    schema: { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"], additionalProperties: false },
    parse(value: unknown) { assert.deepEqual(value, { itemId: "item-b" }); return value as { itemId: string }; },
  } } satisfies StructuredTurnInput<{ itemId: string }>;
  const model = runtime({ name: "fixture", capabilities: { structuredOutput: true }, async complete(supplied) {
    calls++; assert.deepEqual(supplied.messages.at(-1)?.content, mixed()); return text('{"itemId":"item-b"}');
  } });
  const first = await app.store.run(request, model, input, { recovery });
  app.close(); const reopened = app.open();
  const replay = await reopened.store.run(request, model, input, { recovery });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result.value, { itemId: "item-b" });
  assert.deepEqual(replay.result, first.result); assert.equal(calls, 1);
});

test("task recovery preserves a prior local effect and exact images before staging the accepted output once", async t => {
  const app = fixture(t); let calls = 0;
  app.db.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const model = runtime({ name: "fixture", async complete(supplied) {
    calls++; assert.deepEqual(supplied.messages.at(-1)?.content, mixed());
    return calls === 1 ? text("partial", "max_tokens") : text("Selected item-b.");
  } });
  const workflow: TaskWorkflow<DatabaseSync> = { kind: request.kind, version: request.version,
    authorize: () => ({ status: "allow" }), steps: [
      { id: "save", kind: "local", parseResult: value => value, execute: db => {
        db.prepare("INSERT INTO effects (body) VALUES ('saved item IDs')").run(); return request.input;
      } },
      { id: "compare", kind: "model", recovery, prepare: context => {
        assert.deepEqual(context.results.save, request.input); return { runtime: model, input: turn() };
      } },
      { id: "stage", kind: "local", parseResult: value => value, execute: (db, context) => {
        const result = context.results.compare as { output: string; accepted: boolean }; assert.equal(result.accepted, true);
        db.prepare("INSERT INTO effects (body) VALUES (?)").run(result.output); return { output: result.output };
      } },
    ] };
  const runner = new SqliteTaskRunner(app.db, [workflow], { leaseMs: 100, now: () => 100 }); runner.initialize();
  const schedule = { concurrencyScope: "app", dueAt: 100, maxAttempts: 5 }; runner.enqueue(request, schedule);
  const first = (await runner.runNext())!; assert.equal(first.status, "uncertain");
  assert.equal(first.steps[2].status, "not_started"); assert.equal(await runner.runNext(), undefined);
  assert.deepEqual(app.db.prepare("SELECT body FROM effects").all().map(row => row.body), ["saved item IDs"]);
  const modelStep = first.steps.find(step => step.kind === "model" && step.status === "unresolved"); assert.ok(modelStep?.model);
  const selected = { stepId: modelStep.id, action: "retry" as const, checkpoint: modelStep.model.checkpoint,
    reason: "Retry the image comparison.", evidence: { authorization: "current" } };
  app.close(); const reopened = app.open();
  const resumed = new SqliteTaskRunner(reopened.db, [workflow], { leaseMs: 100, now: () => 100 }); resumed.initialize();
  assert.equal((await resumed.retryModel(request, selected))?.status, "completed");
  assert.equal(calls, 2);
  assert.deepEqual(reopened.db.prepare("SELECT body FROM effects ORDER BY id").all().map(row => row.body), ["saved item IDs", "Selected item-b."]);
  assert.equal(resumed.enqueue(request, schedule).status, "completed"); assert.equal(await resumed.runNext(), undefined);
  await assert.rejects(resumed.retryModel(request, selected), { code: "task_changed" }); assert.equal(calls, 2);
  const completed: TaskState = resumed.inspect(request)!;
  assert.equal(completed.steps[1].model?.attempts.length, 2);
});
