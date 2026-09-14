# Providers

| Adapter | Import | Protocol |
| --- | --- | --- |
| `AnthropicProvider` | `small-hour/providers/anthropic` | Anthropic Messages |
| `OpenAIProvider` | `small-hour/providers/openai` | OpenAI Responses |
| `OpenAICompatibleProvider` | `small-hour/providers/openai-compatible` | Chat Completions |

Adapters translate messages, tools, reasoning, stop reasons, and usage. Configure a supported model and trusted endpoint. The runtime owns retries; Anthropic disables SDK retries, including for injected clients. HTTP adapters issue one request per attempt and reject redirects.

## Anthropic

Configure the model and credentials. Structured output uses [`output_config.format`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) with the supplied schema unchanged. Provider schema support and the application parser both apply.

`maxTokens` bounds ordinary output; an explicit thinking budget is added where supported. Native signed thinking and other opaque blocks are echoed unchanged within the turn.

## OpenAI

Uses [`POST /v1/responses`](https://developers.openai.com/api/docs/guides/function-calling) with `store: false` and `truncation: "disabled"`. It supplies no conversation ID or previous-response lookup. This request setting does not describe every provider retention policy.

Native output items preserve reasoning, exact call IDs, and assistant phases within the tool loop. Commentary-phase text is excluded from final output. Opaque provider history must remain unchanged and cannot be combined with another provider's history; Small Hour does not retain it across turns.

Schemas are sent unchanged. Strict schemas must satisfy provider requirements. `maxTokens` becomes `max_output_tokens`, including reasoning. Use `reasoningEffort` on supported models; `thinking.budgetTokens` is rejected before admission because it has no exact equivalent.

## Compatible endpoints

Supply an explicit `baseURL`, normally ending in `/v1`; requests target `/chat/completions`. Credentials come only from the explicit `apiKey`. No cloud endpoint, credential, model, or fallback is selected automatically. Model loading and serving remain external.

Text is enabled by default. Tools and `response_format.json_schema` require explicit capability settings verified against the selected server/model. Unsupported tools, required-choice settings, structured output, and thinking budgets fail before admission. `maxTokens` is sent as `max_tokens`.

The adapter does not recover tool calls from prose or repair invalid JSON with another model call. Application parsers and tool allowlists still enforce acceptance after a response.

## Failures and usage

Refusals and filtering throw `provider_refused` or `provider_filtered` with the partial report. Incomplete or malformed responses cannot authorize tool execution or accepted output. HTTP 4xx errors other than 408 establish rejection; server and connection failures retain uncertainty.

Missing or invalid usage remains unknown while valid output and request IDs are preserved. Reported cached input is separated from fresh input; output usage includes reasoning where the provider reports it in the total. Accounting units and prices are application policy.
