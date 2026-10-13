import { SmallHourRuntime, EmptyMemorySource, StaticPersonaSource, IMAGE_INPUT_LIMITS, ModelSafeToolError, ToolRegistry,
  type InputContent, type ImageBlock, type ModelProvider, type ProviderStop, type TraceEvent, type TraceSummary } from "small-hour";
import { AnthropicProvider, type AnthropicProviderOptions } from "small-hour/providers/anthropic";
import { OpenAIProvider, type OpenAIProviderOptions } from "small-hour/providers/openai";
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from "small-hour/providers/openai-compatible";
import { SqliteModelStepStore, SqliteTaskRunner, SqliteModelSpendStore, type ModelSpendPolicy, type ModelSpendScope, type ModelSpendDenial, type ModelSpendDecision, type ModelRecoveryContract, type ModelStepOptions,
  type ModelStepRecoveryDecision, type ModelStepState, type SqliteDatabase, type TaskWorkflow, type DurableClockOptions, type RecordTimestamps } from "small-hour/durable/sqlite";

const anthropic: AnthropicProviderOptions = { model: "fixture", apiKey: "fixture-only", thinking: { type: "adaptive", effort: "medium" } };
const openai: OpenAIProviderOptions = { model: "fixture", apiKey: "fixture-only", reasoningEffort: "max" };
const compatible: OpenAICompatibleProviderOptions = { model: "fixture", baseURL: "http://fixture.invalid/v1" };
const providers: ModelProvider[] = [new AnthropicProvider(anthropic), new OpenAIProvider(openai), new OpenAICompatibleProvider(compatible)];
const tools = new ToolRegistry().register({
  name: "read_record", description: "Read a record", mode: "read", inputSchema: { type: "object" },
  parse(value) {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
      throw new ModelSafeToolError("Supply a record ID.", { cause: new Error("private diagnostic") });
    }
    return { id: value.id };
  },
  execute: ({ id }) => ({ id }),
});
export const verifyToolTypes = () => new SmallHourRuntime({ tools, provider: providers[0],
  persona: new StaticPersonaSource("Read the selected record."), memory: new EmptyMemorySource(),
}).turn({ agentId: "consumer", input: "Read item-7.", allowedTools: ["read_record"] });
const traces: TraceEvent[] = [];
const runtime = new SmallHourRuntime({ provider: providers[0], persona: new StaticPersonaSource("Use the supplied ID."), memory: new EmptyMemorySource(),
  tracing: { sink: { record: event => { traces.push(event); } } } });
const image: ImageBlock = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
const imageInput: InputContent = [{ type: "text", text: "Inspect." }, image];
export const imageLimits = IMAGE_INPUT_LIMITS;
export const verifyImageTypes = () => runtime.turn({ agentId: "consumer", input: imageInput });
const recovery: ModelRecoveryContract = { sideEffectFree: true, maxAttempts: 2, maxModelCalls: 2 };
const options: ModelStepOptions = { recovery };
const request = { scope: "consumer", id: "select-1", kind: "selection", version: "1", input: { id: "item-7" } };

export async function verifyPublicTypes(database: SqliteDatabase, state: ModelStepState) {
  const clock: DurableClockOptions = { now: () => 100 };
  const store = new SqliteModelStepStore(database, clock);
  const budgets: ModelSpendScope[] = [{ scope: "application", limit: 100 }, { scope: "account", limit: 10 }];
  const spending: ModelSpendPolicy = { quote: () => ({ scopes: budgets, amount: 5, pricing: {} }), charge: () => 3 };
  new SqliteModelSpendStore(database).hooks(spending);
  const denied: ModelSpendDenial = { denied: true, scopes: ["application"], reason: "unknown_model", evidence: "prices-v1" };
  const admission: ModelSpendDecision = denied;
  const spend = new SqliteModelSpendStore(database);
  spend.hooks({ quote: () => admission, charge: () => 0 });
  const saved = spend.inspect("call");
  if (saved?.quote === null) {
    const reason: string = saved.denial.reason;
    const charge: 0 = saved.chargedAmount;
    const status: "denied" = saved.status;
    void [reason, charge, status];
  } else if (saved) {
    const amount: number = saved.quote.amount;
    void amount;
  }
  const decision: ModelStepRecoveryDecision = { action: "retry", checkpoint: state.checkpoint, reason: "Retry selected work.", evidence: {} };
  const input = { agentId: "consumer", input: "Select item-7.", structuredOutput: {
    schema: { type: "object" }, parse: (value: unknown) => value as { selectedId: string },
  } };
  const first = await store.run(request, runtime, input, options);
  const timestamps: RecordTimestamps = { createdAt: first.createdAt, updatedAt: first.updatedAt };
  const selectedId: string = first.result.value.selectedId;
  const trace: TraceSummary | undefined = first.result.trace;
  const retried = await store.recover(request, runtime, input, decision);
  const stop: ProviderStop | undefined = retried.result.modelCalls[0].stop;
  const workflow: TaskWorkflow<SqliteDatabase> = { kind: "selection", version: "1", authorize: () => ({ status: "allow" }), steps: [
    { id: "select", kind: "model", recovery, prepare: () => ({ runtime, input }) },
  ] };
  const runner = new SqliteTaskRunner(database, [workflow], { leaseMs: 1000 });
  const selected = await runner.run({ scope: request.scope, id: request.id }, { signal: new AbortController().signal });
  const selectedIdOrAbsent: string | undefined = selected?.id;
  return { selectedId, selectedIdOrAbsent, stop, runner, trace, timestamps };
}
