import assert from "node:assert/strict";
import test from "node:test";
import { EmptyMemorySource, RuntimeError, SmallHourRuntime, StaticPersonaSource, ToolRegistry } from "../src/index.js";
import { OpenAIProvider, type OpenAIProviderOptions } from "../src/providers/openai.js";

function transport(value: unknown) {
  const requests: Record<string, any>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    assert.equal(requests.length, 1, "host validation must not start a repair request");
    return new Response(JSON.stringify({ id: "response-1", model: "configured-model", status: "completed",
      output: [{ type: "message", role: "assistant", status: "completed", phase: "final_answer",
        content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }],
      usage: { input_tokens: 30, output_tokens: 20 },
    }), { headers: { "content-type": "application/json", "x-request-id": "request-1" } });
  };
  return { fetch, requests };
}

test("OpenAI forwards a host-selected model and max effort within the output ceiling", async () => {
  const { fetch, requests } = transport("done");
  const options: OpenAIProviderOptions = { model: "gpt-5.6-luna", apiKey: "fixture-only", reasoningEffort: "max", fetch };
  const app = new SmallHourRuntime({ provider: new OpenAIProvider(options),
    persona: new StaticPersonaSource("Use the supplied facts."), memory: new EmptyMemorySource(),
  });
  const result = await app.turn({ agentId: "extractor", input: "Return the result.", maxTokens: 1024 });
  assert.equal(requests[0].model, "gpt-5.6-luna");
  assert.deepEqual(requests[0].reasoning, { effort: "max" });
  assert.equal(requests[0].max_output_tokens, 1024);
  assert.equal(result.modelCalls[0].stop?.reason, "end_turn");
  assert.equal(result.usage[0].model, "configured-model");
});

const schema = {
  type: "object",
  properties: {
    recordId: { type: "string" },
    material: { type: "string" },
    lengthCm: { type: ["number", "null"] },
    conflictingSourceIds: { type: "array", items: { type: "string" } },
  },
  required: ["recordId", "material", "lengthCm", "conflictingSourceIds"],
  additionalProperties: false,
};

const cases = [
  { name: "missing measurements", sources: [{ id: "source-1", material: "cotton" }],
    expected: { recordId: "item-7", material: "cotton", lengthCm: null, conflictingSourceIds: [] } },
  { name: "contradictory measurements", sources: [{ id: "source-1", material: "cotton", lengthCm: 30 },
    { id: "source-2", material: "cotton", lengthCm: 45 }],
    expected: { recordId: "item-7", material: "cotton", lengthCm: null, conflictingSourceIds: ["source-1", "source-2"] } },
];

for (const scenario of cases) {
  test(`OpenAI structured output preserves host-accepted partial facts with ${scenario.name}`, async () => {
    const { fetch, requests } = transport(scenario.expected);
    let parses = 0;
    const input = JSON.stringify({ recordId: "item-7", sources: scenario.sources });
    const app = new SmallHourRuntime({ provider: new OpenAIProvider({ model: "configured-model", apiKey: "fixture-only", fetch }),
      persona: new StaticPersonaSource("Use only supplied facts. Preserve missing and conflicting measurements without guessing."),
      memory: new EmptyMemorySource(),
    });
    const result = await app.turn({ agentId: "extractor", input, structuredOutput: { schema,
      parse: (value) => { parses++; assert.deepEqual(value, scenario.expected); return value; },
    } });
    assert.equal(parses, 1);
    assert.equal(result.status, "structured");
    assert.equal(result.accepted, true);
    assert.deepEqual(result.value, scenario.expected);
    assert.deepEqual(requests[0].input, [{ role: "user", content: input }]);
    assert.deepEqual(requests[0].text.format.schema, schema);
    assert.equal(requests[0].tools, undefined);
  });

  test(`OpenAI host rejection of guessed facts with ${scenario.name} causes no repair or effects`, async () => {
    const { fetch, requests } = transport({ ...scenario.expected, lengthCm: 30, conflictingSourceIds: [] });
    let parses = 0, effects = 0;
    const rejection = new Error("The sources do not establish one measurement.");
    const app = new SmallHourRuntime({ provider: new OpenAIProvider({ model: "configured-model", apiKey: "fixture-only", fetch }),
      persona: new StaticPersonaSource("Use only supplied facts."), memory: new EmptyMemorySource(),
      retry: { attempts: 3, delayMs: () => 0 },
      tools: new ToolRegistry([{ name: "save", description: "Save an accepted record", inputSchema: schema,
        execute: () => { effects++; } }]),
    });
    await assert.rejects(app.turn({ agentId: "extractor", input: JSON.stringify({ recordId: "item-7", sources: scenario.sources }),
      structuredOutput: { schema, parse: () => { parses++; throw rejection; } },
    }), (error: unknown) => {
      assert.ok(error instanceof RuntimeError && error.report);
      assert.equal(error.code, "structured_output_invalid");
      assert.equal(error.cause, rejection);
      assert.equal(error.report.modelCalls.length, 1);
      assert.equal(error.report.modelCalls[0].status, "responded");
      assert.equal(error.report.modelCalls[0].requestId, "request-1");
      assert.deepEqual(error.report.toolCalls, []);
      return true;
    });
    assert.equal(parses, 1);
    assert.equal(effects, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined);
  });
}
