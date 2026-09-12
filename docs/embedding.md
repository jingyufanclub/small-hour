# Embedding Small Hour

## One turn, rebuilt from state

For each call, the host provides an `agentId` and current input. Small Hour concurrently loads that agent's persona and bounded memory view, appends the current input, then runs the provider/tool loop. Nothing is retained by the runtime between calls.

The host should treat `agentId` as an opaque partition key. Persona, memory, tool authorization, usage, and side effects must all resolve through that same key.

## Memory

Implement `MemorySource.load()` with a hard bound: a fixed number of recent messages, a token budget, or both. Retrieve older facts separately through narrow read tools when relevant. Do not return an agent's entire transcript.

## Tools

Register only capabilities needed for the turn. `allowedTools` can narrow a shared registry further at call time. Validate model input with each tool's optional `parse` function, and make every state-changing implementation idempotent by `turnId` or `toolCallId`.

Declare every tool as `mode: "read"` or `mode: "write"`. An omitted mode fails safe as `write`. Provider schemas
are strict by default; schemas should close object inputs with `additionalProperties: false`, while `parse` remains
the host's runtime validation boundary for every provider.

Input validation and read-tool failures become tool-result errors by default so the model can recover within
the same turn. A write that throws after starting always ends the turn with `tool_outcome_unknown`, since
effects may already have occurred. Use `toolErrorMode: "throw"` to stop on all tool failures.

After persisting an effect, a tool can call `context.recordReceipt("host-receipt-id")`. The report retains these
host-selected references without copying the full tool result. This callback does not persist anything itself.

Tool results are JSON-encoded and limited to `maxToolResultCharacters` (default 4,000). An oversized or
unserializable result fails the turn while preserving the tool's completed status. Optional
`toolResultOverflow(value, context)` runs once for an oversized result and must return a bounded replacement.
The host selects which facts can be omitted; preserve exact IDs, receipts, and facts needed downstream.

## Structured choice

`choice` adds a synthetic tool whose input becomes `result.choice`. A choice is required by default; set
`required: false` only for a genuinely optional decision. `parse` validates the choice input.

Set `requiredFirst: true` when choosing must precede any write. Read tools may still run first so the model can make
an informed decision. Writes then fail closed unless `authorizeWrite(choice, tool, context)` explicitly permits the
specific tool call. The host remains responsible for applying durable consequences and keeping them idempotent.

An accepted choice remains in the report if `onChoice` fails or times out. That failure ends the turn; it does
not ask the model to choose again. Choice parsers must return structured-cloneable data; callbacks receive copies
so late mutations cannot change the accepted selection. Parsers and authorization callbacks must not mutate state.

## Single-call structured results

Use `structuredOutput: { schema, parse }` for a typed object without a tool loop. `schema` is the provider's
JSON Schema; the mandatory host `parse(unknown)` validates its structure and domain rules, such as whether a
selected ID was actually allowed. It returns `result.value` with `status: "structured"`.

```ts
const result = await runtime.turn({
  agentId: "router",
  input: "Select the destination for this request.",
  structuredOutput: {
    schema: {
      type: "object",
      properties: { destination: { type: "string", enum: ["archive", "review"] } },
      required: ["destination"],
      additionalProperties: false,
    },
    parse(value) {
      if (!value || typeof value !== "object" || !("destination" in value)
        || (value.destination !== "archive" && value.destination !== "review")) {
        throw new Error("invalid destination");
      }
      return { destination: value.destination };
    },
  },
});
```

Structured mode offers no tools and cannot be combined with `choice` or `allowedTools`. It needs one successful
provider call; transient transport retries still use the same budget and deadline. Invalid output is not retried.
The host parser owns acceptance; the text output policy does not rewrite structured results.

## Output policy

An output policy can normalize or reject the final text. Rejection returns `accepted: false`; Small Hour does not automatically replay the whole turn because tools may already have caused side effects. If the host recomposes, it should start a new turn with its own idempotency key and with acting tools withheld.

Text turns expose `status: "reply" | "silence" | "rejected"`. Incomplete provider stops, a missing answer
after a read, or a tool request with no remaining model hop throw a typed `RuntimeError` instead of returning a
plausible but unfinished result. Runtime and host failures carry `error.report`; construction errors occur before
a turn exists and have no report. Reports include agent/turn IDs, accepted choice, tool calls, model calls, usage,
and hops. Treat reports as potentially private because tool inputs are included.

Tool statuses distinguish `completed`, `not_started`, and `unknown`. Completed means the tool returned; it does
not independently prove delivery or durable persistence. An exception or cancellation during execution can
leave effects uncertain. Keep known receipts and reconcile with the host's authoritative state before retrying.

## Model admission, accounting, and deadlines

`maxModelCalls` caps provider attempts across all hops and retries. It defaults to `maxHops * retry.attempts`
(18 with default settings). Tools require capacity for a following model call. This bounds calls, not money;
the host still owns prices, reservations, and per-user limits.

Optional `modelCalls.admit(context)` must return exactly `true` before each attempt. Its context includes a
unique `callId`, agent/turn IDs, provider/model, attempt, hop, and requested token limits. Use that ID to reserve
host budget idempotently. Denial or a callback failure ends the turn without retrying the hook.

`modelCalls.record(call, context)` receives `responded`, `rejected`, or `unknown` after each provider attempt,
with its request ID and usage when available. `responded` only means the provider returned; the output may
still fail application validation. Missing usage or a lost response is not evidence of zero cost. The existing
`usage.record` hook remains available for successful responses; avoid charging twice if using both hooks.

Accounting failure stops further calls. The report marks accounting `unrecorded` until the callback finishes.
On cancellation, no new callback starts: a pending admission/accounting callback or provider operation may still
finish outside the runtime. Reconcile unrecorded attempts using their `callId`; `not_started` means the provider
was not invoked, but an admission reservation may still need reconciliation.

The same deadline and abort signal cover context loading, provider calls, retry waits, tools, and host callbacks.
The signal is also aborted when the turn finishes, so a failed context load cancels its pending sibling.
Cooperative asynchronous work can be cancelled; synchronous code that blocks the JavaScript event loop cannot
be forcibly interrupted, but elapsed time is checked before starting more work or returning success. Reports do
not update with late completions and cannot replace durable host receipts.

## Adopting these contracts

Older embeddings that relied on automatic previews must supply `toolResultOverflow` or return smaller results.
Provider/host failures now arrive as `RuntimeError` with the original error in `cause`; inspect `report` before
deciding how to recover. Writes with uncertain outcomes stop even in the default tool-error mode. Provider tool
call IDs must be nonempty and unique within a turn. None of these changes requires a runtime database or backfill.
Final text comes only from the terminal provider response; earlier tool-call prose is never substituted for silence.

## Provider adapters

Provider adapters translate only message, tool, thinking, stop-reason, and usage shapes. They do not own memory or policy. Opaque provider blocks are echoed unchanged inside a turn, which preserves signed thinking blocks without persisting them across turns.

Adapters opt into structured output with `capabilities.structuredOutput`; unsupported adapters fail before a
provider call. The Anthropic adapter sends the supplied schema unchanged through
[`output_config.format`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
Choose a compatible model and schema; unsupported schemas or models can still be rejected by the API.
The host parser remains authoritative. Other adapters must disable internal retries so every billed attempt
passes through runtime admission. Anthropic disables SDK retries even for an injected client.
