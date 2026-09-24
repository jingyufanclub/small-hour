import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("consumer imports resolve to installed public exports", () => {
  for (const [specifier, file] of [["small-hour", "index.js"], ["small-hour/durable/sqlite", "durable/sqlite.js"]]) {
    assert.equal(import.meta.resolve(specifier), pathToFileURL(join(process.cwd(), "node_modules/small-hour/dist", file)).href);
  }
});

test("fixture execution has no network permission or inherited provider credentials", async () => {
  assert.equal(process.permission.has("net"), false);
  const socket = createConnection({ host: "127.0.0.1", port: 443 });
  try { await assert.rejects(once(socket, "connect"), { code: "ERR_ACCESS_DENIED" }); }
  finally { socket.destroy(); }
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NODE_PATH", "NODE_OPTIONS"]) {
    assert.equal(Object.hasOwn(process.env, key), false, `${key} must be absent`);
  }
});
