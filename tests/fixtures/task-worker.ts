import { DatabaseSync } from "node:sqlite";
import { SqliteTaskRunner } from "../../src/durable/sqlite.js";
import { workerSchedule, workerTask, workerWorkflow } from "./task-workflow.js";

const [path, stage] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000");
const runner = new SqliteTaskRunner(db, [workerWorkflow(db, stage)], { leaseMs: 100, now: () => 100 });
runner.initialize();
runner.enqueue(workerTask, workerSchedule);
const result = await runner.runNext();
process.send?.({ status: result?.status ?? "idle" });
db.close();
process.disconnect?.();
