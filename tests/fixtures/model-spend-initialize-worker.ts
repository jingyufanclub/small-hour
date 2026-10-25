import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteModelCallStore } from "../../src/durable/sqlite.js";

const db = new DatabaseSync(process.argv[2]);
db.exec("BEGIN IMMEDIATE; CREATE TABLE app_settings (id TEXT PRIMARY KEY)");
new SqliteModelCallStore(db).initialize();
db.exec("INSERT INTO app_settings VALUES ('initial')");
assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'model_calls'").get());
process.kill(process.pid, "SIGKILL");
