import { randomUUID } from "node:crypto";
import type { MemorySource } from "./memory/interface.js";
import type { PersonaSource } from "./persona/interface.js";
import type { OutputPolicy } from "./policy/output.js";
import { AcceptAllOutput } from "./policy/output.js";
import { defaultRetryPolicy, withRetry, type RetryPolicy } from "./retry.js";
import { ToolRegistry } from "./tools/registry.js";
import type {
  AssistantBlock,
  ModelProvider,
  ProviderMessage,
  SystemBlock,
  ToolCallRecord,
  ToolResultBlock,
  TurnContext,
  TurnInput,
  TurnResult,
} from "./types.js";
import { RuntimeError } from "./types.js";
import type { UsageSink } from "./usage.js";
import { NoopUsageSink } from "./usage.js";

export interface RuntimeOptions {
  provider: ModelProvider;
  persona: PersonaSource;
  memory: MemorySource;
  tools?: ToolRegistry;
  outputPolicy?: OutputPolicy;
  usage?: UsageSink;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  maxHops?: number;
  maxTokens?: number;
  maxToolResultCharacters?: number;
  toolErrorMode?: "result" | "throw";
  cachePersona?: boolean;
}

function systemBlocks(persona: string | SystemBlock[], cachePersona: boolean): SystemBlock[] {
  if (typeof persona === "string") return [{ text: persona, ...(cachePersona ? { cache: "ephemeral" as const } : {}) }];
  return persona;
}

function textFrom(content: AssistantBlock[]): string {
  return content
    .filter((block): block is Extract<AssistantBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function stringifyResult(value: unknown, limit: number): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? "null";
  } catch {
    rendered = JSON.stringify({ error: "tool result was not JSON-serializable" });
  }
  if (rendered.length <= limit) return rendered;
  const envelope = (preview: string) => JSON.stringify({
    truncated: true,
    originalCharacters: rendered.length,
    preview,
  });
  let low = 0;
  let high = rendered.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (envelope(rendered.slice(0, middle)).length <= limit) low = middle;
    else high = middle - 1;
  }
  return envelope(rendered.slice(0, low));
}

function abortSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function abortError(signal: AbortSignal): RuntimeError {
  return new RuntimeError("turn aborted", "turn_aborted", { cause: signal.reason });
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class SmallHourRuntime {
  private readonly tools: ToolRegistry;
  private readonly outputPolicy: OutputPolicy;
  private readonly usage: UsageSink;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly maxHops: number;
  private readonly maxTokens: number;
  private readonly maxToolResultCharacters: number;
  private readonly toolErrorMode: "result" | "throw";

  constructor(private readonly options: RuntimeOptions) {
    this.tools = options.tools ?? new ToolRegistry();
    this.outputPolicy = options.outputPolicy ?? new AcceptAllOutput();
    this.usage = options.usage ?? new NoopUsageSink();
    const retryable = options.retry?.retryable;
    this.retry = {
      attempts: options.retry?.attempts ?? defaultRetryPolicy.attempts,
      delayMs: options.retry?.delayMs ?? defaultRetryPolicy.delayMs,
      retryable: (error) => {
        if (error instanceof RuntimeError && error.code === "turn_aborted") return false;
        return retryable?.(error) ?? options.provider.isRetryable?.(error) ?? false;
      },
    };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxHops = options.maxHops ?? 6;
    this.maxTokens = options.maxTokens ?? 512;
    this.maxToolResultCharacters = options.maxToolResultCharacters ?? 4_000;
    this.toolErrorMode = options.toolErrorMode ?? "result";
    if (!Number.isInteger(this.timeoutMs) || !Number.isInteger(this.maxHops) || !Number.isInteger(this.maxTokens)
      || !Number.isInteger(this.maxToolResultCharacters)) {
      throw new TypeError("runtime limits must be integers");
    }
    if (this.timeoutMs < 1 || this.maxHops < 1 || this.maxTokens < 1 || this.maxToolResultCharacters < 80) {
      throw new TypeError("runtime limits must be positive and tool results must allow at least 80 characters");
    }
  }

  async turn<TChoice = unknown>(input: TurnInput<TChoice>): Promise<TurnResult<TChoice>> {
    if (!input.agentId.trim()) throw new TypeError("agentId is required");
    const turnId = input.turnId ?? randomUUID();
    const timeout = abortSignal(input.signal, this.timeoutMs);
    const context: TurnContext = { agentId: input.agentId, turnId, input: input.input, signal: timeout.signal };

    try {
      const [persona, memory] = await raceAbort(Promise.all([
        this.options.persona.load(context),
        this.options.memory.load(context),
      ]), timeout.signal);
      const messages: ProviderMessage[] = [...memory, { role: "user", content: input.input }];
      const tools = this.tools.providerTools(input.allowedTools);
      const choiceName = input.choice?.name ?? "small_hour_choose";
      if (input.choice) {
        if (this.tools.has(choiceName)) throw new RuntimeError(`choice tool conflicts with registered tool: ${choiceName}`, "choice_tool_conflict");
        tools.unshift({
          name: choiceName,
          description: input.choice.description,
          inputSchema: input.choice.inputSchema,
          strict: input.choice.strict ?? true,
        });
      }

      const usage = [];
      const toolCalls: ToolCallRecord[] = [];
      let choice: TChoice | undefined;
      let output = "";
      let hops = 0;
      let awaitingToolAnswer = false;

      for (let hop = 0; hop < this.maxHops; hop++) {
        hops = hop + 1;
        const offeredTools = choice === undefined ? tools : tools.filter((tool) => tool.name !== choiceName);
        const response = await raceAbort(
          withRetry(
            () => raceAbort(this.options.provider.complete({
              system: systemBlocks(persona, this.options.cachePersona ?? true),
              messages,
              tools: offeredTools,
              maxTokens: input.maxTokens ?? this.maxTokens,
              ...(input.thinking ? { thinking: { enabled: true as const, budgetTokens: input.thinking.budgetTokens } } : {}),
              signal: timeout.signal,
            }), timeout.signal),
            this.retry,
            timeout.signal,
          ),
          timeout.signal,
        );

        if (response.usage) {
          usage.push(response.usage);
          await this.usage.record(response.usage, context);
        }

        const said = textFrom(response.content);
        if (said) output = said;
        const requested = response.content.filter((block): block is Extract<AssistantBlock, { type: "tool_use" }> => block.type === "tool_use");
        if (response.stopReason !== "tool_use") {
          if (requested.length) {
            throw new RuntimeError("provider returned tool calls without a tool-use stop", "unexpected_tool_use");
          }
          if (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") {
            throw new RuntimeError(`provider stopped before completing the turn: ${response.stopReason}`, "incomplete_stop");
          }
          if (input.choice && (input.choice.required ?? true) && choice === undefined) {
            throw new RuntimeError(`turn ended without required choice ${choiceName}`, "choice_required");
          }
          if (awaitingToolAnswer && !said && choice === undefined) {
            throw new RuntimeError("provider ended without answering after a tool result", "missing_tool_answer");
          }
          const policy = await this.outputPolicy.apply(output, context);
          return {
            status: policy.accepted ? (policy.output ? "reply" : "silence") : "rejected",
            output: policy.output,
            accepted: policy.accepted,
            issues: policy.issues ?? [],
            ...(choice === undefined ? {} : { choice }),
            toolCalls,
            usage,
            hops,
            finishReason: response.stopReason,
          };
        }
        if (!requested.length) {
          throw new RuntimeError("provider stopped for tool use without a tool call", "missing_tool_call");
        }
        if (hop + 1 >= this.maxHops) {
          throw new RuntimeError(`tool hop limit ${this.maxHops} reached before executing another tool`, "tool_hop_limit");
        }

        messages.push({ role: "assistant", content: response.content });
        const results: ToolResultBlock[] = [];
        for (const request of requested) {
          if (request.name === choiceName && input.choice) {
            if (choice !== undefined) {
              results.push({ type: "tool_result", toolUseId: request.id, isError: true, content: JSON.stringify({ error: "choice already made" }) });
              toolCalls.push({ id: request.id, name: request.name, input: request.input, ok: false });
              continue;
            }
            try {
              choice = input.choice.parse ? input.choice.parse(request.input) : request.input as TChoice;
              await input.choice.onChoice?.(choice, context);
              results.push({ type: "tool_result", toolUseId: request.id, content: JSON.stringify({ ok: true, chosen: choice }) });
              toolCalls.push({ id: request.id, name: request.name, input: request.input, ok: true });
            } catch (error) {
              choice = undefined;
              results.push({
                type: "tool_result",
                toolUseId: request.id,
                isError: true,
                content: stringifyResult({ error: error instanceof Error ? error.message : String(error) }, this.maxToolResultCharacters),
              });
              toolCalls.push({ id: request.id, name: request.name, input: request.input, ok: false });
            }
            continue;
          }

          try {
            const mode = this.tools.mode(request.name);
            if (input.choice && mode === "write") {
              if (choice === undefined && input.choice.requiredFirst) {
                throw new RuntimeError(`write tool ${request.name} requires ${choiceName} first`, "choice_required_before_write");
              }
              if (choice !== undefined) {
                const authorized = await input.choice.authorizeWrite?.(
                  choice,
                  { name: request.name, input: request.input },
                  context,
                ) ?? false;
                if (!authorized) {
                  throw new RuntimeError(`choice did not authorize write tool ${request.name}`, "choice_write_not_authorized");
                }
              }
            }
            const value = await raceAbort(
              this.tools.execute(request.name, request.input, { ...context, toolCallId: request.id }),
              timeout.signal,
            );
            results.push({ type: "tool_result", toolUseId: request.id, content: stringifyResult(value, this.maxToolResultCharacters) });
            toolCalls.push({ id: request.id, name: request.name, input: request.input, ok: true });
          } catch (error) {
            toolCalls.push({ id: request.id, name: request.name, input: request.input, ok: false });
            if (this.toolErrorMode === "throw") throw new RuntimeError(`tool ${request.name} failed`, "tool_failed", { cause: error });
            results.push({
              type: "tool_result",
              toolUseId: request.id,
              isError: true,
              content: stringifyResult({ error: error instanceof Error ? error.message : String(error) }, this.maxToolResultCharacters),
            });
          }
        }
        if (!results.length) {
          throw new RuntimeError("tool-use response produced no tool results", "missing_tool_result");
        }
        messages.push({ role: "user", content: results });
        awaitingToolAnswer = true;
      }

      throw new RuntimeError(`tool hop limit ${this.maxHops} exhausted`, "tool_hop_limit");
    } finally {
      timeout.dispose();
    }
  }
}
