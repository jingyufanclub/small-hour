# Tools and results

Create `SmallHourRuntime` with a provider, a `persona` instruction source, and a `memory` source for relevant context. Each source's `load(context)` runs fresh for every turn; the two load concurrently. `agentId` is your identifier for the context, not authentication.

## Context and tools

A tool is an application function the model can request. Register its schema, a synchronous `parse` validator, and an `execute` function. Small Hour validates arguments before calling `execute`. Your function checks permission before reading or changing data.

This example extends the [quickstart's runtime options](../README.md#install-and-try). Supply `readAuthorizedRecord(agentId, id)` in your application:

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

When tools are registered, every ordinary turn requires `allowedTools`; `[]` offers none. Omission fails with `tool_allowlist_required` before context loading or a model call. Tools run sequentially. The default tool mode is `"write"`; declare reads explicitly.

Validation and read failures normally send generic `tool_failed` feedback to the model. Use `ModelSafeToolError` only for deliberately safe text; causes and stacks stay private. Explicit results are not redacted. Set `toolErrorMode: "throw"` to stop on every failure. A write that throws after starting always stops with `tool_outcome_unknown`: it may already have happened.

`context.recordReceipt(id)` attaches an existing receipt reference to the report; it saves nothing itself. Use stable application IDs and [local operations](local-operations.md) to prevent duplicate effects.

## Structured results

Use `structuredOutput: { schema, parse }` to request and validate JSON. It returns `status: "structured"` with `value`. Supply a JSON schema and your parser, optionally using a schema library.

This mode excludes tools; omit `allowedTools` and `choice`. It allows one successful response plus bounded transport retries. Invalid output raises `structured_output_invalid`, with no automatic repair call.

For an accepted selection that later tools must follow, see [choices](choices.md).

## What comes back?

Text results have `status: "reply" | "silence" | "rejected"`, `output`, and acceptance information. The default policy accepts text. A custom output policy can normalize or reject it; rejection cannot undo earlier effects.

Failures expose available calls, usage, choices, tool outcomes, and receipts in `RuntimeError.report`. Constructor errors have no turn report. Keep exception causes private.

See [limits](execution.md), [images](images.md), and [saved model results](model-steps.md) for overflow, input handling, and recovery.
