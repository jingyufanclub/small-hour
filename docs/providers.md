# Providers

| Adapter | Import | Protocol |
| --- | --- | --- |
| `AnthropicProvider` | `small-hour/providers/anthropic` | Anthropic Messages |
| `OpenAIProvider` | `small-hour/providers/openai` | OpenAI Responses |
| `OpenAICompatibleProvider` | `small-hour/providers/openai-compatible` | Chat Completions |

Adapters translate messages, tools, reasoning, stop reasons, and usage. Configure a supported model and trusted endpoint. The runtime owns retries; Anthropic disables SDK retries, including for injected clients. HTTP adapters issue one request per attempt and reject redirects.

Anthropic and OpenAI Responses support bounded [image input](images.md); choose a vision-capable model. The compatibility adapter rejects images before admission or HTTP. Image capability is explicit for custom providers; absence does not grant support.

## Anthropic

Configure the model and credentials. Structured output uses [`output_config.format`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) with the supplied schema unchanged. Provider schema support and the application parser both apply.

For models supporting adaptive thinking, configure it explicitly on the adapter:

```ts
const provider = new AnthropicProvider({
  model,
  thinking: { type: "adaptive", effort: "medium" },
});
```

Adaptive mode uses `maxTokens` as the total per-call output ceiling, including thinking. Effort is optional soft guidance, not a token or spending limit; supported levels depend on the selected model. Small Hour does not infer capabilities from model names or choose effort automatically. The adapter snapshots its thinking configuration when constructed. Structured-output schemas and effort are sent together.

Do not combine adaptive mode with a turn's `thinking.budgetTokens`; the runtime rejects that combination before context loading or model admission. Without adapter thinking configuration, requests retain their existing behavior: a manual turn budget sends `thinking.type: "enabled"` and adds that budget to `maxTokens` for the combined output ceiling. Choose a model that supports the requested mode. See [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).

Native signed thinking and other opaque blocks are echoed unchanged within the turn and excluded from final text. Spending quotes must cover the full output allowance and input costs. Bind model, thinking mode, effort and pricing revisions into the application's immutable [model-step contract](model-steps.md); adapter settings are not fingerprinted automatically.

## OpenAI

Uses [`POST /v1/responses`](https://developers.openai.com/api/docs/guides/function-calling) with `store: false` and `truncation: "disabled"`. It supplies no conversation ID or previous-response lookup. This request setting does not describe every provider retention policy.

Native output items preserve reasoning, exact call IDs, and assistant phases within the tool loop. Commentary-phase text is excluded from final output. Opaque provider history must remain unchanged and cannot be combined with another provider's history; Small Hour does not retain it across turns.

Schemas are sent unchanged. Strict schemas must satisfy provider requirements. `maxTokens` becomes `max_output_tokens`, including reasoning. Use `reasoningEffort` on supported models; `thinking.budgetTokens` is rejected before admission because it has no exact equivalent.

For example, `new OpenAIProvider({ model: "gpt-5.6-luna", reasoningEffort: "low" })` uses the existing adapter. [Luna supports](https://developers.openai.com/api/docs/models/gpt-5.6-luna) `none`, `low`, `medium`, `high`, `xhigh` and `max`; `minimal` remains available for other models that support it. Effort guides reasoning rather than capping spending. An exhausted output allowance fails as incomplete; it does not authorize another call automatically. Keep model, effort and pricing in the application's workflow revision. Account access and task quality require live verification with the selected model.

## Compatible endpoints

Supply an explicit `baseURL`, normally ending in `/v1`; requests target `/chat/completions`. Credentials come only from the explicit `apiKey`. No cloud endpoint, credential, model, or fallback is selected automatically. Model loading and serving remain external.

Text is enabled by default. Tools and `response_format.json_schema` require explicit capability settings verified against the selected server/model. Unsupported tools, required-choice settings, structured output, and thinking budgets fail before admission. `maxTokens` is sent as `max_tokens`.

The adapter does not recover tool calls from prose or repair invalid JSON with another model call. Application parsers and tool allowlists still enforce acceptance after a response.

## Failures and usage

Refusals and filtering throw `provider_refused` or `provider_filtered` with the partial report. Incomplete or malformed responses cannot authorize tool execution or accepted output. HTTP 4xx errors other than 408 establish rejection; server and connection failures retain uncertainty.

Missing or invalid usage remains unknown while valid output and request IDs are preserved. Reported cached input is separated from fresh input; output usage includes reasoning where the provider reports it in the total. Accounting units and prices are application policy.
