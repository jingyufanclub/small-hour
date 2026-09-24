import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type TraceEvent } from "../src/index.js";
import { SqliteModelStepStore } from "../src/durable/model-steps.js";

test("persisted trace evidence survives restart, authorized recovery, and completed replay", async t => {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-trace-")), path = join(directory, "app.sqlite");
  let db = new DatabaseSync(path); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  let store = new SqliteModelStepStore(db); store.initialize();
  const events: TraceEvent[] = []; let calls = 0;
  const runtime = new SmallHourRuntime({ persona: new StaticPersonaSource("Extract"), memory: new EmptyMemorySource(),
    provider: { name: "fixture", async complete() {
      return { content: [{ type: "text", text: ++calls === 1 ? "partial" : "accepted" }], stopReason: calls === 1 ? "max_tokens" : "end_turn" };
    } }, tracing: { sink: { record: event => { events.push(event); } } } });
  const request = { scope: "app", id: "extract", kind: "extract", version: "1", input: {} };
  const turn = { agentId: "agent", input: "extract", allowedTools: [], trace: { traceId: "a".repeat(32), parentSpanId: "b".repeat(16) } };
  const options = { recovery: { sideEffectFree: true as const, maxAttempts: 2, maxModelCalls: 2 } };
  await assert.rejects(store.run(request, runtime, turn, options), { code: "incomplete_stop" });
  const first = store.inspect(request)!;
  assert.equal(first.report.trace?.traceId, turn.trace.traceId);
  db.close(); db = new DatabaseSync(path); store = new SqliteModelStepStore(db);
  const result = await store.recover(request, runtime, turn, { action: "retry", checkpoint: first.checkpoint,
    reason: "Incomplete output", evidence: { reviewed: true } });
  const state = store.inspect(request)!;
  assert.ok(result.result.trace);
  assert.equal(result.result.trace.traceId, turn.trace.traceId);
  assert.notEqual(result.result.trace.spanId, first.report.trace?.spanId);
  assert.deepEqual(state.attempts[0].report.trace, first.report.trace);
  assert.equal(state.report.modelCalls[0].trace?.traceId, turn.trace.traceId);
  const count = events.length;
  const replay = await store.run(request, runtime, turn, options);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.result, result.result);
  assert.equal(calls, 2); assert.equal(events.length, count);
});

test("saved trace records reject a model span with no matching parent turn", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new SqliteModelStepStore(db); store.initialize();
    const request = { scope: "app", id: "extract", kind: "extract", version: "1", input: {} };
    const runtime = new SmallHourRuntime({ persona: new StaticPersonaSource("Extract"), memory: new EmptyMemorySource(),
      provider: { name: "fixture", async complete() { return { content: [], stopReason: "max_tokens" }; } },
      tracing: { sink: { record() {} } } });
    await assert.rejects(store.run(request, runtime, { agentId: "agent", input: "extract" }), { code: "incomplete_stop" });
    const row = db.prepare("SELECT report_json FROM small_hour_model_steps").get() as { report_json: string };
    const report = JSON.parse(row.report_json);
    report.modelCalls[0].trace.parentSpanId = "c".repeat(16);
    db.prepare("UPDATE small_hour_model_steps SET report_json = ?").run(JSON.stringify(report));
    assert.throws(() => store.inspect(request), { code: "invalid_checkpoint" });
  } finally { db.close(); }
});
