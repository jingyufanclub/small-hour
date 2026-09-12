import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantBlock,
  ModelProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  SystemBlock,
} from "../types.js";

export interface AnthropicProviderOptions {
  model: string;
  client?: Anthropic;
  apiKey?: string;
}

function anthropicSystem(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  return blocks.map((block) => ({
    type: "text",
    text: block.text,
    ...(block.cache ? { cache_control: { type: block.cache } } : {}),
  }));
}

function anthropicMessages(messages: ProviderMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content.map((block) => {
          if (block.type === "text") return { type: "text", text: block.text };
          if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
          return block.value;
        }) as Anthropic.ContentBlockParam[],
      };
    }
    return {
      role: "user",
      content: message.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "tool_result", tool_use_id: block.toolUseId, content: block.content, ...(block.isError ? { is_error: true } : {}) }) as Anthropic.ContentBlockParam[],
    };
  });
}

function genericContent(content: Anthropic.ContentBlock[]): AssistantBlock[] {
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    return { type: "opaque", value: block };
  });
}

function stopReason(reason: Anthropic.Message["stop_reason"]): ProviderResponse["stopReason"] {
  if (reason === "end_turn" || reason === "tool_use" || reason === "max_tokens" || reason === "stop_sequence") return reason;
  return "unknown";
}

function tokenUsage(message: Anthropic.Message): ProviderResponse["usage"] {
  if (!message.usage) return undefined;
  const usage = {
    model: message.model,
    freshInputTokens: message.usage.input_tokens,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    outputTokens: message.usage.output_tokens,
  };
  const counts = [usage.freshInputTokens, usage.cacheWriteTokens, usage.cacheReadTokens, usage.outputTokens];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) ? usage : undefined;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly capabilities = { structuredOutput: true };
  private readonly client: Anthropic;

  get model(): string { return this.options.model; }

  constructor(private readonly options: AnthropicProviderOptions) {
    if (!options.model.trim()) throw new TypeError("Anthropic model is required");
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const message = await this.client.messages.create({
      model: this.options.model,
      max_tokens: request.maxTokens + (request.thinking?.budgetTokens ?? 0),
      system: anthropicSystem(request.system),
      ...(request.tools.length ? {
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          strict: tool.strict ?? true,
        })),
      } : {}),
      ...(request.thinking ? { thinking: { type: "enabled" as const, budget_tokens: request.thinking.budgetTokens } } : {}),
      ...(request.outputSchema ? { output_config: { format: { type: "json_schema" as const, schema: request.outputSchema } } } : {}),
      messages: anthropicMessages(request.messages),
    }, { signal: request.signal, maxRetries: 0 });

    return {
      content: genericContent(message.content),
      stopReason: stopReason(message.stop_reason),
      requestId: message._request_id ?? undefined,
      usage: tokenUsage(message),
    };
  }

  failureInfo(error: unknown): { status: "rejected" | "unknown"; requestId?: string } {
    const failure = error as { status?: unknown; requestID?: unknown } | null;
    const status = Number(failure?.status ?? 0);
    return {
      status: status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown",
      ...(typeof failure?.requestID === "string" ? { requestId: failure.requestID } : {}),
    };
  }

  isRetryable(error: unknown): boolean {
    const status = Number((error as { status?: number })?.status ?? 0);
    const name = String((error as { constructor?: { name?: string }; name?: string })?.constructor?.name
      ?? (error as { name?: string })?.name
      ?? "");
    return name === "APIConnectionError" || name === "APIConnectionTimeoutError"
      || status === 408 || status === 409 || status === 429 || status >= 500;
  }
}
