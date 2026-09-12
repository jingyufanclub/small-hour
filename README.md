# Small Hour

Small Hour is a compact TypeScript library for running bounded agent turns. Each turn receives system instructions, host-selected memory, and registered tools, then runs a provider/tool loop and returns its result. The host application owns persistence, authorization, scheduling, delivery, and the implementation of side effects.

Use it for task assistants, reporting agents, or other applications that need a small turn loop around a model. Continuity comes from state supplied by the host on each call; the runtime does not retain a conversation between turns.

## Status

The package is at version 0.1.0, with its API and license still being decided. Its `private` package flag prevents accidental npm publication.

The provider interface is pluggable; Anthropic is the only included adapter. Other providers require an implementation of `ModelProvider`. The current interface supports text and tool calls; it does not expose streaming, image, or audio input.

## Install and check

```bash
npm install
npm run check
```

## Minimal turn

This example uses the included Anthropic adapter and requires `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in the host environment.

```ts
import {
  EmptyMemorySource,
  SmallHourRuntime,
  StaticPersonaSource,
  ToolRegistry,
} from "small-hour";
import { AnthropicProvider } from "small-hour/providers/anthropic";

const runtime = new SmallHourRuntime({
  provider: new AnthropicProvider({
    model: process.env.ANTHROPIC_MODEL!,
  }),
  persona: new StaticPersonaSource(
    "Summarize supplied operational notes. Distinguish confirmed facts from pending work.",
  ),
  memory: new EmptyMemorySource(),
  tools: new ToolRegistry(),
});

const result = await runtime.turn({
  agentId: "reporting-agent",
  input: "Backup completed at 03:10 UTC. Restore verification is pending. Summarize the status.",
});

if (result.status === "reply") console.log(result.output);
```

`persona` is the API name for the system-instruction source. It can contain ordinary task instructions and application policy. Implement `PersonaSource` for dynamic instructions and `MemorySource` for context selected by the host.

See [embedding](docs/embedding.md) and [security](docs/security.md).

## Boundary

Small Hour owns:

- one provider-neutral turn loop;
- system-instruction and memory-source interfaces;
- a tool registry with provider schemas, optional host parsers, and read/write modes;
- retries, timeouts, usage records, and output-policy hooks;
- optional structured choices with host authorization hooks for subsequent writes.

Completed turns report `reply`, `silence`, or `rejected`. Incomplete provider contracts throw a `RuntimeError`;
partial `max_tokens` responses and final-hop tool calls are never treated as successful output. Other provider or host failures can reject the turn promise.

It intentionally does not own persistence, channels, cron, secrets, authorization, long-term memory policy, or a workflow engine.

## Host responsibilities

Select and bound memory before returning it to the runtime. Tools should return the complete facts needed for the task within the configured result limit; oversized results become explicitly marked previews.

Register only tools appropriate for the runtime's callers, validate their inputs, and enforce authorization inside their implementations. `allowedTools` controls which tools are offered to the provider; host authorization remains necessary.

Persist consequential work in the host and make mutating tools idempotent. A rejected output or failed turn does not undo earlier tool effects. Durable recovery and delivery belong to the host application.
