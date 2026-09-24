import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "0.6.0";
const sha256 = "34178841585dade7d0d35076460929561e548e44a5ab61ef9c0cab04896f6a7c";
const artifactUrl = `https://github.com/jingyufanclub/small-hour/releases/download/v${version}/small-hour-${version}.tgz`;
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let workspace;
try {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--artifact" && isAbsolute(args[1])),
    "Usage: node scripts/check-released-consumer.mjs [--artifact /absolute/path/small-hour-0.6.0.tgz]");
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 26 || (major === 26 && minor >= 10), "Consumer verification requires Node 26.10 or newer");
  let bytes;
  if (args.length) bytes = readFileSync(args[1]);
  else {
    const response = await fetch(artifactUrl, { signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Release download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, "Released artifact checksum mismatch");
  workspace = mkdtempSync(join(tmpdir(), "small-hour-released-"));
  const consumer = join(workspace, "consumer"), tarball = join(workspace, `small-hour-${version}.tgz`);
  mkdirSync(consumer);
  writeFileSync(tarball, bytes);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "released-runtime-consumer", private: true,
    type: "module", dependencies: { "small-hour": `file:${tarball}` } }, null, 2));
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  for (const kind of ["user", "global"]) {
    const path = join(workspace, `${kind}.npmrc`);
    writeFileSync(path, "");
    env[`npm_config_${kind}config`] = path;
  }
  env.npm_config_cache = join(workspace, "npm-cache");
  const run = (command, parameters) => execFileSync(command, parameters, {
    cwd: consumer, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  });
  const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"];
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...install]);
  else run(process.platform === "win32" ? "npm.cmd" : "npm", install);
  const installed = join(consumer, "node_modules", "small-hour");
  assert.equal(lstatSync(installed).isSymbolicLink(), false, "The consumer must not link the workspace");
  assert.equal(realpathSync(installed), join(realpathSync(consumer), "node_modules", "small-hour"));
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"))).version, version);
  const tests = ["read-only-environment.test.mjs", "read-only-access.test.mjs", "read-only-durable.test.mjs"];
  for (const name of [...tests, "read-only-crash.mjs"]) copyFileSync(join(fixtures, name), join(consumer, name));
  process.stdout.write(run(process.execPath, ["--permission", "--allow-fs-read=*", "--allow-fs-write=*",
    "--allow-child-process", "--test", ...tests]));
  console.log(`Verified released small-hour@${version}; SHA256 ${sha256}`);
} catch (error) {
  console.error(`Released consumer verification failed: ${error.message}`);
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}
