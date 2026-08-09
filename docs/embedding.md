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

Tool failures become tool-result errors by default so the model can recover within the same turn. Use `toolErrorMode: "throw"` when the host needs fail-closed behavior.

## Structured choice

`choice` adds a synthetic tool whose input becomes `result.choice`. A choice is required by default; set
`required: false` only for a genuinely optional decision. `parse` validates the choice input.

Set `requiredFirst: true` when choosing must precede any write. Read tools may still run first so the model can make
an informed decision. Writes then fail closed unless `authorizeWrite(choice, tool, context)` explicitly permits the
specific tool call. The host remains responsible for applying durable consequences and keeping them idempotent.

## Output policy

An output policy can normalize or reject the final text. Rejection returns `accepted: false`; Small Hour does not automatically replay the whole turn because tools may already have caused side effects. If the host recomposes, it should start a new turn with its own idempotency key and with acting tools withheld.

Successful results expose `status: "reply" | "silence" | "rejected"`. Incomplete provider stops, a missing answer
after a read, or a tool request with no remaining model hop throw a typed `RuntimeError` instead of returning a
plausible but unfinished result.

## Provider adapters

Provider adapters translate only message, tool, thinking, stop-reason, and usage shapes. They do not own memory or policy. Opaque provider blocks are echoed unchanged inside a turn, which preserves signed thinking blocks without persisting them across turns.
