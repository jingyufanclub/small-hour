import OpenAI from "openai";
import { RuntimeError, type AssistantBlock, type ModelProvider, type ProviderMessage, type ProviderRequest, type ProviderResponse } from "../types.js";
import { validateImageMessages } from "../input.js";
import { array, HttpProviderError, httpFailureInfo, invalidResponse, isObject, isRetryableHttpError, object, opaquePayload, string, tokenUsage } from "./http.js";

export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  fetch?: typeof globalThis.fetch;
}

function inputItems(messages: readonly ProviderMessage[]): unknown[] {
  return messages.flatMap((message): unknown[] => {
    if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
    if (message.role === "assistant") {
      const native = opaquePayload(message.content, "openai-responses");
      if (native !== undefined) return array(native);
      return message.content.map((block) => {
        if (block.type === "text") return { role: "assistant", content: block.text };
        if (block.type === "tool_use") return { type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) };
        throw new RuntimeError("unsupported provider history", "provider_history_invalid");
      });
    }
    const items: unknown[] = [];
    const multimodal = message.content.some(block => block.type === "image");
    let parts: unknown[] = [];
    const flush = () => {
      if (parts.length) { items.push({ role: "user", content: parts }); parts = []; }
    };
    for (const block of message.content) {
      if (block.type === "text" && !multimodal) items.push({ role: "user", content: block.text });
      else if (block.type === "tool_result") {
        flush();
        items.push({ type: "function_call_output", call_id: block.toolUseId, output: block.content });
      } else parts.push(block.type === "text"
        ? { type: "input_text", text: block.text }
        : { type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` });
    }
    flush();
    return items;
  });
}

function decode(data: Record<string, unknown>, requestId?: string): ProviderResponse {
  const output = array(data.output);
  const content: AssistantBlock[] = [{ type: "opaque", value: { protocol: "openai-responses", payload: output } }];
  let refusal = false;
  let incomplete = false;
  let visibleMessage = false;
  for (const value of output) {
    const item = object(value);
    if (item.status !== undefined && item.status !== "completed") incomplete = true;
    if (item.type === "function_call") {
      content.push({ type: "tool_use", id: string(item.call_id), name: string(item.name), input: object(JSON.parse(string(item.arguments))) });
    } else if (item.type === "message") {
      if (item.role !== "assistant") throw new Error("expected an assistant message");
      if (item.phase != null && item.phase !== "commentary" && item.phase !== "final_answer") incomplete = true;
      for (const part of array(item.content)) {
        const block = object(part);
        if (block.type === "refusal") refusal = true;
        else if (block.type === "output_text") {
          const text = string(block.text);
          if (item.phase !== "commentary") { visibleMessage = true; content.push({ type: "text", text }); }
        } else incomplete = true;
      }
    } else if (item.type !== "reasoning") incomplete = true;
  }
  const usage = isObject(data.usage) ? data.usage : {};
  const details = data.incomplete_details == null ? {} : object(data.incomplete_details);
  let stopReason: ProviderResponse["stopReason"] = "unknown";
  if (data.status === "incomplete") {
    if (details.reason === "max_output_tokens") stopReason = "max_tokens";
    else if (details.reason === "content_filter") stopReason = "content_filter";
  } else if (data.status === "completed" && data.error == null && !incomplete) {
    if (refusal) stopReason = "refusal";
    else if (content.some((block) => block.type === "tool_use")) stopReason = "tool_use";
    else if (visibleMessage) stopReason = "end_turn";
  }
  return { content, stopReason, requestId, usage: tokenUsage(data.model, usage.input_tokens, usage.output_tokens, usage.input_tokens_details) };
}

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly capabilities = { tools: true, structuredOutput: true, thinkingBudget: false, images: true };
  private readonly client: OpenAI;
  get model(): string { return this.options.model; }
  constructor(private readonly options: OpenAIProviderOptions) {
    if (!options.model.trim()) throw new TypeError("OpenAI model is required");
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!apiKey.trim()) throw new TypeError("OpenAI apiKey or OPENAI_API_KEY is required");
    const send = options.fetch ?? globalThis.fetch;
    this.client = new OpenAI({ apiKey, adminAPIKey: null, baseURL: "https://api.openai.com/v1", organization: null, project: null,
      maxRetries: 0, logLevel: "off", fetchOptions: { redirect: "error" },
      fetch: async (url, init) => {
        const response = await send(url, init);
        if (response.ok) return response;
        // Preserve HTTP status evidence without waiting for an error body.
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      },
      // The runtime deadline is at most Node's timer maximum and aborts this request first.
      timeout: 2_147_483_647,
    });
  }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    validateImageMessages(request.messages, true);
    if (request.thinking) throw new RuntimeError("OpenAI uses reasoningEffort instead of a thinking token budget", "thinking_unsupported");
    const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.model, instructions: request.system.map((block) => block.text).join("\n\n"),
      input: inputItems(request.messages) as OpenAI.Responses.ResponseInput,
      max_output_tokens: request.maxTokens, store: false, stream: false, truncation: "disabled",
      ...(this.options.reasoningEffort ? { reasoning: { effort: this.options.reasoningEffort } } : {}),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", name: tool.name,
        description: tool.description, parameters: tool.inputSchema, strict: tool.strict ?? true,
      })) } : {}),
      ...(request.outputSchema ? { text: { format: { type: "json_schema", name: "small_hour_result", strict: true, schema: request.outputSchema } } } : {}),
    };
    request.trace?.request(body);
    const pending = this.client.responses.create(body, { signal: request.signal, maxRetries: 0 });
    let response: Response;
    try { response = await pending.asResponse(); }
    catch (error) {
      if (error instanceof OpenAI.APIConnectionError) {
        throw new HttpProviderError("provider connection failed", undefined, undefined, true, { cause: error });
      }
      if (error instanceof OpenAI.APIError && error.status !== undefined) {
        throw new HttpProviderError(`provider returned HTTP ${error.status}`, error.status,
          error.requestID ?? error.headers?.get("request-id") ?? undefined,
          [408, 409, 429].includes(error.status) || error.status >= 500);
      }
      throw error;
    }
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    try {
      const data = object(await pending);
      request.trace?.response(data);
      return decode(data, requestId);
    }
    catch (error) { throw invalidResponse(error, requestId); }
  }
  isRetryable = isRetryableHttpError;
  failureInfo = httpFailureInfo;
}
