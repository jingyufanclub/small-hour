import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, ToolRegistry } from "small-hour";
import { SqliteModelSpendStore, SqliteModelStepStore, SqliteOperationStore } from "small-hour/durable/sqlite";

const [path, serialized] = process.argv.slice(2);
assert.equal(process.permission.has("net"), false);
const { request, input, receiptRequest, evidence, usage, scope } = JSON.parse(serialized);
const db = new DatabaseSync(path), observer = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000");
const spend = new SqliteModelSpendStore(db), steps = new SqliteModelStepStore(db), operations = new SqliteOperationStore(db);
const observedSpend = new SqliteModelSpendStore(observer), observedSteps = new SqliteModelStepStore(observer);
const parseEvidence = value => { assert.deepEqual(value, evidence); return value; };
let calls = 0;
process.on("message", () => {});
await steps.run(request, new SmallHourRuntime({
  persona: new StaticPersonaSource("Inspect only the selected source and cite supplied evidence IDs."),
  memory: new EmptyMemorySource(), retry: { attempts: 1, delayMs: () => 0 },
  modelCalls: spend.hooks({ quote: () => ({ scope, limit: 30, amount: 10, pricing: { revision: "synthetic-1" } }),
    charge: tokens => tokens.freshInputTokens + tokens.outputTokens }),
  tools: new ToolRegistry([{ name: "read_evidence", description: "Read the selected source evidence.", mode: "read",
    inputSchema: { type: "object" }, parse(value) { assert.deepEqual(value, request.input); return value; },
    execute(_value, context) {
      const saved = operations.commit(receiptRequest, { execute(database) {
        return JSON.parse(database.prepare("SELECT value_json FROM source_evidence WHERE id = ?").get(evidence.evidenceId).value_json);
      }, parseResult: parseEvidence });
      context.recordReceipt(saved.receipt.id);
      return saved.receipt.result;
    },
  }]),
  provider: { name: "synthetic", async complete(value) {
    calls++;
    const report = observedSteps.inspect(request).report;
    assert.equal(observedSpend.inspect(report.modelCalls.at(-1).callId).status, "reserved");
    if (calls === 1) return { content: [{ type: "tool_use", id: "read-1", name: "read_evidence", input: request.input }],
      stopReason: "tool_use", nativeStopReason: "tool_use", usage };
    assert.equal(calls, 2);
    assert.equal(report.toolCalls[0].status, "completed");
    assert.deepEqual(report.toolCalls[0].receiptIds, [receiptRequest.id]);
    assert.deepEqual(JSON.parse(value.messages.at(-1).content[0].content), evidence);
    process.send({ type: "provider-pending" });
    return new Promise(() => {});
  } },
}), input);
assert.fail("the parent must stop the worker while the second provider is pending");
