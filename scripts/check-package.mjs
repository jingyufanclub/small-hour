import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let workspace;
try {
  let outDir, coreOnly = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--core-only" && !coreOnly) coreOnly = true;
    else if (args[index] === "--out-dir" && outDir === undefined) {
      outDir = args[++index];
      assert.ok(outDir && isAbsolute(outDir), "--out-dir requires an absolute directory path");
    } else throw new Error("Usage: node scripts/check-package.mjs [--core-only] [--out-dir /absolute/path]");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(coreOnly ? major > 20 || (major === 20 && minor >= 3) : major > 22 || (major === 22 && minor >= 13),
    coreOnly ? "Core package verification requires Node 20.3 or newer" : "Full package verification requires Node 22.13 or newer for SQLite; use --core-only on Node 20");
  workspace = mkdtempSync(join(tmpdir(), "small-hour-package-"));
  const stage = join(workspace, "source"), packed = join(workspace, "packed"), consumer = join(workspace, "consumer");
  for (const directory of [stage, packed, consumer]) mkdirSync(directory);
  for (const entry of ["src", "docs", "README.md", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"]) {
    cpSync(join(source, entry), join(stage, entry), { recursive: true });
  }
  assert.equal(existsSync(join(stage, "dist")), false, "Package staging must start without dist");
  const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
  assert.equal(lock.version, manifest.version, "The package lock must match the release version");
  assert.equal(lock.packages[""].version, manifest.version, "The root lock entry must match the release version");
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const run = (command, arguments_, cwd) => {
    try { return execFileSync(command, arguments_, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) {
      throw new Error(`${command} ${arguments_.join(" ")} failed:\n${String(error.stderr || error.stdout || error.message).slice(-6000)}`);
    }
  };
  const npm = (arguments_, cwd) => process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...arguments_], cwd)
    : run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, cwd);
  npm(["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"], stage);
  const results = JSON.parse(npm(["pack", "--ignore-scripts=false", "--json", "--pack-destination", packed], stage));
  assert.equal(results.length, 1, "Expected exactly one package artifact");
  const artifact = results[0];
  assert.equal(artifact.name, manifest.name); assert.equal(artifact.version, manifest.version);
  const files = new Set(artifact.files.map(file => file.path));
  for (const file of files) assert.ok(file === "README.md" || file === "package.json" || /^(dist|docs)\//.test(file), `Unexpected package file: ${file}`);
  assert.ok(files.has("README.md") && files.has("package.json") && [...files].some(file => file.startsWith("docs/")), "Package documentation is missing");
  const subpaths = [".", "./providers/anthropic", "./providers/openai", "./providers/openai-compatible", "./durable/sqlite"];
  assert.deepEqual(Object.keys(manifest.exports).sort(), [...subpaths].sort(), "The five public exports must remain available");
  for (const subpath of subpaths) for (const condition of ["types", "import"]) {
    const target = manifest.exports[subpath][condition];
    assert.ok(typeof target === "string" && target.startsWith("./dist/"), `Invalid ${condition} target for ${subpath}`);
    assert.ok(files.has(target.slice(2)), `Package is missing public export ${target}; npm pack must build from source`);
  }
  const tarball = join(packed, artifact.filename);
  const dev = name => {
    const version = lock.packages[`node_modules/${name}`]?.version;
    assert.ok(typeof version === "string", `Missing locked consumer compiler dependency: ${name}`);
    return version;
  };
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "small-hour-package-consumer", version: "1.0.0", private: true,
    type: "module", dependencies: { [manifest.name]: `file:${tarball}` },
    devDependencies: { typescript: dev("typescript"), "@types/node": dev("@types/node") } }, null, 2));
  npm(["install", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"], consumer);
  const installed = join(consumer, "node_modules", manifest.name);
  assert.equal(lstatSync(installed).isSymbolicLink(), false, "Consumer must install the artifact, not link the source tree");
  assert.equal(realpathSync(installed), join(realpathSync(consumer), "node_modules", manifest.name));
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.version, manifest.version); assert.deepEqual(installedManifest.exports, manifest.exports);
  for (const filename of ["package-consumer.mjs", "package-consumer.ts"]) copyFileSync(join(source, "scripts", "fixtures", filename), join(consumer, filename));
  run(process.execPath, ["package-consumer.mjs", ...(coreOnly ? ["--core-only"] : [])], consumer);
  run(process.execPath, [join(consumer, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--types", "node", "package-consumer.ts"], consumer);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  let retained;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    retained = join(outDir, artifact.filename);
    const checksums = join(outDir, "SHA256SUMS");
    assert.ok(!existsSync(retained) && !existsSync(checksums), "The output directory already contains an artifact or SHA256SUMS; choose an unused directory");
    copyFileSync(tarball, retained, constants.COPYFILE_EXCL);
    try { writeFileSync(checksums, `${sha256}  ${artifact.filename}\n`, { flag: "wx" }); }
    catch (error) { rmSync(retained); throw error; }
  }
  console.log(`Verified ${manifest.name}@${manifest.version} (${coreOnly ? "core" : "core + SQLite recovery"}); SHA256 ${sha256}${retained ? `; artifact ${retained}` : ""}`);
} catch (error) {
  console.error(`Package verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}
