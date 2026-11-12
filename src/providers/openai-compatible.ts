import { RuntimeError, type AssistantBlock, type ModelProvider, type ProviderMessage, type ProviderRequest, type ProviderResponse } from "../types.js";
import { validateImageMessages } from "../input.js";
import { array, endpoint, httpFailureInfo, invalidResponse, isObject, isRetryableHttpError, object, opaquePayload, postJson, string, tokenUsage } from "./http.js";

export interface OpenAICompatibleProviderOptions {
  model: string;
  baseURL: string;
  apiKey?: string;
  temperature?: number;
  reasoningEffort?: string;
  capabilities?: { tools?: boolean; structuredOutput?: boolean; images?: boolean };
  fetch?: typeof globalThis.fetch;
}

function chatMessages(messages: readonly ProviderMessage[]): unknown[] {
  return messages.flatMap((message): unknown[] => {
    if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
    if (message.role === "assistant") {
      const native = opaquePayload(message.content, "openai-chat");
      if (native !== undefined) return [object(native)];
      const text: string[] = [];
      const calls: unknown[] = [];
      for (const block of message.content) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "tool_use") calls.push({ type: "function", id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } });
        else throw new RuntimeError("unsupported provider history", "provider_history_invalid");
      }
      return [{ role: "assistant", content: text.length ? text.join("") : null, ...(calls.length ? { tool_calls: calls } : {}) }];
    }
    const items: unknown[] = [];
    const multimodal = message.content.some(block => block.type === "image");
    let parts: unknown[] = [];
    const flush = () => {
      if (parts.length) { items.push({ role: "user", content: parts }); parts = []; }
    };
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (multimodal) parts.push({ type: "text", text: block.text });
          else items.push({ role: "user", content: block.text });
          break;
        case "image":
          parts.push({ type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } });
          break;
        case "tool_result":
          flush();
          items.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
          break;
      }
    }
    flush();
    return items;
  });
}

function decode(data: Record<string, unknown>, requestId?: string): ProviderResponse {
  const choices = array(data.choices);
  if (choices.length !== 1) throw new Error("expected one completion choice");
  const choice = object(choices[0]);
  const message = object(choice.message);
  if (message.role !== "assistant") throw new Error("expected an assistant message");
  const content: AssistantBlock[] = [{ type: "opaque", value: { protocol: "openai-chat", payload: message } }];
  if (message.content != null) content.push({ type: "text", text: string(message.content) });
  if (message.tool_calls != null) for (const value of array(message.tool_calls)) {
    const call = object(value);
    if (call.type !== "function") throw new Error("unsupported tool call type");
    const fn = object(call.function);
    content.push({ type: "tool_use", id: string(call.id), name: string(fn.name), input: object(JSON.parse(string(fn.arguments))) });
  }
  const usage = isObject(data.usage) ? data.usage : {};
  let stopReason: ProviderResponse["stopReason"] = "unknown";
  if (message.refusal) stopReason = "refusal";
  else if (!message.function_call) {
    if (choice.finish_reason === "length") stopReason = "max_tokens";
    else if (choice.finish_reason === "content_filter") stopReason = "content_filter";
    else if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
    else if (choice.finish_reason === "stop" && typeof message.content === "string") stopReason = "end_turn";
  }
  return { content, stopReason, requestId, responseId: typeof data.id === "string" && data.id.trim() ? data.id : undefined, usage: tokenUsage(data.model, usage.prompt_tokens, usage.completion_tokens, usage.prompt_tokens_details) };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = "openai-compatible";
  readonly capabilities;
  private readonly url: string;
  get model(): string { return this.options.model; }
  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.options = { ...options };
    if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2))
      throw new TypeError("temperature must be between 0 and 2");
    if (options.reasoningEffort !== undefined && (typeof options.reasoningEffort !== "string" || !options.reasoningEffort.trim()))
      throw new TypeError("reasoning effort must be a nonempty server-supported name");
    if (!options.model.trim()) throw new TypeError("compatible provider model is required");
    this.url = endpoint(options.baseURL, "chat/completions");
    this.capabilities = { tools: options.capabilities?.tools === true, structuredOutput: options.capabilities?.structuredOutput === true, thinkingBudget: false, images: options.capabilities?.images === true };
  }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    validateImageMessages(request.messages, this.capabilities.images);
    if (request.thinking) throw new RuntimeError("compatible provider does not support a thinking token budget", "thinking_unsupported");
    if (request.tools.length && !this.capabilities.tools) throw new RuntimeError("tool support must be enabled for this model and server", "tools_unsupported");
    if (request.outputSchema && !this.capabilities.structuredOutput) throw new RuntimeError("structured output support must be enabled for this model and server", "structured_output_unsupported");
    const body = {
      model: this.model, messages: [{ role: "system", content: request.system.map((block) => block.text).join("\n\n") }, ...chatMessages(request.messages)],
      max_tokens: request.maxTokens, stream: false,
      ...(this.options.reasoningEffort !== undefined ? { reasoning_effort: this.options.reasoningEffort } : {}),
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: tool.strict ?? true,
      } })) } : {}),
      ...(request.outputSchema ? { response_format: { type: "json_schema", json_schema: { name: "small_hour_result", strict: true, schema: request.outputSchema } } } : {}),
    };
    request.trace?.request(body);
    const { data, requestId } = await postJson(this.url, body, request.signal, this.options.apiKey, this.options.fetch);
    request.trace?.response(data);
    try { return decode(data, requestId); } catch (error) { throw invalidResponse(error, requestId); }
  }
  isRetryable = isRetryableHttpError;
  failureInfo = httpFailureInfo;
}
