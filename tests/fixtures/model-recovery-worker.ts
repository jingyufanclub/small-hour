import { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource } from "../../src/index.js";
import { SqliteModelStepStore } from "../../src/durable/model-steps.js";

const [path, stage] = process.argv.slice(2), db = new DatabaseSync(path);
const store = new SqliteModelStepStore(db);
const request = { scope: "app", id: "select", kind: "selection", version: "1", input: { id: "item-7" } };
const input = { agentId: "app", input: "Select item-7.", allowedTools: [] };
const kill = () => process.kill(process.pid, "SIGKILL");
let checks = 0;
const model = new SmallHourRuntime({ persona: new StaticPersonaSource("Use the supplied ID."), memory: new EmptyMemorySource(),
  provider: { name: "fixture", async complete() {
    db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run();
    return { content: [{ type: "text", text: "item-7" }], stopReason: "end_turn" };
  } },
  outputPolicy: { apply(output) { if (stage === "after-provider") kill(); return { accepted: true, output }; } },
});
await store.recover(request, model, input, { action: "retry", checkpoint: store.inspect(request)!.checkpoint,
  reason: "The prior attempt has no accepted result.", evidence: { reviewId: "worker-review" } }, {
  assertActive() { checks++; if (stage === "before-takeover" || (stage === "after-takeover" && checks === 2)) kill(); },
});
db.close();
