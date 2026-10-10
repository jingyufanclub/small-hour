import { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource } from "../../src/index.js";
import { SqliteModelSpendStore, type ModelSpendPolicy } from "../../src/durable/sqlite.js";

const db = new DatabaseSync(process.argv[2]); db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
const stage = process.argv[3], account = stage === "account" ? "a" : process.argv[4];
const spend = new SqliteModelSpendStore(db);
const competing = stage === "shared" || stage === "account";
if (competing) {
  const go = new Promise<void>(resolve => process.once("message", () => resolve())); process.send!("ready"); await go;
}
const policy: ModelSpendPolicy = { quote: () => ({ scopes: [{ scope: "app:month", limit: stage === "account" ? 20 : 10 },
  { scope: `account:${account}:month`, limit: 10 }], amount: 10, pricing: {} }), charge: () => {
    if (stage === "before-settlement") process.kill(process.pid, "SIGKILL"); return 3;
  } };
try {
  await new SmallHourRuntime({ persona: new StaticPersonaSource("Process."), memory: new EmptyMemorySource(),
    modelCalls: spend.hooks(policy), provider: { name: "fixture", async complete() {
      db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run();
      if (stage === "in-provider") process.kill(process.pid, "SIGKILL");
      return { content: [{ type: "text", text: "Processed." }], stopReason: "end_turn",
        ...(competing ? {} : { usage: { model: "fixture", freshInputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 } }) };
    } } }).turn({ agentId: "app", input: "Process.", allowedTools: [] });
} catch (error) {
  if (!competing || !(error instanceof RuntimeError) || error.code !== "model_call_denied") throw error;
  process.exitCode = 2;
}
db.close(); if (process.connected) process.disconnect?.();
