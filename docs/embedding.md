# Embedding Small Hour

## One turn, rebuilt from state

For each call, the host provides an `agentId` and current input. Small Hour concurrently loads that agent's persona and bounded memory view, appends the current input, then runs the provider/tool loop. Nothing is retained by the runtime between calls.

The host should treat `agentId` as an opaque partition key. Persona, memory, tool authorization, usage, and side effects must all resolve through that same key.

## Memory

Implement `MemorySource.load()` with a hard bound: a fixed number of recent messages, a token budget, or both. Retrieve older facts separately through narrow read tools when relevant. Do not return an agent's entire transcript.

## Tools

Register only capabilities needed for the turn. `allowedTools` can narrow a shared registry further at call time. Validate model input with each tool's optional `parse` function, and make every state-changing implementation idempotent by `turnId` or `toolCallId`.

Tool failures become tool-result errors by default so the model can recover within the same turn. Use `toolErrorMode: "throw"` when the host needs fail-closed behavior.

## Structured choice

`choice` adds a synthetic tool whose input becomes `result.choice`. Set `requiredFirst: true` when choosing must precede any acting tool. The host remains responsible for checking that the choice is permitted and for applying durable consequences.

## Output policy

An output policy can normalize or reject the final text. Rejection returns `accepted: false`; Small Hour does not automatically replay the whole turn because tools may already have caused side effects. If the host recomposes, it should start a new turn with its own idempotency key and with acting tools withheld.

## Provider adapters

Provider adapters translate only message, tool, thinking, stop-reason, and usage shapes. They do not own memory or policy. Opaque provider blocks are echoed unchanged inside a turn, which preserves signed thinking blocks without persisting them across turns.
