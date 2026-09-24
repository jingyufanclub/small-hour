import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry } from "small-hour";
import { SqliteModelSpendStore, SqliteModelStepStore, SqliteOperationStore } from "small-hour/durable/sqlite";

const scope = "synthetic-investigation:run-1";
const usage = { model: "synthetic", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 };
const evidence = { evidenceId: "evidence-1", sourceId: "source-a", queryId: "query-1", state: "delayed" };
const request = { scope, id: "gather", kind: "gather-evidence", version: "1", input: { sourceId: "source-a", queryId: "query-1" } };
const receiptRequest = { ...request, id: "read-query-1", kind: "capture-evidence" };
const input = { agentId: "investigator", input: "Read source-a for query-1.", allowedTools: ["read_evidence"],
  trace: { traceId: "a".repeat(32) } };
const toolResponse = { content: [{ type: "tool_use", id: "read-1", name: "read_evidence", input: request.input }],
  stopReason: "tool_use", nativeStopReason: "tool_use", usage };
const finalResponse = { content: [{ type: "text", text: "Source-a reports delayed work; evidence-1." }],
  stopReason: "end_turn", nativeStopReason: "end_turn", usage };

function parseEvidence(value) {
  assert.deepEqual(value, evidence);
  return value;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-consumer-durable-"));
  const path = join(directory, "application.sqlite");
  const connections = new Set();
  function open() {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    connections.add(db);
    const spend = new SqliteModelSpendStore(db), steps = new SqliteModelStepStore(db), operations = new SqliteOperationStore(db);
    spend.initialize(); steps.initialize(); operations.initialize();
    return { db, spend, steps, operations, close() { db.close(); connections.delete(db); } };
  }
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const app = open();
  app.db.exec("CREATE TABLE source_evidence (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  app.db.prepare("INSERT INTO source_evidence VALUES (?, ?)").run(evidence.evidenceId, JSON.stringify(evidence));
  return { ...app, open, path };
}

function policy(limit = 30) {
  return { quote: () => ({ scope, limit, amount: 10, pricing: { revision: "synthetic-1" } }),
    charge: tokens => tokens.freshInputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens + tokens.outputTokens };
}

function runtime(app, provider, options = {}) {
  return new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Inspect only the selected source and cite supplied evidence IDs."),
    memory: new EmptyMemorySource(), modelCalls: app.spend.hooks(policy()), retry: { attempts: 1, delayMs: () => 0 }, ...options });
}

function checkedProvider(observer, complete, options = {}) {
  const entries = [];
  return { entries, provider: { name: "synthetic", capabilities: { structuredOutput: true }, ...options,
    async complete(value) {
      const rows = observer.db.prepare("SELECT call_id FROM small_hour_model_spend WHERE status = 'reserved'").all();
      assert.equal(rows.length, 1, "each dispatch must see exactly its committed reservation from another connection");
      const call = observer.spend.inspect(rows[0].call_id);
      assert.equal(call.status, "reserved");
      assert.equal(call.quote.scope, scope);
      assert.equal(call.quote.amount, 10);
      assert.ok(!entries.includes(call.context.callId), "each dispatch needs a fresh admitted call ID");
      entries.push(call.context.callId);
      return await complete(value, call);
    },
  } };
}

function readTool(app, onRead = () => {}) {
  return new ToolRegistry([{ name: "read_evidence", description: "Read the selected source evidence.", mode: "read",
    inputSchema: { type: "object", properties: { sourceId: { type: "string" }, queryId: { type: "string" } },
      required: ["sourceId", "queryId"], additionalProperties: false },
    parse(value) { assert.deepEqual(value, request.input); return value; },
    execute(_value, context) {
      const saved = app.operations.commit(receiptRequest, {
        execute(db) {
          onRead();
          return JSON.parse(db.prepare("SELECT value_json FROM source_evidence WHERE id = ?").get(evidence.evidenceId).value_json);
        }, parseResult: parseEvidence,
      });
      context.recordReceipt(saved.receipt.id);
      return saved.receipt.result;
    },
  }]);
}

test("definite provider rejection frees its committed reservation before a distinct retry", async t => {
  const app = fixture(t), observer = app.open();
  const { provider, entries } = checkedProvider(observer, async (_value, call) => {
    assert.equal(observer.spend.inspectBudget(scope).reservedAmount, 10);
    if (entries.length === 1) throw new Error("provider rejected before processing");
    assert.equal(observer.spend.inspect(entries[0]).status, "rejected");
    assert.equal(call.context.attempt, 2);
    return finalResponse;
  }, { isRetryable: () => true, failureInfo: () => ({ status: "rejected", requestId: "rejected-request-1" }) });
  const result = await app.steps.run(request, runtime(app, provider, {
    modelCalls: app.spend.hooks(policy(10)), retry: { attempts: 2, delayMs: () => 0 },
  }), { ...input, allowedTools: [] });
  assert.equal(entries.length, 2);
  assert.deepEqual(result.result.modelCalls.map(call => call.callId), entries);
  assert.deepEqual(entries.map(id => observer.spend.inspect(id).status), ["rejected", "accepted"]);
  assert.equal(observer.spend.inspectBudget(scope).totalAmount, 3);
});

test("an unknown provider outcome survives reopen and denies a retry while retaining exposure", async t => {
  const app = fixture(t), observer = app.open();
  const { provider, entries } = checkedProvider(observer, async () => { throw new Error("response lost after submission"); },
    { isRetryable: () => true });
  await assert.rejects(app.steps.run(request, runtime(app, provider, {
    modelCalls: app.spend.hooks(policy(10)), retry: { attempts: 3, delayMs: () => 0 },
  }), { ...input, allowedTools: [] }), { code: "model_call_denied" });
  assert.equal(entries.length, 1);
  const state = app.steps.inspect(request);
  assert.deepEqual(state.report.modelCalls.map(call => call.status), ["unknown", "not_started"]);
  app.close(); observer.close();
  const reopened = app.open();
  assert.deepEqual(reopened.steps.inspect(request), state);
  assert.equal(reopened.spend.inspect(entries[0]).status, "unknown");
  assert.equal(reopened.spend.inspect(state.report.modelCalls[1].callId).status, "denied");
  assert.deepEqual(reopened.spend.inspectBudget(scope), { acceptedAmount: 0, reservedAmount: 0, unknownAmount: 10, totalAmount: 10 });
});

test("gathering and tool-free synthesis share one budget and denial happens before synthesis dispatch", async t => {
  const app = fixture(t), observer = app.open();
  let reads = 0, synthesisCalls = 0, parsed = 0;
  const gathering = checkedProvider(observer, async () => gathering.entries.length === 1 ? toolResponse : finalResponse);
  const gathered = await app.steps.run(request, runtime(app, gathering.provider, {
    tools: readTool(app, () => { reads++; }), modelCalls: app.spend.hooks(policy(13)),
  }), input);
  assert.equal(gathered.result.accepted, true);
  assert.equal(gathering.entries.length, 2);
  const synthesis = { ...request, id: "synthesize", kind: "synthesize-report", input: { evidenceIds: [evidence.evidenceId] } };
  const model = runtime(app, { name: "synthetic", capabilities: { structuredOutput: true }, async complete() {
    synthesisCalls++; return { ...finalResponse, content: [{ type: "text", text: '{"evidenceIds":["evidence-1"]}' }] };
  } }, { modelCalls: app.spend.hooks(policy(13)) });
  await assert.rejects(app.steps.run(synthesis, model, { agentId: input.agentId, input: JSON.stringify(evidence), trace: input.trace,
    structuredOutput: { schema: { type: "object", properties: { evidenceIds: { type: "array", items: { type: "string" } } } },
      parse(value) { parsed++; return value; } },
  }), { code: "model_call_denied" });
  assert.equal(synthesisCalls, 0); assert.equal(parsed, 0); assert.equal(reads, 1);
  assert.equal(observer.spend.inspectBudget(scope).totalAmount, 6);
  const denied = observer.steps.inspect(synthesis).report.modelCalls[0];
  assert.equal(denied.status, "not_started");
  assert.equal(observer.spend.inspect(denied.callId).status, "denied");
  assert.deepEqual(observer.operations.find(receiptRequest, parseEvidence).result, evidence);
});

for (const [reason, nativeReason, code] of [
  ["refusal", "refusal", "provider_refused"],
  ["max_tokens", "max_tokens", "incomplete_stop"],
  ["context_limit", "model_context_window_exceeded", "incomplete_stop"],
  ["pause", "pause_turn", "incomplete_stop"],
  ["unknown", "future_provider_stop", "incomplete_stop"],
]) {
  test(`a ${reason} stop preserves exact usage and native evidence across reopen without continuing`, async t => {
    const app = fixture(t), observer = app.open();
    let outputChecks = 0, synthesisCalls = 0;
    const { provider, entries } = checkedProvider(observer, async () => ({ ...finalResponse,
      stopReason: reason, nativeStopReason: nativeReason, requestId: `request-${reason}`,
    }));
    const model = runtime(app, provider, { tools: readTool(app, () => assert.fail("stopped output cannot cause a read")),
      retry: { attempts: 3, delayMs: () => 0, retryable: () => true },
      outputPolicy: { apply() { outputChecks++; return { accepted: true, output: "accepted" }; } },
    });
    await assert.rejects(async () => {
      await app.steps.run(request, model, input);
      synthesisCalls++;
    }, { code });
    const state = app.steps.inspect(request);
    assert.equal(state.status, "failed");
    assert.equal(state.errorCode, code);
    assert.equal(state.result, undefined);
    assert.deepEqual(state.report.modelCalls[0].stop, { reason, nativeReason });
    assert.deepEqual(state.report.usage, [usage]);
    assert.equal(state.report.modelCalls[0].requestId, `request-${reason}`);
    app.close(); observer.close();
    const reopened = app.open();
    assert.deepEqual(reopened.steps.inspect(request), state);
    assert.deepEqual(reopened.spend.inspect(entries[0]).record.stop, { reason, nativeReason });
    assert.deepEqual(reopened.spend.inspect(entries[0]).record.usage, usage);
    assert.equal(reopened.spend.inspectBudget(scope).acceptedAmount, 3);
    await assert.rejects(reopened.steps.run(request, model, input), { code: "step_unresolved" });
    assert.equal(entries.length, 1); assert.equal(outputChecks, 0); assert.equal(synthesisCalls, 0);
    assert.equal(reopened.operations.find(receiptRequest, parseEvidence), undefined);
  });

  test(`mixed text and a tool under ${reason} authorize no read or output acceptance`, async t => {
    const app = fixture(t), observer = app.open();
    let reads = 0, outputChecks = 0;
    const { provider, entries } = checkedProvider(observer, async () => ({ ...finalResponse,
      content: [...finalResponse.content, ...toolResponse.content], stopReason: reason, nativeStopReason: nativeReason,
    }));
    await assert.rejects(app.steps.run(request, runtime(app, provider, {
      tools: readTool(app, () => { reads++; }), retry: { attempts: 3, delayMs: () => 0, retryable: () => true },
      outputPolicy: { apply() { outputChecks++; return { accepted: true, output: "accepted" }; } },
    }), input), { code: reason === "refusal" ? "provider_refused" : "unexpected_tool_use" });
    assert.deepEqual(app.steps.inspect(request).report.modelCalls[0].stop, { reason, nativeReason });
    assert.equal(app.steps.inspect(request).report.toolCalls[0].status, "not_started");
    assert.equal(reads, 0); assert.equal(outputChecks, 0); assert.equal(entries.length, 1);
  });
}

test("cancellation at the second provider preserves completed evidence receipts and pending exposure", async t => {
  const app = fixture(t), observer = app.open(), controller = new AbortController();
  let entered;
  const pendingProvider = new Promise(resolve => { entered = resolve; });
  const { provider, entries } = checkedProvider(observer, async () => {
    if (entries.length === 1) return toolResponse;
    assert.equal(observer.steps.inspect(request).report.toolCalls[0].status, "completed");
    assert.deepEqual(observer.operations.find(receiptRequest, parseEvidence).result, evidence);
    entered();
    return new Promise(() => {});
  });
  let reads = 0;
  const running = app.steps.run(request, runtime(app, provider, { tools: readTool(app, () => { reads++; }) }),
    { ...input, signal: controller.signal });
  const rejected = assert.rejects(running, { code: "turn_aborted" });
  await Promise.race([pendingProvider, running.then(() => assert.fail("the pending provider unexpectedly completed"))]);
  controller.abort(new Error("operator cancelled after the provider started"));
  await rejected;
  const before = app.steps.inspect(request);
  assert.equal(before.status, "failed");
  assert.equal(before.report.toolCalls[0].status, "completed");
  assert.deepEqual(before.report.toolCalls[0].receiptIds, [receiptRequest.id]);
  app.close(); observer.close();
  const reopened = app.open();
  assert.deepEqual(reopened.steps.inspect(request), before);
  assert.deepEqual(reopened.operations.find(receiptRequest, parseEvidence).result, evidence);
  assert.equal(reopened.spend.inspect(entries[0]).status, "accepted");
  assert.equal(reopened.spend.inspect(entries[1]).status, "reserved");
  assert.equal(reopened.spend.inspectBudget(scope).totalAmount, 13);
  await assert.rejects(reopened.steps.run(request, runtime(reopened, provider), input), { code: "step_unresolved" });
  assert.equal(reads, 1); assert.equal(entries.length, 2);
});

test("reopened accepted work returns its exact result without context, model, tools, admission or traces", async t => {
  const app = fixture(t), observer = app.open();
  const { provider, entries } = checkedProvider(observer, async () => entries.length === 1 ? toolResponse : finalResponse);
  let reads = 0;
  const first = await app.steps.run(request, runtime(app, provider, { tools: readTool(app, () => { reads++; }),
    tracing: { sink: { record() {} } },
  }), input);
  assert.equal(first.result.accepted, true);
  assert.equal(first.result.status, "reply");
  assert.equal(first.result.output, finalResponse.content[0].text);
  const originalSpend = entries.map(id => observer.spend.inspect(id));
  app.close(); observer.close();
  const reopened = app.open();
  const forbidden = label => () => assert.fail(`completed replay invoked ${label}`);
  let traceExports = 0;
  const replay = await reopened.steps.run(request, runtime(reopened, {
    name: "synthetic", complete: forbidden("provider"),
  }, { persona: { load: forbidden("instructions") }, memory: { load: forbidden("context") },
    tools: readTool(reopened, forbidden("source read")), outputPolicy: { apply: forbidden("output acceptance") },
    modelCalls: { admit: forbidden("reservation"), record: forbidden("settlement") },
    tracing: { sink: { record() { traceExports++; } } },
  }), input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attemptId, first.attemptId);
  assert.deepEqual(replay.result, first.result);
  assert.deepEqual(entries.map(id => reopened.spend.inspect(id)), originalSpend);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM small_hour_model_spend").get().n, 2);
  assert.deepEqual(reopened.operations.find(receiptRequest, parseEvidence).result, evidence);
  assert.equal(reads, 1); assert.equal(entries.length, 2); assert.equal(traceExports, 0);
});

test("process death during tool-bearing gathering preserves committed progress and requires reconciliation", async t => {
  const app = fixture(t);
  app.close();
  const worker = fileURLToPath(new URL("./read-only-crash.mjs", import.meta.url));
  const child = fork(worker, [app.path, JSON.stringify({ request, input, receiptRequest, evidence, usage, scope })], {
    execArgv: ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", "--allow-child-process"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    exited.then(([code, signal]) => assert.fail(`worker exited before its pending provider boundary: ${code}/${signal}\n${stderr}`)),
  ]);
  assert.deepEqual(ready, { type: "provider-pending" });
  const observing = app.open();
  const live = observing.steps.inspect(request);
  assert.equal(live.status, "started");
  assert.equal(live.report.toolCalls[0].status, "completed");
  assert.deepEqual(live.report.toolCalls[0].receiptIds, [receiptRequest.id]);
  assert.deepEqual(observing.operations.find(receiptRequest, parseEvidence).result, evidence);
  const pendingId = live.report.modelCalls[1].callId;
  assert.equal(observing.spend.inspect(pendingId).status, "reserved");
  observing.close();
  child.kill("SIGKILL");
  const [code, signal] = await exited;
  assert.equal(code, null); assert.equal(signal, "SIGKILL");
  const reopened = app.open();
  assert.deepEqual(reopened.steps.inspect(request), live);
  const noCalls = runtime(reopened, { name: "synthetic", complete: () => assert.fail("interrupted gathering cannot replay") },
    { tools: readTool(reopened, () => assert.fail("interrupted gathering cannot repeat a source read")) });
  await assert.rejects(reopened.steps.run(request, noCalls, input), { code: "step_unresolved" });
  await assert.rejects(reopened.steps.recover(request, noCalls, input, {
    action: "retry", checkpoint: live.checkpoint, reason: "operator reviewed the incomplete gathering", evidence: { review: "synthetic-review-1" },
  }), { code: "recovery_not_allowed" });
  await assert.rejects(reopened.steps.run({ ...request, id: "new-tool-bearing-step" }, noCalls, input, {
    recovery: { sideEffectFree: true, maxAttempts: 2, maxModelCalls: 4 },
  }), { code: "invalid_request" });
  assert.equal(reopened.steps.inspect({ ...request, id: "new-tool-bearing-step" }), undefined);
  assert.equal(reopened.spend.inspect(pendingId).status, "reserved");
  assert.equal(reopened.spend.inspectBudget(scope).totalAmount, 13);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM small_hour_model_spend").get().n, 2);
  assert.deepEqual(reopened.operations.find(receiptRequest, parseEvidence).result, evidence);
});
