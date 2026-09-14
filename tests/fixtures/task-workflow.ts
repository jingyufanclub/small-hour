import type { DatabaseSync } from "node:sqlite";
import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource } from "../../src/index.js";
import type { TaskWorkflow } from "../../src/durable/sqlite.js";

export const workerTask = { scope: "worker", id: "job", kind: "choose-and-stage", version: "1", input: { ids: ["item-7", "item-2"] } };
export const workerSchedule = { concurrencyScope: "worker", dueAt: 100, maxAttempts: 3 };
export function workerWorkflow(db: DatabaseSync, stage?: string): TaskWorkflow<DatabaseSync> {
  const kill = () => process.kill(process.pid, "SIGKILL");
  return { kind: workerTask.kind, version: workerTask.version, authorize: () => ({ status: "allow" }), steps: [
    { id: "prepare", kind: "local", parseResult: value => value, execute: connection => {
      connection.prepare("INSERT INTO effects (body) VALUES ('prepared')").run();
      return { eventId: "event-7" };
    } },
    { id: "choose", kind: "model", prepare: () => {
      if (stage === "after-local") kill();
      return { runtime: new SmallHourRuntime({ persona: new StaticPersonaSource("Use supplied IDs."), memory: new EmptyMemorySource(),
        provider: { name: "fixture", async complete() {
          db.prepare("INSERT INTO provider_calls DEFAULT VALUES").run();
          if (stage === "in-model") kill();
          if (stage === "race") {
            process.send?.("entered");
            await new Promise<void>(resolve => process.once("message", () => resolve()));
          }
          return { content: [{ type: "text", text: "item-7" }], stopReason: "end_turn" };
        } },
      }), input: { agentId: "worker", input: "Choose an ID.", allowedTools: [] } };
    } },
    { id: "stage", kind: "local", parseResult: value => value, execute: (connection, context) => {
      if (stage === "after-model") kill();
      const selected = context.results.choose as { output: string };
      connection.prepare("INSERT INTO effects (body) VALUES (?)").run(selected.output);
      return { eventId: "event-7", output: selected.output };
    } },
  ] };
}
