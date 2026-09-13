import { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource } from "../../src/index.js";
import { SqliteModelStepStore } from "../../src/durable/sqlite.js";

const [path, stage] = process.argv.slice(2);
const db = new DatabaseSync(path);
const kill = () => process.kill(process.pid, "SIGKILL");
const runtime = new SmallHourRuntime({
  persona: new StaticPersonaSource("Choose from supplied IDs."),
  memory: { async load(context) { if (stage === "before-provider") kill(); return new EmptyMemorySource().load(); } },
  provider: { name: "fixture", capabilities: { structuredOutput: true }, async complete() {
    db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run();
    if (stage === "in-provider") kill();
    return { content: [{ type: "text", text: '{"itemIds":["coat-7","boots-2"]}' }], stopReason: "end_turn",
      usage: { model: "fixture", freshInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } };
  } },
  usage: { record() { if (stage === "after-provider") kill(); } },
});
const steps = new SqliteModelStepStore(db);
await steps.run({ scope: "worker", id: "step-1", kind: "choose", version: "1", input: {} }, runtime, {
  agentId: "worker", input: "Choose.", structuredOutput: {
    schema: { type: "object", properties: { itemIds: { type: "array", items: { type: "string" } } } },
    parse: value => value as { itemIds: string[] },
  },
});
if (stage === "after-checkpoint") kill();
db.close();
