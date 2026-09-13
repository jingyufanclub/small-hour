import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { SqliteOperationStore } from "../../src/durable/sqlite.js";

const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const store = new SqliteOperationStore(db);
const start = once(process, "message");
process.send!("ready");
await start;
const result = store.commit({ scope: "wardrobe:owner-a", id: "save-1", kind: "save-outfit", version: "1",
  input: { itemIds: ["coat-7", "boots-2"], occasion: "studio" },
}, {
  execute(connection) {
    const itemIds = ["coat-7", "boots-2"];
    const row = connection.prepare("INSERT INTO outfits (item_ids) VALUES (?)").run(JSON.stringify(itemIds));
    if (process.argv[3] === "crash") process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    return { outfitId: Number(row.lastInsertRowid), itemIds };
  },
  parseResult(value: unknown) {
    assert.ok(value && typeof value === "object" && "outfitId" in value && "itemIds" in value);
    assert.ok(Number.isSafeInteger(value.outfitId) && Array.isArray(value.itemIds));
    return value as { outfitId: number; itemIds: string[] };
  },
});
process.stdout.write(JSON.stringify(result));
db.close();
process.disconnect!();
