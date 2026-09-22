import { randomUUID } from "node:crypto";
import { turnDeadline, type TurnDeadline } from "./deadline.js";
import { readInputContent, validateImageMessages } from "./input.js";
import type { MemorySource } from "./memory/interface.js";
import { completeModelCall } from "./model-calls.js";
import type { PersonaSource } from "./persona/interface.js";
import { AcceptAllOutput, type OutputPolicy } from "./policy/output.js";
import { defaultRetryPolicy, type RetryPolicy } from "./retry.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  RuntimeError, type AssistantBlock, type ModelCallHooks, type ModelProvider, type ProviderMessage,
  type StructuredTurnInput, type StructuredTurnResult, type SystemBlock, type ToolCallRecord,
  type ToolResultBlock, type ToolResultOverflowContext, type TurnContext, type TurnInput,
  type TurnReport, type TurnResult, type TurnObserver,
} from "./types.js";
import { NoopUsageSink, type UsageSink } from "./usage.js";

export interface RuntimeOptions {
  provider: ModelProvider;
  persona: PersonaSource;
  memory: MemorySource;
  tools?: ToolRegistry;
  outputPolicy?: OutputPolicy;
  usage?: UsageSink;
  modelCalls?: ModelCallHooks;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  maxHops?: number;
  maxModelCalls?: number;
  maxTokens?: number;
  maxToolResultCharacters?: number;
  toolResultOverflow?: (value: unknown, context: ToolResultOverflowContext) => unknown | Promise<unknown>;
  toolErrorMode?: "result" | "throw";
  cachePersona?: boolean;
}

function systemBlocks(persona: string | SystemBlock[], cachePersona: boolean): SystemBlock[] {
  if (typeof persona === "string") return [{ text: persona, ...(cachePersona ? { cache: "ephemeral" as const } : {}) }];
  return persona;
}

function textFrom(content: AssistantBlock[]): string {
  return content.filter((block): block is Extract<AssistantBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text).join("").trim();
}

function serialize(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; } catch (error) {
    throw new RuntimeError("tool result is not JSON-serializable", "tool_result_serialization_failed", { cause: error });
  }
}

function snapshot<TChoice>(report: TurnReport<TChoice>): TurnReport<TChoice> {
  return {
    ...report,
    ...(report.choice === undefined ? {} : { choice: structuredClone(report.choice) }),
    toolCalls: report.toolCalls.map((call) => ({ ...call, receiptIds: [...call.receiptIds] })),
    modelCalls: report.modelCalls.map((call) => structuredClone(call)),
    usage: report.usage.map((usage) => ({ ...usage })),
  };
}

export class SmallHourRuntime {
  private readonly tools: ToolRegistry;
  private readonly outputPolicy: OutputPolicy;
  private readonly usage: UsageSink;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly maxHops: number;
  private readonly maxModelCalls: number;
  private readonly maxTokens: number;
  private readonly maxToolResultCharacters: number;

  constructor(private readonly options: RuntimeOptions) {
    this.tools = options.tools ?? new ToolRegistry();
    this.outputPolicy = options.outputPolicy ?? new AcceptAllOutput();
    this.usage = options.usage ?? new NoopUsageSink();
    this.retry = { ...defaultRetryPolicy, ...options.retry };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxHops = options.maxHops ?? 6;
    this.maxModelCalls = options.maxModelCalls ?? this.maxHops * this.retry.attempts;
    this.maxTokens = options.maxTokens ?? 512;
    this.maxToolResultCharacters = options.maxToolResultCharacters ?? 4_000;
    const limits = [this.timeoutMs, this.maxHops, this.maxModelCalls, this.maxTokens, this.retry.attempts];
    if (limits.some((limit) => !Number.isSafeInteger(limit) || limit < 1) || this.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(this.maxToolResultCharacters) || this.maxToolResultCharacters < 80) {
      throw new TypeError("runtime limits must be positive integers and tool results must allow at least 80 characters");
    }
  }

  private async toolResult(value: unknown, call: ToolCallRecord, context: TurnContext, deadline: TurnDeadline): Promise<string> {
    let content = serialize(value);
    if (content.length > this.maxToolResultCharacters && this.options.toolResultOverflow) {
      const compact = await deadline.run(() => this.options.toolResultOverflow!(value, {
        ...context, toolCallId: call.id, toolName: call.name, maxCharacters: this.maxToolResultCharacters,
      }));
      content = serialize(compact);
    }
    if (content.length > this.maxToolResultCharacters) throw new RuntimeError("tool result exceeds the configured limit", "tool_result_too_large");
    deadline.check();
    return content;
  }

  async turn<TValue>(input: StructuredTurnInput<TValue>, observer?: TurnObserver): Promise<StructuredTurnResult<TValue>>;
  async turn<TChoice = unknown>(input: TurnInput<TChoice>, observer?: TurnObserver): Promise<TurnResult<TChoice>>;
  async turn<TChoice, TValue>(input: TurnInput<TChoice> | StructuredTurnInput<TValue>, observer?: TurnObserver): Promise<TurnResult<TChoice> | StructuredTurnResult<TValue>> {
    const timeout = turnDeadline(input.signal, this.timeoutMs);
    const context: TurnContext = { agentId: input.agentId, turnId: input.turnId ?? randomUUID(), input: input.input, signal: timeout.signal };
    const report: TurnReport<TChoice> = { agentId: context.agentId, turnId: context.turnId, toolCalls: [], modelCalls: [], usage: [], hops: 0 };
    const { signal } = context;
    const checkpoint = async () => {
      if (!observer) return;
      try { await timeout.run(() => observer.checkpoint(structuredClone(report))); }
      catch (cause) {
        timeout.check();
        throw new RuntimeError("turn checkpoint failed", "checkpoint_failed", { cause });
      }
    };
    const checkpointToolStart = async (call: ToolCallRecord) => {
      call.status = "unknown";
      try { await checkpoint(); }
      catch (cause) { call.status = "not_started"; throw cause; }
    };
    try {
      timeout.check();
      context.input = readInputContent(input.input);
      Object.freeze(context);
      validateImageMessages([{ role: "user", content: context.input }], this.options.provider.capabilities?.images === true);
      if (!input.agentId.trim() || !context.turnId.trim()) throw new TypeError("agentId and turnId are required");
      if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) throw new TypeError("maxTokens must be a positive integer");
      if (input.thinking && (!Number.isSafeInteger(input.thinking.budgetTokens) || input.thinking.budgetTokens < 1)) throw new TypeError("thinking budget must be a positive integer");
      if (input.thinking && this.options.provider.capabilities?.thinkingBudget === false) throw new RuntimeError("provider does not support a thinking token budget", "thinking_unsupported");
      if (input.structuredOutput) {
        if (input.choice || input.allowedTools !== undefined) throw new RuntimeError("structured output cannot be combined with tools or choice", "structured_output_conflict");
        if (!this.options.provider.capabilities?.structuredOutput) throw new RuntimeError("provider does not support structured output", "structured_output_unsupported");
        if (typeof input.structuredOutput.parse !== "function") throw new TypeError("structured output requires a host parser");
      }
      const tools = input.structuredOutput ? [] : this.tools.providerTools(input.allowedTools);
      const choiceName = input.choice?.name ?? "small_hour_choose";
      if (input.choice) {
        if (this.tools.has(choiceName)) throw new RuntimeError(`choice tool conflicts with registered tool: ${choiceName}`, "choice_tool_conflict");
        tools.unshift({ name: choiceName, description: input.choice.description, inputSchema: input.choice.inputSchema, strict: input.choice.strict ?? true });
      }
      if (tools.length && this.options.provider.capabilities?.tools === false) throw new RuntimeError("provider does not support tools", "tools_unsupported");
      const [persona, memory] = await Promise.all([
        timeout.run(() => this.options.persona.load(context)),
        timeout.run(async () => structuredClone(await this.options.memory.load(context))),
      ]);
      const messages: ProviderMessage[] = [...memory, { role: "user", content: context.input }];
      validateImageMessages(messages, this.options.provider.capabilities?.images === true);
      let awaitingToolAnswer = false;

      for (let hop = 0; hop < this.maxHops; hop++) {
        report.hops = hop + 1;
        const offeredTools = report.choice === undefined ? tools : tools.filter((tool) => tool.name !== choiceName);
        const allowed = new Set(offeredTools.map((tool) => tool.name));
        const response = await completeModelCall(this.options.provider, {
          system: systemBlocks(persona, this.options.cachePersona ?? true), messages, tools: offeredTools,
          maxTokens: input.maxTokens ?? this.maxTokens,
          ...(input.thinking ? { thinking: { enabled: true as const, budgetTokens: input.thinking.budgetTokens } } : {}),
          ...(input.structuredOutput ? { outputSchema: input.structuredOutput.schema } : {}), signal,
        }, context, report, { retry: this.retry, maxModelCalls: this.maxModelCalls, hooks: this.options.modelCalls, deadline: timeout, checkpoint: observer ? checkpoint : undefined });
        if (response.usage) await timeout.run(() => this.usage.record(response.usage!, context));
        const said = textFrom(response.content);
        const requested = response.content.filter((block): block is Extract<AssistantBlock, { type: "tool_use" }> => block.type === "tool_use");
        const usedIds = new Set(report.toolCalls.map((call) => call.id));
        for (const request of requested) {
          if (typeof request.id !== "string" || !request.id.trim() || usedIds.has(request.id)) {
            throw new RuntimeError("provider tool call IDs must be nonempty and unique within a turn", "invalid_tool_call");
          }
          usedIds.add(request.id);
        }
        const pending: ToolCallRecord[] = requested.map((request) => ({
          id: request.id, name: request.name, input: structuredClone(request.input), ok: false, status: "not_started", receiptIds: [],
        }));
        report.toolCalls.push(...pending);
        if (pending.length) await checkpoint();
        if (response.stopReason === "refusal") throw new RuntimeError("provider refused the request", "provider_refused");
        if (response.stopReason === "content_filter") throw new RuntimeError("provider filtered the response", "provider_filtered");
        if (input.structuredOutput && (requested.length || response.stopReason === "tool_use")) throw new RuntimeError("structured output returned a tool call", "unexpected_tool_use");
        if (response.stopReason !== "tool_use") {
          if (requested.length) throw new RuntimeError("provider returned tool calls without a tool-use stop", "unexpected_tool_use");
          if (response.stopReason !== "end_turn" && response.stopReason !== "stop_sequence") throw new RuntimeError(`provider stopped before completing the turn: ${response.stopReason}`, "incomplete_stop");
          if (input.structuredOutput) {
            let value: TValue;
            try { value = await timeout.run(() => input.structuredOutput!.parse(JSON.parse(said))); }
            catch (error) {
              timeout.check();
              throw new RuntimeError("structured output failed validation", "structured_output_invalid", { cause: error });
            }
            return { ...snapshot(report), choice: undefined, status: "structured", value, output: said, accepted: true, issues: [], finishReason: response.stopReason };
          }
          if (input.choice && (input.choice.required ?? true) && report.choice === undefined) throw new RuntimeError(`turn ended without required choice ${choiceName}`, "choice_required");
          if (awaitingToolAnswer && !said && report.choice === undefined) throw new RuntimeError("provider ended without answering after a tool result", "missing_tool_answer");
          const policy = await timeout.run(() => this.outputPolicy.apply(said, context));
          return {
            ...snapshot(report), status: policy.accepted ? (policy.output ? "reply" : "silence") : "rejected",
            output: policy.output, accepted: policy.accepted, issues: policy.issues ?? [], finishReason: response.stopReason,
          };
        }
        if (!requested.length) throw new RuntimeError("provider stopped for tool use without a tool call", "missing_tool_call");
        if (hop + 1 >= this.maxHops) throw new RuntimeError("tool hop limit reached before executing another tool", "tool_hop_limit");
        if (report.modelCalls.length >= this.maxModelCalls) throw new RuntimeError("no model call remains to interpret a tool result", "model_call_limit");
        messages.push({ role: "assistant", content: response.content });
        const results: ToolResultBlock[] = [];

        for (const [index, request] of requested.entries()) {
          timeout.check();
          const call = pending[index];
          let value: unknown;
          let mode: "read" | "write" = "write";
          try {
            if (!allowed.has(request.name)) throw new RuntimeError(`tool is not allowed in this turn: ${request.name}`, "tool_not_allowed");
            if (request.name === choiceName && input.choice) {
              if (report.choice !== undefined) throw new RuntimeError("choice already made", "choice_already_made");
              value = await timeout.run(() => input.choice!.parse ? input.choice!.parse(request.input) : request.input as TChoice);
              if (value === undefined) throw new RuntimeError("choice cannot be undefined", "choice_invalid");
              report.choice = structuredClone(value as TChoice);
              await checkpoint();
              if (input.choice.onChoice) {
                await checkpointToolStart(call);
                await timeout.run(() => input.choice!.onChoice!(structuredClone(report.choice!), context));
              }
              value = { ok: true, chosen: structuredClone(report.choice) };
            } else {
              mode = this.tools.mode(request.name);
              if (input.choice && mode === "write") {
                if (report.choice === undefined && input.choice.requiredFirst) throw new RuntimeError(`write tool ${request.name} requires ${choiceName} first`, "choice_required_before_write");
                if (report.choice !== undefined) {
                  const authorized = await timeout.run(() => input.choice!.authorizeWrite?.(structuredClone(report.choice!), { name: request.name, input: request.input }, context) ?? false);
                  if (authorized !== true) throw new RuntimeError(`choice did not authorize write tool ${request.name}`, "choice_write_not_authorized");
                }
              }
              value = await timeout.run(() => this.tools.execute(request.name, request.input, {
                ...context, toolCallId: request.id,
                recordReceipt: (receiptId) => {
                  if (typeof receiptId !== "string" || !receiptId.trim()) throw new TypeError("receiptId must be a nonempty string");
                  call.receiptIds.push(receiptId);
                },
              }, () => { timeout.check(); return checkpointToolStart(call); }));
            }
            call.status = "completed";
            call.ok = true;
            await checkpoint();
          } catch (error) {
            timeout.check();
            if (error instanceof RuntimeError && error.code === "checkpoint_failed") throw error;
            call.errorCode = error instanceof RuntimeError ? error.code : "tool_failed";
            if (call.status === "unknown" && mode === "write") throw new RuntimeError(`tool ${request.name} may have caused effects`, "tool_outcome_unknown", { cause: error });
            if ((request.name === choiceName && report.choice !== undefined) || this.options.toolErrorMode === "throw") throw new RuntimeError(`tool ${request.name} failed`, "tool_failed", { cause: error });
            results.push({ type: "tool_result", toolUseId: request.id, isError: true,
              content: await this.toolResult({ error: error instanceof Error ? error.message : String(error), code: call.errorCode }, call, context, timeout) });
            continue;
          }
          results.push({ type: "tool_result", toolUseId: request.id, content: await this.toolResult(value, call, context, timeout) });
        }
        messages.push({ role: "user", content: results });
        awaitingToolAnswer = true;
      }
      throw new RuntimeError("tool hop limit exhausted", "tool_hop_limit");
    } catch (error) {
      throw new RuntimeError(error instanceof Error ? error.message : "turn failed",
        error instanceof RuntimeError ? error.code : "turn_failed", {
          cause: error instanceof RuntimeError ? error.cause ?? error : error,
          report: snapshot(report),
        });
    } finally {
      timeout.dispose();
    }
  }
}
