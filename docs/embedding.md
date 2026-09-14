# Embedding

`SmallHourRuntime` accepts a provider, instruction source, memory source, and optional tools and policies. Each `turn()` loads instructions and selected context concurrently, appends the current input, and executes a bounded model/tool loop. The core retains no cross-turn history.

## Context and tools

`agentId` is an application-selected partition key. Use it consistently for context, authorization, usage, and effects. Supply a bounded view through `MemorySource.load()`; select relevant facts before encoding or shortening them.

Register tools with `name`, `description`, `inputSchema`, and `execute`. Optional `parse` validates external arguments. Declare `mode: "read" | "write"`; omission defaults to write. `allowedTools` restricts the registry for each turn. Schemas should close object inputs; application validators enforce domain rules.

Tools execute sequentially. By default, validation and read failures become tool-result errors; `toolErrorMode: "throw"` stops on all failures. A write that throws after starting always ends the turn with `tool_outcome_unknown`. Stable application operation IDs must cover duplicates arriving under different provider call IDs.

`context.recordReceipt(id)` adds a reference to the report. Persist the effect and receipt through [local operations](local-operations.md) or an equivalent application boundary first. This callback does not save data.

Oversized or unserializable tool results fail while preserving completed-tool status. `toolResultOverflow(value, context)` may return one bounded replacement. Preserve IDs, receipts, and facts required downstream; see [execution limits](execution.md).

## Choices and structured results

| Mode | Contract |
| --- | --- |
| `choice` | Adds a synthetic choice tool, validates its input with `parse`, and retains the accepted selection in `result.choice`. Required by default; `required: false` permits no choice. |
| `choice.requiredFirst` | Allows preparatory reads but requires a choice before writes. `authorizeWrite(choice, tool, context)` must permit each write. |
| `structuredOutput: { schema, parse }` | Returns `status: "structured"` and a validated `value`. Requires one successful provider call, with bounded transport retries. Cannot request tools or combine with `choice` or `allowedTools`. |

Choice parsers return structured-cloneable values. Callbacks receive copies and must not mutate application state. A failing or timed-out `onChoice` retains the accepted decision and ends the turn. Structured-result parsers validate shape and domain constraints; invalid output is not automatically retried.

## Results and recovery

Text results have `status: "reply" | "silence" | "rejected"`, `output`, and acceptance information. Text output policies may normalize or reject the terminal response; they do not rewrite structured results. Rejection does not replay previous effects. Any recomposition needs an application-authorized new turn with acting tools withheld.

Incomplete responses, missing answers after reads, or exhausted post-tool capacity throw `RuntimeError`. Its `cause` and partial `report` retain available decisions, call IDs, usage, tool outcomes, and receipt references. Construction errors occur before a turn and have no report. Earlier tool-call prose never substitutes for the terminal response.

Completed tools establish that execution returned. Persistence and delivery require their own evidence. Inspect uncertain effects before continuing. [Model steps](model-steps.md) preserve completed turns; [tasks](tasks.md) compose explicit work and dispatch [saved outputs](delivery.md).
