import assert from "node:assert/strict";
import { join } from "node:path";
import { EmptyMemorySource, IMAGE_INPUT_LIMITS, SmallHourRuntime, StaticPersonaSource } from "small-hour";
import { AnthropicProvider } from "small-hour/providers/anthropic";
import { OpenAIProvider } from "small-hour/providers/openai";
import { OpenAICompatibleProvider } from "small-hour/providers/openai-compatible";
import { SqliteModelStepStore } from "small-hour/durable/sqlite";

globalThis.fetch = async () => assert.fail("The package consumer must not make network requests");
assert.match(import.meta.resolve("small-hour"), /\/node_modules\/small-hour\/dist\/index\.js$/);
const adapters = [
  new AnthropicProvider({ model: "fixture", apiKey: "fixture-only" }),
  new OpenAIProvider({ model: "fixture", apiKey: "fixture-only" }),
  new OpenAICompatibleProvider({ model: "fixture", baseURL: "http://fixture.invalid/v1" }),
];
assert.deepEqual(adapters.map(provider => provider.name), ["anthropic", "openai", "openai-compatible"]);
assert.ok(adapters.every(provider => provider.model === "fixture"));
const input = { agentId: "consumer", input: "Select item-7.", allowedTools: [] };
const answer = value => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const create = provider => new SmallHourRuntime({ provider, persona: new StaticPersonaSource("Use the supplied ID."),
  memory: new EmptyMemorySource(), retry: { attempts: 1 } });
let calls = 0;
const plain = create({ name: "fixture", async complete(request) {
  calls++; assert.deepEqual(request.tools, []); assert.equal(request.system[0].text, "Use the supplied ID.");
  assert.equal(request.messages.at(-1).content, input.input); return answer("item-7 is selected.");
} });
const result = await plain.turn(input);
assert.equal(result.status, "reply"); assert.equal(result.output, "item-7 is selected.");
assert.deepEqual(result.modelCalls[0].stop, { reason: "end_turn" }); assert.equal(calls, 1);
const schema = { type: "object", properties: { selectedId: { type: "string", enum: ["item-7"] } }, required: ["selectedId"], additionalProperties: false };
const structured = await create({ name: "fixture", capabilities: { structuredOutput: true }, async complete(request) {
  assert.deepEqual(request.outputSchema, schema); assert.deepEqual(request.tools, []); return answer('{"selectedId":"item-7"}');
} }).turn({ agentId: input.agentId, input: input.input, structuredOutput: { schema, parse(value) {
  assert.deepEqual(value, { selectedId: "item-7" }); return value;
} } });
assert.equal(structured.status, "structured"); assert.deepEqual(structured.value, { selectedId: "item-7" });

const image = { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" };
const imageInput = { ...input, input: [{ type: "text", text: "Inspect item-7." }, image] };
assert.equal(IMAGE_INPUT_LIMITS.maxImages, 20); assert.ok(Object.isFrozen(IMAGE_INPUT_LIMITS));
let imageCalls = 0;
const vision = create(new OpenAIProvider({ model: "fixture", apiKey: "fixture-only", reasoningEffort: "max", fetch: async (_url, init) => {
  imageCalls++;
  const body = JSON.parse(init.body);
  assert.deepEqual(body.reasoning, { effort: "max" });
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "Inspect item-7." },
    { type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}` }] }]);
  return new Response(JSON.stringify({ id: "response-1", status: "completed", output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "item-7 inspected." }] },
  ] }), { headers: { "content-type": "application/json" } });
} }));
assert.equal((await vision.turn(imageInput)).output, "item-7 inspected.");
assert.equal(imageCalls, 1);
await assert.rejects(create(adapters[2]).turn(imageInput), { code: "images_unsupported" });

if (!process.argv.includes("--core-only")) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(process.cwd(), "consumer.sqlite"), recovery = { sideEffectFree: true, maxAttempts: 2, maxModelCalls: 2 };
  const request = { scope: "consumer", id: "select-1", kind: "selection", version: "1", input: { id: "item-7" } };
  let db = new DatabaseSync(path), store = new SqliteModelStepStore(db), attempts = 0;
  store.initialize();
  const model = create({ name: "fixture", capabilities: { images: true }, async complete(request) {
    assert.deepEqual(request.messages.at(-1).content, imageInput.input);
    attempts++;
    return attempts === 1 ? { ...answer("partial"), stopReason: "context_limit", nativeStopReason: "fixture_context_limit" } : answer("item-7 is selected.");
  } });
  try {
    await assert.rejects(store.run(request, model, imageInput, { recovery }), { code: "incomplete_stop" });
    const failed = store.inspect(request);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.report.modelCalls[0].stop, { reason: "context_limit", nativeReason: "fixture_context_limit" });
    db.close(); db = new DatabaseSync(path); store = new SqliteModelStepStore(db); store.initialize();
    assert.deepEqual(store.inspect(request), failed);
    await assert.rejects(store.run(request, model, imageInput, { recovery }), { code: "step_unresolved" });
    const recovered = await store.recover(request, model, imageInput, { action: "retry", checkpoint: failed.checkpoint,
      reason: "Authorize another tool-free attempt.", evidence: { policy: "consumer-fixture-v1" } });
    assert.equal(recovered.result.output, "item-7 is selected."); assert.equal(recovered.replayed, false);
    const replay = await store.run(request, model, imageInput, { recovery });
    assert.equal(replay.replayed, true); assert.deepEqual(replay.result, recovered.result); assert.equal(attempts, 2);
    const state = store.inspect(request);
    assert.equal(state.status, "completed"); assert.equal(state.attempts.length, 2);
    assert.deepEqual(state.attempts[0].report, failed.report);
  } finally { db.close(); }
}
