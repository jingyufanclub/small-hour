import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteModelSpendStore } from "../src/durable/sqlite.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "small-hour-schema-")), path = join(directory, "app.sqlite");
  const connections: DatabaseSync[] = [];
  const open = () => { const db = new DatabaseSync(path); connections.push(db); return db; };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, open };
}

const appSchema = "CREATE TABLE app_settings (id TEXT PRIMARY KEY); INSERT INTO app_settings VALUES ('initial')";

for (const finish of ["COMMIT", "ROLLBACK"]) test(`spending schema and application setup share ${finish.toLowerCase()}`, t => {
  const app = fixture(t), db = app.open(), observer = app.open(), spend = new SqliteModelSpendStore(db);
  db.exec(`BEGIN IMMEDIATE; ${appSchema}`);
  spend.initialize(); spend.initialize();
  assert.equal(observer.prepare("SELECT name FROM sqlite_schema LIMIT 1").get(), undefined);
  db.exec(finish);
  if (finish === "ROLLBACK") {
    assert.equal(observer.prepare("SELECT name FROM sqlite_schema LIMIT 1").get(), undefined);
    db.exec(`BEGIN; ${appSchema}`); spend.initialize(); db.exec("COMMIT");
  }
  assert.equal(observer.prepare("SELECT id FROM app_settings").get()?.id, "initial");
  assert.equal(new SqliteModelSpendStore(observer).inspectBudget("app").totalAmount, 0);
});

test("releasing a caller savepoint leaves schema setup provisional in its outer transaction", t => {
  const db = fixture(t).open();
  db.exec(`BEGIN; ${appSchema}; SAVEPOINT app_setup`);
  new SqliteModelSpendStore(db).initialize();
  db.exec("RELEASE SAVEPOINT app_setup; ROLLBACK");
  assert.equal(db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get(), undefined);
});

for (const enclosing of [false, true]) test(`schema failure rolls back library changes ${enclosing ? "without ending caller work" : "when initialized alone"}`, t => {
  const app = fixture(t), db = app.open(), observer = app.open();
  if (enclosing) db.exec("BEGIN");
  db.exec(`${appSchema}; CREATE VIEW small_hour_model_spend_scopes AS SELECT id FROM app_settings`);
  const spend = new SqliteModelSpendStore(db);
  assert.throws(() => spend.initialize(), /view|table/i);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'small_hour_model_spend'").get(), undefined);
  assert.equal(db.prepare("SELECT id FROM app_settings").get()?.id, "initial");
  if (enclosing) assert.equal(observer.prepare("SELECT name FROM sqlite_schema LIMIT 1").get(), undefined);
  db.exec("DROP VIEW small_hour_model_spend_scopes; INSERT INTO app_settings VALUES ('after-failure')");
  spend.initialize();
  if (enclosing) db.exec("COMMIT");
  assert.equal(observer.prepare("SELECT count(*) n FROM app_settings").get()?.n, 2);
  assert.equal(new SqliteModelSpendStore(observer).inspectBudget("app").totalAmount, 0);
});

test("process death during application setup leaves no partial spending schema", { timeout: 10000 }, async t => {
  const app = fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("./fixtures/model-spend-initialize-worker.ts", import.meta.url)), app.path],
  { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let errors = ""; child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(signal, "SIGKILL", `setup failed before process exit: ${code}: ${errors}`);
  const db = app.open();
  assert.equal(db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get(), undefined);
  db.exec(`BEGIN; ${appSchema}`); new SqliteModelSpendStore(db).initialize(); db.exec("COMMIT");
  assert.equal(app.open().prepare("SELECT id FROM app_settings").get()?.id, "initial");
});
