# Embedding

`SmallHourRuntime` accepts a provider, instruction source, memory source, and optional tools and policies. Each `turn()` loads instructions and selected context concurrently, appends the current input, and executes a bounded model/tool loop. The core retains no cross-turn history.

## Context and tools

`agentId` is an application-selected partition key. Use it consistently for context, authorization, usage, and effects. Supply a bounded view through `MemorySource.load()`; select relevant facts before encoding or shortening them.

`input` accepts a string or ordered text/image blocks. Explicit input is copied and frozen before loaders run; callbacks receive that selected input. Code using string methods on `context.input` must first narrow with `typeof context.input === "string"`. Selected memory is copied after loading. See [image input](images.md) for provider support, bounds and persistence.

Register tools with `name`, `description`, `inputSchema`, a synchronous `parse`, and `execute`. The schema describes arguments to the provider; `parse` must validate them locally and return the value passed to `execute`. Small Hour requires the parser but cannot establish that an application's validator is adequate. A missing parser rejects registration; a thrown error or returned promise prevents execution. Keep parsing free of effects.

When tools are registered, every ordinary turn requires an explicit `allowedTools` list, including `[]` to offer none. Omission fails with `tool_allowlist_required` before context loading or model admission. Invalid selections also fail before loading. A runtime with no registered tools needs no list; structured-output turns always exclude tools. Dispatch rejects tools that were not offered. Declare `mode: "read" | "write"`; omission defaults to write. Application tools authorize both reads and writes at the operation boundary.

For example, with your runtime `options` and an application function `readAuthorizedRecord(agentId, id)` that checks current access:

```ts
import { ModelSafeToolError, SmallHourRuntime, ToolRegistry } from "small-hour";

const tools = new ToolRegistry().register({
  name: "read_record",
  description: "Read an accessible record by ID.",
  mode: "read",
  inputSchema: {
    type: "object", properties: { id: { type: "string" } },
    required: ["id"], additionalProperties: false,
  },
  parse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !("id" in value) || typeof value.id !== "string" || !value.id.trim()
      || Object.keys(value).some(key => key !== "id")) {
      throw new ModelSafeToolError("Supply one nonempty record ID.");
    }
    return { id: value.id };
  },
  execute: ({ id }, context) => readAuthorizedRecord(context.agentId, id),
});

const runtime = new SmallHourRuntime({ ...options, tools });
const result = await runtime.turn({
  agentId: "example", input: "Read the selected record.", allowedTools: ["read_record"],
});
```

Tools execute sequentially. By default, validation and read failures return `{ error: "Tool failed.", code: "tool_failed" }` to the model. Known runtime denials retain their fixed codes, such as `tool_not_allowed`. Exception messages, arbitrary error codes, causes and stacks are not forwarded. Throw `ModelSafeToolError` only for text deliberately safe for the model; its message replaces the generic text, while its optional `cause` stays private. This also applies to recoverable choice errors. Explicit tool results and captured content are not automatically redacted.

`toolErrorMode: "throw"` stops on all failures. A write that throws after starting always ends the turn with `tool_outcome_unknown`, even for a safe error. Stable application operation IDs must cover duplicates arriving under different provider call IDs.

`context.recordReceipt(id)` adds a reference to the report. Persist the effect and receipt through [local operations](local-operations.md) or an equivalent application boundary first. This callback does not save data.

Oversized or unserializable tool results fail while preserving completed-tool status. `toolResultOverflow(value, context)` may return one bounded replacement. Preserve IDs, receipts, and facts required downstream; see [execution limits](execution.md).

## Choices and structured results

| Mode | Contract |
| --- | --- |
| `choice` | Adds a synthetic choice tool, validates its input with `parse`, and retains the accepted selection in `result.choice`. Required by default; `required: false` permits no choice. |
| `choice.requiredFirst` | Allows preparatory reads but requires a choice before writes. `authorizeWrite(choice, tool, context)` must permit each write. |
| `structuredOutput: { schema, parse }` | Returns `status: "structured"` and a validated `value`. Requires one successful provider call, with bounded transport retries. Cannot request tools or combine with `choice` or `allowedTools`. |

Choice parsers return structured-cloneable values. Callbacks receive copies and must not mutate application state. A failing or timed-out `onChoice` retains the accepted decision and ends the turn. Structured-result parsers validate shape and domain constraints; invalid output is not automatically retried.

## Spending admission

To enforce a monetary allowance, configure `modelCalls.admit` and `modelCalls.record` on the runtime. The supplied [spending store](model-spending.md) installs both through `modelCalls: store.hooks(policy)`. Without admission, turns remain bounded by their call, token and time limits, but Small Hour does not enforce a monetary allowance. With the store installed, denial or admission-storage failure prevents the provider call; uncertain charges retain their reservations until reconciled.

## Results and recovery

Text results have `status: "reply" | "silence" | "rejected"`, `output`, and acceptance information. Text output policies may normalize or reject the terminal response; they do not rewrite structured results. Rejection does not replay previous effects. Any recomposition needs an application-authorized new turn with acting tools withheld.

Incomplete responses, missing answers after reads, or exhausted post-tool capacity throw `RuntimeError`. Its `cause` and partial `report` retain available decisions, call IDs, usage, tool outcomes, and receipt references. Construction errors occur before a turn and have no report. Earlier tool-call prose never substitutes for the terminal response.

Completed tools establish that execution returned. Persistence and delivery require their own evidence. Inspect uncertain effects before continuing. [Model steps](model-steps.md) preserve completed turns; [tasks](tasks.md) compose explicit work and dispatch [saved outputs](delivery.md).
