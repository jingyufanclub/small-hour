import { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource } from "../../src/index.js";
import { SqliteModelSpendStore } from "../../src/durable/sqlite.js";

const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const stage = process.argv[3];
const spend = new SqliteModelSpendStore(db);
if (stage === "compete") {
  const go = new Promise<void>(resolve => process.once("message", () => resolve()));
  process.send!("ready"); await go;
}
try { await new SmallHourRuntime({
  persona: new StaticPersonaSource("Process supplied work."), memory: new EmptyMemorySource(),
  modelCalls: spend.hooks({ quote: () => ({ scope: "app-a:period-1", limit: 10, amount: 10, pricing: {} }), charge: () => {
    if (stage === "before-settlement") process.kill(process.pid, "SIGKILL");
    return 3;
  } }),
  provider: { name: "fixture", async complete() {
    db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run();
    if (stage === "in-provider") process.kill(process.pid, "SIGKILL");
    return { content: [{ type: "text", text: "Processed." }], stopReason: "end_turn",
      ...(stage === "compete" ? {} : { usage: { model: "fixture", freshInputTokens: 2, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 } }) };
  } },
}).turn({ agentId: "app-a", input: "Process.", allowedTools: [] });
} catch (error) {
  if (stage !== "compete" || !(error instanceof RuntimeError) || error.code !== "model_call_denied") throw error;
  process.exitCode = 2;
}
db.close();
if (process.connected && process.disconnect) process.disconnect();
