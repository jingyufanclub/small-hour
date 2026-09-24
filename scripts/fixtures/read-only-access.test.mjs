import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry } from "small-hour";
import { SqliteModelSpendStore } from "small-hour/durable/sqlite";

const traceId = "b9b5b35368f445009759430cc9be712d";
const query = { sourceId: "request-service", start: 100, end: 130 };
const usage = { model: "scripted", freshInputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5 };
const answer = text => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage });
const read = (input = query, name = "read_events") => ({
  content: [{ type: "tool_use", id: "query-1", name, input }], stopReason: "tool_use", usage,
});
const querySchema = {
  type: "object", additionalProperties: false, required: ["sourceId", "start", "end"],
  properties: { sourceId: { const: query.sourceId }, start: { type: "integer" }, end: { type: "integer" } },
};

function fixture(t, auditFailure) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-access-"));
  const path = join(directory, "source.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE evidence (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, detail TEXT NOT NULL);
    INSERT INTO evidence VALUES
      ('event-1', 'request-service', 110, 'selected evidence detail'),
      ('event-2', 'request-service', 120, 'unselected evidence detail'),
      ('event-3', 'request-service', 140, 'outside requested time range'),
      ('event-4', 'other-service', 110, 'outside authorized source');
    CREATE TABLE audit_guards (id TEXT PRIMARY KEY);
    INSERT INTO audit_guards VALUES ('read-access');
    CREATE TABLE access_audit (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, query_id TEXT NOT NULL,
      trace_id TEXT NOT NULL, span_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
      guard_id TEXT REFERENCES audit_guards(id) DEFERRABLE INITIALLY DEFERRED
    );`);
  if (auditFailure === "insert") writer.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON access_audit
    BEGIN SELECT RAISE(ABORT, 'audit insert unavailable'); END`);
  const spending = new SqliteModelSpendStore(writer);
  spending.initialize();
  const reader = new DatabaseSync(path, { readOnly: true });
  const observedSpending = new SqliteModelSpendStore(reader);
  const initialRows = reader.prepare("SELECT * FROM evidence ORDER BY id").all();
  let sourceRowsRead = 0, parses = 0;
  reader.function("observe_read", id => { sourceRowsRead++; return id; });
  const responses = [], auditFailures = [];
  t.after(() => {
    assert.deepEqual(reader.prepare("SELECT * FROM evidence ORDER BY id").all(), initialRows);
    reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true });
  });
  const tools = new ToolRegistry([{
    name: "read_events", description: "Read events from the authorized source and time range.",
    mode: "read", inputSchema: querySchema,
    parse(input) {
      parses++;
      assert.ok(input && typeof input === "object" && !Array.isArray(input));
      assert.deepEqual(Object.keys(input).sort(), ["end", "sourceId", "start"]);
      assert.equal(input.sourceId, query.sourceId);
      assert.ok(Number.isSafeInteger(input.start) && Number.isSafeInteger(input.end));
      assert.ok(input.start >= 100 && input.end <= 160 && input.start < input.end && input.end - input.start <= 30);
      return input;
    },
    execute(input, context) {
      const auditId = `audit:${context.toolCallId}`;
      let stage = "insert";
      writer.exec("BEGIN IMMEDIATE");
      try {
        writer.prepare(`INSERT INTO access_audit VALUES (?, ?, ?, ?, ?, ?, ?, 'read-access')`)
          .run(auditId, input.sourceId, context.toolCallId, context.trace.traceId, context.trace.spanId, input.start, input.end);
        if (auditFailure === "commit") writer.exec("DELETE FROM audit_guards WHERE id = 'read-access'");
        stage = "commit";
        writer.exec("COMMIT");
      } catch (error) {
        auditFailures.push({ stage, error });
        writer.exec("ROLLBACK");
        throw error;
      }
      const audit = reader.prepare("SELECT * FROM access_audit WHERE id = ?").get(auditId);
      assert.deepEqual({ ...audit }, {
        id: auditId, source_id: input.sourceId, query_id: context.toolCallId,
        trace_id: context.trace.traceId, span_id: context.trace.spanId,
        start: input.start, end: input.end, guard_id: "read-access",
      });
      const rows = reader.prepare(`SELECT observe_read(id) AS id, detail FROM evidence
        WHERE source_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY id`)
        .all(input.sourceId, input.start, input.end).map(row => ({ ...row }));
      const response = { sourceId: input.sourceId, queryId: context.toolCallId, auditId, rows };
      responses.push(response);
      context.recordReceipt(auditId);
      return response;
    },
  }]);
  return { tools, responses, auditFailures, spending, observedSpending,
    get sourceRowsRead() { return sourceRowsRead; },
    get parses() { return parses; },
    audits: () => reader.prepare("SELECT * FROM access_audit ORDER BY id").all().map(row => ({ ...row })),
  };
}

function scripted(steps) {
  const requests = [];
  return { requests, provider: { name: "scripted", model: "scripted", capabilities: { tools: true, structuredOutput: true },
    async complete(request) {
      requests.push(structuredClone({ messages: request.messages, tools: request.tools, outputSchema: request.outputSchema }));
      assert.ok(steps.length > 0, "no unplanned provider call");
      const step = steps.shift();
      return typeof step === "function" ? step(request) : structuredClone(step);
    },
  } };
}

function runtime(provider, app, events, options = {}) {
  return new SmallHourRuntime({
    provider, persona: new StaticPersonaSource("Inspect only the selected evidence."), memory: new EmptyMemorySource(),
    tools: app.tools, toolErrorMode: "throw", maxHops: 2, maxModelCalls: 2,
    retry: { attempts: 1, delayMs: () => 0 }, tracing: { sink: { record: event => events.push(event) } }, ...options,
  });
}

const gatherInput = { agentId: "internal-operator", input: "Read the authorized events.", allowedTools: ["read_events"], trace: { traceId } };

test("withheld tools cannot reach application parsing, audit or source reads", async t => {
  const app = fixture(t), events = [], model = scripted([read()]);
  await assert.rejects(runtime(model.provider, app, events).turn({ ...gatherInput, allowedTools: [] }), error => {
    assert.equal(error.code, "tool_failed");
    assert.equal(error.report.toolCalls[0].errorCode, "tool_not_allowed");
    assert.equal(error.report.toolCalls[0].status, "not_started");
    return true;
  });
  assert.deepEqual(model.requests[0].tools, []);
  assert.equal(model.requests.length, 1);
  assert.equal(app.parses, 0);
  assert.equal(app.sourceRowsRead, 0);
  assert.deepEqual(app.audits(), []);
  assert.equal(events.some(event => event.type === "tool.started"), false);
});

for (const [label, input] of [
  ["foreign source", { ...query, sourceId: "other-service" }],
  ["extra fields", { ...query, sql: "SELECT * FROM evidence" }],
  ["reversed range", { ...query, start: 130, end: 100 }],
  ["oversized range", { ...query, end: 160 }],
  ["range outside permission", { ...query, start: 90, end: 110 }],
]) test(`application parsing rejects ${label} before an audit or protected read`, async t => {
  const app = fixture(t), events = [], model = scripted([read(input)]);
  await assert.rejects(runtime(model.provider, app, events).turn(gatherInput), error => {
    assert.equal(error.code, "tool_failed");
    assert.equal(error.report.toolCalls[0].status, "not_started");
    assert.equal(error.cause.name, "AssertionError");
    return true;
  });
  assert.deepEqual(model.requests[0].tools.map(tool => tool.name), ["read_events"]);
  assert.equal(app.parses, 1);
  assert.equal(app.sourceRowsRead, 0);
  assert.deepEqual(app.audits(), []);
  assert.equal(events.some(event => event.type === "tool.started"), false);
});

for (const stage of ["insert", "commit"]) test(`SQLite audit ${stage} failure blocks reads even when the trace sink fails`, async t => {
  const app = fixture(t, stage), events = [], model = scripted([read()]);
  await assert.rejects(runtime(model.provider, app, events, {
    tracing: { sink: { record(event) { events.push(event); throw new Error("trace export unavailable"); } } },
  }).turn(gatherInput), error => {
    assert.equal(error.code, "tool_failed");
    assert.ok(error.report.trace.exportFailures > 0);
    assert.deepEqual(error.report.toolCalls[0].receiptIds, []);
    return true;
  });
  assert.equal(app.auditFailures.length, 1);
  assert.equal(app.auditFailures[0].stage, stage);
  assert.match(app.auditFailures[0].error.message, stage === "insert" ? /audit insert unavailable/ : /FOREIGN KEY constraint failed/);
  assert.equal(app.sourceRowsRead, 0);
  assert.deepEqual(app.audits(), []);
  assert.deepEqual(app.responses, []);
  assert.equal(model.requests.length, 1);
  assert.equal(events.some(event => event.type === "tool.started"), true);
});

test("a failed trace sink cannot repeat a completed read or stand in for its committed audit", async t => {
  const app = fixture(t), events = [], model = scripted([read(), answer("Evidence gathered.")]);
  const result = await runtime(model.provider, app, events, {
    tracing: { sink: { record(event) { events.push(event); throw new Error("trace export unavailable"); } } },
  }).turn(gatherInput);
  assert.equal(result.status, "reply");
  assert.equal(model.requests.length, 2);
  assert.equal(app.sourceRowsRead, 2);
  assert.equal(app.responses.length, 1);
  assert.equal(app.audits().length, 1);
  assert.deepEqual(result.toolCalls[0].receiptIds, [app.audits()[0].id]);
  assert.equal(result.toolCalls[0].status, "completed");
  assert.equal(result.trace.exportFailures, result.trace.eventCount);
});

test("gather and selected-evidence synthesis share committed spending and trace identity", async t => {
  const app = fixture(t), events = [], scope = "investigation:1";
  const modelCalls = app.spending.hooks({
    quote: () => ({ scope, limit: 30, amount: 10, pricing: { perToken: 1 } }),
    charge: (tokens, pricing) => (tokens.freshInputTokens + tokens.outputTokens) * pricing.perToken,
  });
  const gather = scripted([
    () => { assert.equal(app.observedSpending.inspectBudget(scope).reservedAmount, 10); return read(); },
    request => {
      assert.equal(app.observedSpending.inspectBudget(scope).reservedAmount, 10);
      const content = request.messages.at(-1).content;
      assert.equal(content[0].toolUseId, "query-1");
      assert.deepEqual(JSON.parse(content[0].content), app.responses[0]);
      return answer("Evidence gathered.");
    },
  ]);
  const gathered = await runtime(gather.provider, app, events, { modelCalls }).turn(gatherInput);
  assert.deepEqual(app.responses[0].rows.map(row => row.id), ["event-1", "event-2"]);
  const selected = { ...app.responses[0], rows: [app.responses[0].rows[0]] };
  const schema = { type: "object", additionalProperties: false, required: ["evidenceId"], properties: { evidenceId: { const: "event-1" } } };
  const synthesize = scripted([request => {
    assert.deepEqual(request.tools, []);
    assert.deepEqual(request.outputSchema, schema);
    assert.deepEqual(request.messages, [{ role: "user", content: JSON.stringify(selected) }]);
    assert.doesNotMatch(JSON.stringify(request), /unselected evidence detail|outside requested time range|outside authorized source/);
    assert.equal(app.observedSpending.inspectBudget(scope).reservedAmount, 10);
    return answer('{"evidenceId":"event-1"}');
  }]);
  const synthesisInput = {
    agentId: gatherInput.agentId, input: JSON.stringify(selected), trace: { traceId },
    structuredOutput: { schema, parse: value => { assert.deepEqual(value, { evidenceId: "event-1" }); return value; } },
  };
  const synthesis = runtime(synthesize.provider, app, events, { modelCalls });
  const report = await synthesis.turn(synthesisInput);
  assert.equal(report.status, "structured");
  assert.equal(report.value.evidenceId, selected.rows[0].id);
  assert.equal(app.sourceRowsRead, 2);
  assert.equal(app.audits().length, 1);
  assert.equal(app.observedSpending.inspectBudget(scope).totalAmount, 30);
  assert.deepEqual([...gathered.modelCalls, ...report.modelCalls].map(call => app.spending.inspect(call.callId).status), ["accepted", "accepted", "accepted"]);
  assert.ok(events.every(event => event.traceId === traceId));
  const turns = events.filter(event => event.type === "turn.started");
  const attempts = events.filter(event => event.type === "model.started");
  assert.equal(turns.length, 2);
  assert.equal(new Set([...turns, ...attempts].map(event => event.spanId)).size, 5);
  assert.deepEqual(attempts.map(event => event.parentSpanId), [turns[0].spanId, turns[0].spanId, turns[1].spanId]);
  const tool = events.find(event => event.type === "tool.started");
  assert.equal(tool.parentSpanId, attempts[0].spanId);
  assert.equal(app.audits()[0].span_id, tool.spanId);
  assert.equal(app.audits()[0].trace_id, traceId);
  assert.equal(app.audits()[0].query_id, selected.queryId);
  assert.equal(app.audits()[0].source_id, selected.sourceId);
  assert.equal(app.audits()[0].id, selected.auditId);
  assert.ok(events.some(event => event.content?.reason === "disabled"));
  assert.ok(events.every(event => !event.content || event.content.status === "omitted"));
  assert.doesNotMatch(JSON.stringify(events), /selected evidence detail|unselected evidence detail|Read the authorized events|Inspect only the selected evidence/);
  await assert.rejects(synthesis.turn(synthesisInput), { code: "model_call_denied" });
  assert.equal(synthesize.requests.length, 1);
  assert.equal(app.observedSpending.inspectBudget(scope).totalAmount, 30);
});

test("bounded content capture explicitly omits oversized input and preserves the execution result", async t => {
  const app = fixture(t), events = [], model = scripted([answer("Complete.")]);
  const input = "private source payload ".repeat(50);
  const result = await runtime(model.provider, app, events, {
    tracing: { sink: { record: event => events.push(event) }, content: { maxBytes: 128 } },
  }).turn({ ...gatherInput, input, allowedTools: [] });
  const started = events.find(event => event.type === "turn.started");
  assert.deepEqual(started.content, { status: "omitted", reason: "size_limit", bytes: Buffer.byteLength(JSON.stringify(input)), maxBytes: 128 });
  assert.ok(result.trace.contentOmissions > 0);
  assert.equal(result.output, "Complete.");
  assert.equal(model.requests[0].messages[0].content, input);
  assert.doesNotMatch(JSON.stringify(events), /private source payload/);
  assert.equal(app.sourceRowsRead, 0);
});

test("tools with native structured output fail before context, provider, audit or source access", async t => {
  const app = fixture(t), model = scripted([]);
  let contextLoads = 0;
  const invocation = runtime(model.provider, app, [], {
    memory: { async load() { contextLoads++; return []; } },
  }).turn({ ...gatherInput, structuredOutput: { schema: { type: "object" }, parse: value => value } });
  await assert.rejects(invocation, { code: "structured_output_conflict" });
  assert.equal(contextLoads, 0);
  assert.equal(model.requests.length, 0);
  assert.equal(app.sourceRowsRead, 0);
  assert.deepEqual(app.audits(), []);
});
