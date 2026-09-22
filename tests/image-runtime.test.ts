import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.js";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry,
  type ModelProvider, type ProviderMessage, type RuntimeOptions, type TurnContext, type TurnInput } from "../src/index.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

type Image = { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };
type Part = Image | { type: "text"; text: string };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const jpeg = "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAAB//8AAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgMDBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z";
const webp = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
const image = (data = png, mediaType: Image["mediaType"] = "image/png"): Image => ({ type: "image", mediaType, data });
const parts = (): Part[] => [{ type: "text", text: "Inspect these images in order." }, image(), image(webp, "image/webp")];
const input = (value: unknown): TurnInput => ({ agentId: "inspector", input: value as TurnInput["input"] });
const message = (value: unknown): ProviderMessage => ({ role: "user", content: value as ProviderMessage["content"] } as ProviderMessage);
const reply = { content: [{ type: "text" as const, text: "inspected" }], stopReason: "end_turn" as const };
const capable = (complete: ModelProvider["complete"]): ModelProvider => ({ name: "image-fixture", capabilities: { images: true }, complete } as ModelProvider);
const runtime = (provider: ModelProvider, options: Partial<RuntimeOptions> = {}) => new SmallHourRuntime({ provider,
  persona: new StaticPersonaSource("Inspect only supplied content."), memory: new EmptyMemorySource(),
  retry: { attempts: 1, delayMs: () => 0 }, ...options,
});
async function failure(pending: Promise<unknown>, code: string) {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof RuntimeError && error.report);
    assert.equal(error.code, code);
    assert.deepEqual(error.report.modelCalls, []);
    assert.deepEqual(error.report.toolCalls, []);
    return true;
  });
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function pngOfSize(bytes: number): Image {
  const buffer = Buffer.alloc(bytes);
  Buffer.from(png, "base64").copy(buffer);
  return image(buffer.toString("base64"));
}

test("image limits are published without mutable settings", () => {
  const limits = (api as unknown as { IMAGE_INPUT_LIMITS: object }).IMAGE_INPUT_LIMITS;
  assert.deepEqual(limits, { maxImages: 20, maxImageBytes: 3 * 1024 * 1024, maxTotalImageBytes: 12 * 1024 * 1024 });
  assert.equal(Object.isFrozen(limits), true);
});

test("mixed text and supported image formats reach the provider in exact order", async () => {
  const supplied = [...parts(), image(jpeg, "image/jpeg")];
  let calls = 0;
  const result = await runtime(capable(async request => {
    calls++;
    assert.deepEqual(request.messages, [message(supplied)]);
    return reply;
  })).turn(input(supplied));
  assert.equal(result.output, "inspected");
  assert.equal(calls, 1);
});

test("text strings and text-only parts remain available without image capability", async () => {
  const seen: ProviderMessage[][] = [];
  const app = runtime({ name: "text-fixture", async complete(request) { seen.push(structuredClone(request.messages)); return reply; } });
  await app.turn(input("Read the supplied text."));
  await app.turn(input([{ type: "text", text: "Read the supplied text." }]));
  assert.deepEqual(seen, [[message("Read the supplied text.")], [message([{ type: "text", text: "Read the supplied text." }])]]);
});

test("image input needs explicit provider capability before any context loading or admission", async t => {
  for (const capabilities of [undefined, {}, { images: false }]) await t.test(JSON.stringify(capabilities) ?? "absent", async () => {
    const events: string[] = [];
    const app = runtime({ name: "text-fixture", capabilities, async complete() { events.push("provider"); return reply; } } as ModelProvider, {
      persona: { async load() { events.push("persona"); return "Inspect."; } },
      memory: { async load() { events.push("memory"); return []; } },
      modelCalls: { admit() { events.push("admit"); return true; } },
    });
    await failure(app.turn(input(parts())), "images_unsupported");
    assert.deepEqual(events, []);
  });
});

test("the text compatibility adapter rejects images without making an HTTP request", async () => {
  let calls = 0, loads = 0;
  const provider = new OpenAICompatibleProvider({ model: "fixture", baseURL: "http://fixture.invalid/v1",
    fetch: async () => { calls++; throw new Error("unexpected HTTP request"); } });
  const app = runtime(provider, { memory: { async load() { loads++; return []; } } });
  await failure(app.turn(input(parts())), "images_unsupported");
  assert.equal(calls, 0);
  assert.equal(loads, 0);
});

test("malformed image content fails before context loading, admission, or effects", async t => {
  const padded = Buffer.concat([Buffer.from(png, "base64"), Buffer.from([0])]).toString("base64");
  const malformed: Record<string, unknown> = {
    "sparse blocks": new Array(1),
    "unsupported MIME": [{ ...image(), mediaType: "image/gif" }],
    "MIME signature mismatch": [image(jpeg)],
    "non-ASCII WebP signature": [image(Buffer.from([0xd2, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0xd7, 0x45, 0x42, 0x50]).toString("base64"), "image/webp")],
    "invalid signature": [image(Buffer.from("This is not an image.").toString("base64"))],
    "empty payload": [image("")],
    "invalid base64": [image("!not-base64!")],
    "base64 whitespace": [image(png + "\n")],
    "extra padding": [image(png + "=")],
    "noncanonical padding bits": [image(padded.slice(0, -3) + "B==")],
    "URL input": [{ type: "image", mediaType: "image/png", url: "https://fixture.invalid/image.png" }],
    "unknown field": [{ ...image(), description: "extra" }],
    "tool result in caller input": [{ type: "tool_result", toolUseId: "invented", content: "done" }],
    "non-string text": [{ type: "text", text: 5 }],
  };
  for (const [name, supplied] of Object.entries(malformed)) await t.test(name, async () => {
    const events: string[] = [];
    const app = runtime(capable(async () => { events.push("provider"); return reply; }), {
      persona: { async load() { events.push("persona"); return "Inspect."; } },
      memory: { async load() { events.push("memory"); return []; } },
      modelCalls: { admit() { events.push("admit"); return true; } },
      tools: new ToolRegistry([{ name: "save", description: "Save", inputSchema: {}, execute() { events.push("effect"); } }]),
    });
    await failure(app.turn(input(supplied)), "invalid_input");
    assert.deepEqual(events, []);
  });
});

test("current input size and count limits reject before loaders or admission", async t => {
  const oversized = "A".repeat(4 * 1024 * 1024 + 4);
  const large = pngOfSize(3 * 1024 * 1024);
  const cases = { count: Array.from({ length: 21 }, () => image()), bytes: [image(oversized)], total: [large, large, large, large, large] };
  for (const [name, supplied] of Object.entries(cases)) await t.test(name, async () => {
    const events: string[] = [];
    const app = runtime(capable(async () => { events.push("provider"); return reply; }), {
      persona: { async load() { events.push("persona"); return "Inspect."; } },
      memory: { async load() { events.push("memory"); return []; } },
      modelCalls: { admit() { events.push("admit"); return true; } },
    });
    await failure(app.turn(input(supplied)), "image_input_limit");
    assert.deepEqual(events, []);
  });
});

test("selected memory and new input share image count and byte limits before admission", async t => {
  const large = pngOfSize(3 * 1024 * 1024);
  for (const kind of ["count", "bytes"] as const) await t.test(kind, async () => {
    const memory = kind === "count" ? Array.from({ length: 20 }, () => image()) : [large, large, large, large];
    const supplied = kind === "count" ? [image()] : [large];
    let loads = 0, admissions = 0, calls = 0;
    const app = runtime(capable(async () => { calls++; return reply; }), {
      memory: { async load() { loads++; return [message(memory)]; } },
      modelCalls: { admit() { admissions++; return true; } },
    });
    await failure(app.turn(input(supplied)), "image_input_limit");
    assert.equal(loads, 1);
    assert.equal(admissions, 0);
    assert.equal(calls, 0);
  });
});

test("image content in selected memory also requires validation and capability", async t => {
  for (const kind of ["unsupported", "malformed"] as const) await t.test(kind, async () => {
    let admissions = 0, calls = 0;
    const complete: ModelProvider["complete"] = async () => { calls++; return reply; };
    const provider = kind === "unsupported" ? { name: "text-fixture", complete } : capable(complete);
    const app = runtime(provider, { memory: { async load() { return [message([image(kind === "malformed" ? "!invalid!" : png)])]; } },
      modelCalls: { admit() { admissions++; return true; } },
    });
    await failure(app.turn(input("Inspect the selected image.")), kind === "unsupported" ? "images_unsupported" : "invalid_input");
    assert.equal(admissions, 0);
    assert.equal(calls, 0);
  });
});

test("exact image count and combined byte limits remain usable", async () => {
  let calls = 0;
  const provider = capable(async () => { calls++; return reply; });
  await runtime(provider).turn(input(Array.from({ length: 20 }, () => image())));
  const large = pngOfSize(3 * 1024 * 1024);
  await runtime(provider, { memory: { async load() { return [message([large, large])]; } } }).turn(input([large, large]));
  assert.equal(calls, 2);
});

test("mutating caller parts during context loading cannot replace the selected image input", async () => {
  const supplied = parts(), expected = structuredClone(supplied), entered = gate(), resume = gate();
  let seen: ProviderMessage[] = [];
  const app = runtime(capable(async request => { seen = structuredClone(request.messages); return reply; }), {
    memory: { async load() { entered.release(); await resume.promise; return []; } },
  });
  const pending = app.turn(input(supplied));
  await entered.promise;
  (supplied[1] as Image).data = jpeg;
  supplied.reverse();
  resume.release();
  await pending;
  assert.deepEqual(seen, [message(expected)]);
  assert.equal(Object.isFrozen(supplied), false);
});

test("callbacks cannot change image bytes across a real host tool round trip", async () => {
  const supplied = parts(), seen: ProviderMessage[][] = [], callbacks: string[] = [];
  const inspectContext = (name: string, context: TurnContext) => {
    callbacks.push(name);
    const selected = context.input as unknown as Part[];
    assert.notEqual(selected, supplied);
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(Object.isFrozen(selected[1]), true);
    assert.throws(() => { (selected[1] as Image).data = "replacement"; }, TypeError);
    assert.throws(() => { selected.reverse(); }, TypeError);
  };
  const app = runtime(capable(async request => {
    seen.push(structuredClone(request.messages));
    return seen.length === 1
      ? { content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: { id: "item-7" } }], stopReason: "tool_use" }
      : reply;
  }), {
    persona: { async load(context) { inspectContext("persona", context); return "Inspect."; } },
    memory: { async load(context) { inspectContext("memory", context); return []; } },
    modelCalls: { admit(context) { inspectContext("admit", context); return true; } },
    tools: new ToolRegistry([{ name: "lookup", mode: "read", description: "Read the selected record", inputSchema: {},
      execute(value, context) { inspectContext("tool", context); assert.deepEqual(value, { id: "item-7" }); return { id: "item-7", state: "available" }; } }]),
    outputPolicy: { apply(output, context) { inspectContext("output", context); return { accepted: true, output }; } },
  });
  const result = await app.turn(input(supplied));
  assert.deepEqual(callbacks, ["persona", "memory", "admit", "tool", "admit", "output"]);
  assert.deepEqual(seen[0], [message(supplied)]);
  assert.deepEqual(seen[1][0], message(supplied));
  assert.deepEqual(seen[1].at(-1), message([{ type: "tool_result", toolUseId: "lookup-1", content: '{"id":"item-7","state":"available"}' }]));
  assert.equal(result.toolCalls[0].id, "lookup-1");
  assert.equal(result.toolCalls[0].status, "completed");
  assert.equal(result.output, "inspected");
});
