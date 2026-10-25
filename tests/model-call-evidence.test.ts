import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider, type ModelCallRequest, type ProviderResponse, type TraceContent } from "../src/index.js";
import { SqliteModelCallStore, SqliteModelStepStore, type ModelSpendPolicy } from "../src/durable/sqlite.js";

const policy: ModelSpendPolicy = {
  quote: () => ({ scopes: [{ scope: "household", limit: 20 }, { scope: "application", limit: 100 }], amount: 10, pricing: { token: 1 } }),
  charge: tokens => tokens.freshInputTokens + tokens.outputTokens,
};
const usage = { model: "model-a", freshInputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
const response = { content: [{ type: "text" as const, text: '{"selection":"blue"}' }], stopReason: "end_turn" as const, usage, requestId: "provider-2" };
const input = { agentId: "application", turnId: "selection-1", input: "Choose from the supplied options.", allowedTools: [],
  trace: { traceId: "a".repeat(32), parentSpanId: "b".repeat(16) } };
function captured<T>(value: TraceContent | null): T {
  assert.equal(value?.status, "captured");
  assert.ok(value?.status === "captured");
  return value.value as T;
}
function runtime(store: SqliteModelCallStore, provider: ModelProvider) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Choose using the supplied taste."),
    memory: { load: async () => [{ role: "assistant" as const, content: "Earlier choice: red." }] }, modelCalls: store.hooks(policy),
    retry: { attempts: 2, delayMs: () => 0 } });
}

test("a retried decision retains both calls, their actual context and one charge across restart without a diagnostic sink", async t => {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-calls-")), path = join(directory, "app.sqlite");
  let db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new SqliteModelCallStore(db, { content: { maxBytes: 16_384 },
    attributes: () => ({ workflow: "selection", promptVersion: "1", sourceId: "source-1" }) }); store.initialize();
  let attempts = 0;
  const result = await runtime(store, { name: "provider", model: "model-a", isRetryable: () => true,
    failureInfo: () => ({ status: "rejected", requestId: "provider-1" }), async complete(request) {
      assert.equal(store.inspectBudget("household").reservedAmount, 10);
      assert.deepEqual(request.messages, [{ role: "assistant", content: "Earlier choice: red." }, { role: "user", content: input.input }]);
      if (++attempts === 1) throw new Error("private provider error payload");
      return response;
    } }).turn(input);
  db.close(); db = new DatabaseSync(path);
  const reopened = new SqliteModelCallStore(db);
  const saved = result.modelCalls.map(call => reopened.inspect(call.callId)!);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(call => call.status), ["rejected", "accepted"]);
  assert.equal(saved[0].request.status, "captured");
  assert.equal(captured<ModelCallRequest>(saved[0].request).system[0].text, "Choose using the supplied taste.");
  assert.deepEqual(captured<ModelCallRequest>(saved[0].request).messages, [{ role: "assistant", content: "Earlier choice: red." }, { role: "user", content: input.input }]);
  assert.deepEqual(saved[1].request, saved[0].request);
  assert.deepEqual(saved[1].attributes, { workflow: "selection", promptVersion: "1", sourceId: "source-1" });
  assert.deepEqual(captured<ProviderResponse>(saved[1].response), response);
  assert.equal(saved[0].failure?.code, "provider_failed");
  assert.equal(saved[0].response, null);
  assert.equal(saved[1].failure, null);
  assert.equal(saved[1].checks.output.verdict, "accepted");
  assert.ok(saved[0].finishedAt! >= saved[0].createdAt!);
  assert.deepEqual(saved.map(call => call.context.trace?.traceId), [input.trace.traceId, input.trace.traceId]);
  assert.notEqual(saved[0].context.trace?.spanId, saved[1].context.trace?.spanId);
  assert.equal(JSON.stringify(saved).includes("private provider error payload"), false);
  assert.deepEqual(reopened.inspectBudget("household"), { acceptedAmount: 3, reservedAmount: 0, unknownAmount: 0, totalAmount: 3 });
  assert.equal(reopened.inspectBudget("application").totalAmount, 3);
  const newer = await runtime(new SqliteModelCallStore(db, { content: { maxBytes: 16_384 } }), {
    name: "provider", model: "model-b", async complete() { return { ...response, usage: { ...usage, model: "model-b" } }; },
  }).turn({ ...input, turnId: "selection-2" });
  assert.equal(reopened.inspect(newer.modelCalls[0].callId)?.context.model, "model-b");
  assert.deepEqual(result.modelCalls.map(call => reopened.inspect(call.callId)), saved);
  assert.equal(reopened.inspectBudget("household").totalAmount, 6);
});

test("an invalid model selection remains inspectable while a recovered accepted selection replays without a new call", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = new SqliteModelCallStore(db, { content: { maxBytes: 16_384 } }), steps = new SqliteModelStepStore(db);
  store.initialize(); steps.initialize(); let calls = 0;
  const runner = runtime(store, { name: "provider", model: "model-a", capabilities: { structuredOutput: true }, async complete() {
    return { ...response, content: [{ type: "text", text: ++calls === 1 ? '{"selection":"missing"}' : '{"selection":"blue"}' }] };
  } });
  const request = { scope: "app", id: "choose", kind: "selection", version: "1", input: { choices: ["blue"] } };
  const turn = { agentId: input.agentId, input: input.input, structuredOutput: { schema: { type: "object" }, parse(value: unknown) {
    if (!value || typeof value !== "object" || !("selection" in value) || value.selection !== "blue") throw new Error("Not an offered option.");
    return value;
  } } };
  const options = { recovery: { sideEffectFree: true as const, maxAttempts: 2, maxModelCalls: 2 } };
  await assert.rejects(steps.run(request, runner, turn, options), { code: "structured_output_invalid" });
  const failed = steps.inspect(request)!;
  const rejected = store.inspect(failed.report.modelCalls[0].callId)!;
  assert.deepEqual(captured<ProviderResponse>(rejected.response).content[0], { type: "text", text: '{"selection":"missing"}' });
  assert.equal(rejected.checks.structured_output.verdict, "rejected");
  assert.equal(rejected.chargedAmount, 3);
  const recovered = await steps.recover(request, runner, turn, { action: "retry", checkpoint: failed.checkpoint,
    reason: "Invalid selection", evidence: { offered: ["blue"] } });
  const replay = await steps.run(request, runner, turn, options);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, recovered.result);
  assert.equal(calls, 2); assert.equal(store.inspectBudget("household").totalAmount, 6);
  assert.equal((store.inspect(recovered.result.modelCalls[0].callId)!).checks.structured_output.verdict, "accepted");
});

test("denied calls retain the proposed input and reason without dispatch while disabled capture keeps content out of storage", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = new SqliteModelCallStore(db, { content: { maxBytes: 16_384 } }); store.initialize();
  let dispatched = 0;
  const provider: ModelProvider = { name: "provider", async complete() { dispatched++; return response; } };
  const denied = new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Process."), memory: new EmptyMemorySource(),
    modelCalls: store.hooks({ ...policy, quote: () => ({ denied: true, scopes: ["household"], reason: "paused", evidence: "policy-1" }) }) });
  await assert.rejects(denied.turn(input), { code: "model_call_denied" });
  const id = String(db.prepare("SELECT call_id FROM model_calls").get()!.call_id);
  const record = store.inspect(id)!;
  assert.equal(dispatched, 0); assert.equal(record.denial?.reason, "paused");
  assert.equal(captured<ModelCallRequest>(record.request).messages[0].content, input.input);
  assert.equal(record.response, null); assert.equal(record.chargedAmount, 0);
  const privateStore = new SqliteModelCallStore(db);
  const result = await runtime(privateStore, provider).turn({ ...input, turnId: "private", input: "Private example." });
  const privateCall = privateStore.inspect(result.modelCalls[0].callId)!;
  assert.deepEqual(privateCall.request, { status: "omitted", reason: "disabled" });
  assert.deepEqual(privateCall.response, { status: "omitted", reason: "disabled" });
  assert.equal(JSON.stringify(privateCall).includes("Private example."), false);
  const limited = new SqliteModelCallStore(db, { content: { maxBytes: 1 } });
  const large = await runtime(limited, provider).turn({ ...input, turnId: "large" });
  const omitted = limited.inspect(large.modelCalls[0].callId)!;
  assert.equal(omitted.request.status, "omitted");
  assert.ok(omitted.request.status === "omitted" && omitted.request.reason === "size_limit");
  assert.ok(omitted.request.bytes > omitted.request.maxBytes);
  assert.equal(omitted.chargedAmount, 3);
});
