import { DatabaseSync } from "node:sqlite";
import { SqliteTaskRunner, type OperationRequest } from "../../src/durable/sqlite.js";

const [path, url, mode, idempotency, productJson, scheduleJson] = process.argv.slice(2);
if (idempotency !== "key" && idempotency !== "none") throw new Error("Invalid sink contract");
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000");
const product = JSON.parse(productJson) as OperationRequest;
const runner = new SqliteTaskRunner(db, [{ kind: product.kind, version: product.version, authorize: () => ({ status: "allow" }),
  steps: [{ id: "handoff", kind: "delivery", sink: { idempotency, async send(saved, context) {
    const response = await fetch(url, { method: "POST", headers: { "idempotency-key": context.idempotencyKey }, body: JSON.stringify(saved) });
    return response.json();
  } } }],
}], { leaseMs: 100, now: () => 100 });
runner.initialize();
db.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY); BEGIN IMMEDIATE");
db.prepare("INSERT INTO effects VALUES (?) ON CONFLICT DO NOTHING").run("effect-7");
runner.enqueue(product, JSON.parse(scheduleJson)); db.exec("COMMIT");
if (mode === "dispatch") await runner.runNext();
db.close();
