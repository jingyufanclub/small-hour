import { SmallHourRuntime, EmptyMemorySource, StaticPersonaSource, IMAGE_INPUT_LIMITS,
  type InputContent, type ImageBlock, type ModelProvider, type ProviderStop, type TraceEvent, type TraceSummary } from "small-hour";
import { AnthropicProvider, type AnthropicProviderOptions } from "small-hour/providers/anthropic";
import { OpenAIProvider, type OpenAIProviderOptions } from "small-hour/providers/openai";
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from "small-hour/providers/openai-compatible";
import { SqliteModelStepStore, SqliteTaskRunner, type ModelRecoveryContract, type ModelStepOptions,
  type ModelStepRecoveryDecision, type ModelStepState, type SqliteDatabase, type TaskWorkflow } from "small-hour/durable/sqlite";

const anthropic: AnthropicProviderOptions = { model: "fixture", apiKey: "fixture-only", thinking: { type: "adaptive", effort: "medium" } };
const openai: OpenAIProviderOptions = { model: "fixture", apiKey: "fixture-only", reasoningEffort: "max" };
const compatible: OpenAICompatibleProviderOptions = { model: "fixture", baseURL: "http://fixture.invalid/v1" };
const providers: ModelProvider[] = [new AnthropicProvider(anthropic), new OpenAIProvider(openai), new OpenAICompatibleProvider(compatible)];
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
  const store = new SqliteModelStepStore(database);
  const decision: ModelStepRecoveryDecision = { action: "retry", checkpoint: state.checkpoint, reason: "Retry selected work.", evidence: {} };
  const input = { agentId: "consumer", input: "Select item-7.", structuredOutput: {
    schema: { type: "object" }, parse: (value: unknown) => value as { selectedId: string },
  } };
  const first = await store.run(request, runtime, input, options);
  const selectedId: string = first.result.value.selectedId;
  const trace: TraceSummary | undefined = first.result.trace;
  const retried = await store.recover(request, runtime, input, decision);
  const stop: ProviderStop | undefined = retried.result.modelCalls[0].stop;
  const workflow: TaskWorkflow<SqliteDatabase> = { kind: "selection", version: "1", authorize: () => ({ status: "allow" }), steps: [
    { id: "select", kind: "model", recovery, prepare: () => ({ runtime, input }) },
  ] };
  const runner = new SqliteTaskRunner(database, [workflow], { leaseMs: 1000 });
  return { selectedId, stop, runner, trace };
}
