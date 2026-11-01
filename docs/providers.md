# Choose a model provider

A provider adapter translates Small Hour's calls into a provider's API. Supply the model you want; verify that your account and model support the features you enable.

| Adapter | Import path | API |
| --- | --- | --- |
| `AnthropicProvider` | `small-hour/providers/anthropic` | Messages |
| `OpenAIProvider` | `small-hour/providers/openai` | Responses |
| `OpenAICompatibleProvider` | `small-hour/providers/openai-compatible` | Chat Completions |

Anthropic and OpenAI use official SDKs. The compatible adapter uses HTTP. Small Hour owns retries; SDK retries are disabled. All adapters request redirect rejection. Custom clients/fetch implementations are trusted application code and must honor these options.

## Anthropic

```ts
import { AnthropicProvider } from "small-hour/providers/anthropic";

const provider = new AnthropicProvider({
  model,
  thinking: { type: "adaptive", effort: "medium" },
});
```

Choose a model supporting adaptive thinking for this example; omit `thinking` to leave it unconfigured. Credentials use explicit `apiKey` or `ANTHROPIC_API_KEY`; a blank explicit key fails.

The managed client fixes `https://api.anthropic.com` and disables SDK logging. Ambient endpoint, bearer-token, or profile settings do not select the connection. Nonblank `ANTHROPIC_CUSTOM_HEADERS` fails construction. Custom endpoints/authentication require an explicit app-owned `client`; review its credentials, headers, logging, and redirects.

Adaptive thinking shares the `maxTokens` output ceiling. Effort guides reasoning; it is not a money limit. Manual turn-level `thinking.budgetTokens` instead adds that budget to `maxTokens`. Never combine manual and adaptive modes.

Optional `temperature` accepts 0–1 on supporting models; explicit zero is preserved. It cannot combine with thinking.

## OpenAI

```ts
import { OpenAIProvider } from "small-hour/providers/openai";

const provider = new OpenAIProvider({ model, reasoningEffort: "low" });
```

Credentials use `apiKey` or `OPENAI_API_KEY`. The managed endpoint is `https://api.openai.com/v1`; environment settings cannot override endpoint, organization, project, or logging.

Requests set `store: false` and `truncation: "disabled"`, without conversation lookup. This does not describe every provider retention policy.

`maxTokens` becomes `max_output_tokens`, including reasoning. Choose an effort supported by the model. Manual thinking budgets are rejected before admission. Optional `temperature` accepts 0–2 when the selected model supports sampling. It cannot combine with an explicit reasoning effort other than `none`; unsupported model settings remain provider errors.

## Compatible endpoints

```ts
import { OpenAICompatibleProvider } from "small-hour/providers/openai-compatible";

const provider = new OpenAICompatibleProvider({
  model, baseURL, apiKey,
  capabilities: { tools: true, structuredOutput: true, images: true },
});
```

Supply your server's `baseURL`, normally ending in `/v1`. Only explicit credentials are used. No server, model, or fallback is selected automatically.

Text works by default. Enable the shown capabilities only after verifying server/model support. Images use ordered Chat Completions content parts with base64 data URLs. Thinking budgets are unsupported. `maxTokens` becomes `max_tokens`.

## Shared behavior

All three adapters support [images](images.md) with compatible models; compatible endpoints require explicit opt-in. Schemas are sent unchanged; Small Hour runs your [parser](embedding.md#structured-results) afterward. SDK types do not validate actual output.

The compatible adapter forwards optional `temperature` (0–2) unchanged; configure it only when the local model/server supports sampling.

Native reasoning and call IDs stay intact inside the tool exchange; provider history is not retained across turns. Refused, filtered, malformed, or incomplete responses cannot authorize accepted output or tools. Missing usage remains unknown. Bind provider settings and prices to saved workflow versions.
