# Small Hour

Small Hour is a provider-neutral TypeScript runtime for bounded LLM turns. It assembles consumer-supplied instructions and context, executes registered tools, applies output validation, and returns structured execution reports.

The runtime owns execution within a turn. An optional SQLite operation store commits local application effects and execution receipts atomically. Consuming applications define workflows, facts, authorization, memory policy, scheduling, and delivery.

## Capabilities

- Anthropic, OpenAI Responses, and OpenAI-compatible Chat Completions adapters.
- Fresh system instructions and consumer-selected memory for each turn, with no retained session history.
- Sequential tool dispatch with per-turn allowlists, input parsers, and read/write modes.
- Structured choices with optional consumer authorization of subsequent writes.
- Structured results with mandatory consumer validation and no tool loop.
- Configurable model-call budgets, retries, deadlines, token limits, and tool-result limits.
- Per-attempt admission and accounting hooks, token usage, and partial failure reports.
- Transactional local operation receipts with scoped request identity, contract-conflict rejection, and validated result replay.

The interface supports text, tool calls, and structured results. Streaming, image input, and audio input are not exposed.

## Usage

Requires Node.js 20 or later and an ESM consumer. Install repository dependencies with `npm ci` and build with `npm run build`. Package exports resolve to the generated `dist` directory.

1. Configure a provider adapter with a model, credentials, and endpoint as required.
2. Construct `SmallHourRuntime` with `provider`, `persona`, and `memory`. `PersonaSource.load(context)` supplies system instructions; `MemorySource.load(context)` supplies a bounded context view. Both are loaded on every turn. `StaticPersonaSource` and `EmptyMemorySource` provide static instructions and empty context.
3. Register consumer-implemented functions through `ToolRegistry`, and configure execution limits and any validation, admission, or accounting hooks.
4. Call `runtime.turn()` with `agentId` and `input`. An explicit `turnId` and `AbortSignal` are optional. `allowedTools` narrows the registry for that turn and is enforced at dispatch.
5. Handle the result or `RuntimeError`. Text turns return `reply`, `silence`, or `rejected`; structured turns return `structured` with a typed `value`. Failed turns carry a partial `report`.

Tool definitions provide `name`, `description`, `inputSchema`, and `execute`. Optional `parse` and `mode` fields control input validation and read/write classification.

For structured results, supply `structuredOutput` with a JSON Schema and a mandatory `parse` function. This mode requires one successful provider call; transport retries remain subject to the turn budget. It offers no tools and cannot be combined with `allowedTools` or `choice`.

For a validated decision within a tool turn, configure `choice` with a parser and, where required, `authorizeWrite`. An accepted choice remains in the report if later work fails.

See [embedding](docs/embedding.md) for the complete integration contracts.

## Local operation receipts

Import `SqliteOperationStore` from `small-hour/durable/sqlite` and pass an existing synchronous SQLite connection. Call `initialize()` explicitly to create the receipt table. The adapter accepts the `exec`, `prepare`, `get`, and `run` methods supplied by `node:sqlite` or `better-sqlite3`; connection lifecycle and configuration remain application-owned.

`commit(request, { execute, parseResult })` binds `scope` and `id` to a `kind`, contract `version`, and JSON `input`. It executes synchronous application database work and stores the validated result in the same transaction. A duplicate returns the original `receipt` with `replayed: true`. `find(request, parseResult)` reads a completed receipt without executing work. Result parsers must validate and preserve the recorded JSON value.

The application may stage pending output in the same transaction. An existing outer transaction controls final commit. This API does not checkpoint model calls, dispatch output, or make remote effects atomic. See [local operation contracts](docs/local-operations.md).

## Providers

| Adapter | Import path | Protocol |
| --- | --- | --- |
| `AnthropicProvider` | `small-hour/providers/anthropic` | Anthropic Messages |
| `OpenAIProvider` | `small-hour/providers/openai` | OpenAI Responses |
| `OpenAICompatibleProvider` | `small-hour/providers/openai-compatible` | OpenAI-compatible Chat Completions |

Included adapters leave retries to the runtime. Anthropic SDK retries are disabled; the HTTP adapters issue one request per attempt. OpenAI Responses requests use `store: false` and preserve native reasoning data within the turn.

The compatible adapter requires an explicit `baseURL`. Tool and structured-output capabilities default to disabled and must be enabled only for a verified server/model combination. Local model loading and serving remain external to the package.

## Execution limits and failures

| Configuration | Default |
| --- | --- |
| `timeoutMs` | 30,000 |
| `maxHops` | 6 |
| `retry.attempts` | 3 |
| `maxModelCalls` | `maxHops × retry.attempts` |
| `maxTokens` | 512 |
| `maxToolResultCharacters` | 4,000 |

`maxModelCalls` counts provider attempts across all hops and retries. The turn deadline covers context loading, provider calls, retry waits, tools, and callbacks. Oversized tool results fail unless `toolResultOverflow` supplies a bounded replacement; the runtime does not truncate results automatically.

Token limits follow provider semantics: Anthropic adds an explicit thinking budget to `maxTokens`; OpenAI includes reasoning in that limit and uses the adapter's `reasoningEffort` option instead of a numeric thinking budget.

Reports retain model attempts, known usage, accepted choices, tool outcomes, and consumer-supplied receipt IDs. Tool outcomes distinguish `not_started`, `completed`, and `unknown`. A write failure after execution starts ends the turn with `tool_outcome_unknown`. Incomplete provider output fails; output rejection does not replay the turn.

Reports are in-memory snapshots. Cancellation prevents new work but cannot undo effects or forcibly interrupt implementations that ignore the signal. A completed tool call does not independently establish durable persistence or delivery.

## Consumer responsibilities

- **Context and memory:** implement retrieval, selection, size bounds, persistence, retention, and privacy policy. The runtime stores no cross-turn conversation or long-term memory.
- **Identity and authorization:** authenticate callers and authorize data access and effects. `agentId` is a context key, not an authentication mechanism.
- **Tools and validation:** implement tools, validate external inputs and domain constraints, and configure output acceptance. The default text policy accepts output; structured results always require a consumer parser.
- **Durable effects and recovery:** use the optional SQLite store for atomic local operations, or supply equivalent persistence. Select stable scoped IDs, validate current facts and permissions, retain receipts for the duplicate-request window, and reconcile remote or uncertain work. Model-step recovery remains application-owned; `recordReceipt()` only adds a reference to the turn report.
- **Spending:** supply credentials, pricing, persistent budgets, and reservation/accounting policy through the available hooks. Independent model calls inside consumer tools or context loaders require separate budgeting.
- **Application services:** provide the database connection, scheduling, concurrency policy, delivery, and user interfaces. No database server, workflow worker, scheduler, or transport service is bundled.

See [security boundaries](docs/security.md).

## Development status

Version 0.1.0. The API is under development.

Use Node.js 22.13 or later to run `npm run check` for type checking, behavioral tests, and the build. SQLite tests use `node:sqlite`; runtime imports remain compatible with Node.js 20 and a consumer-supplied SQLite driver. The checks cover runtime, provider, and local transaction contracts; live-model behavior and consumer integrations require separate verification.
