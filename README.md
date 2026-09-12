# Small Hour

Small Hour is a compact TypeScript library for running bounded agent turns. Each turn receives system instructions, host-selected memory, and registered tools, then runs a provider/tool loop and returns its result. The host application owns persistence, authorization, scheduling, delivery, and the implementation of side effects.

Use it for task assistants, reporting agents, or other applications that need a small turn loop around a model. Continuity comes from state supplied by the host on each call; the runtime does not retain a conversation between turns.

## Status

The package is at version 0.1.0, with its API and license still being decided. Its `private` package flag prevents accidental npm publication.

The provider interface is pluggable; Anthropic is the only included adapter. Other providers require an implementation of `ModelProvider`. The current interface supports text, tool calls, and optional structured results; it does not expose streaming, image, or audio input.

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
- a total model-call budget, retries, a turn deadline, usage records, and output-policy hooks;
- per-attempt admission and accounting hooks, plus turn reports that survive failure;
- optional structured choices with host authorization hooks for subsequent writes;
- single-call structured results with mandatory host validation.

Text turns report `reply`, `silence`, or `rejected`; structured turns return `structured` and a typed `value`.
Failed turns throw `RuntimeError` with a partial `report`: completed or uncertain tool calls, host receipt IDs,
accepted choices, model attempts, and known usage. Partial `max_tokens` responses and tool calls with no
remaining model-call capacity are never treated as successful output.

It intentionally does not own persistence, channels, cron, secrets, authorization, long-term memory policy, or a workflow engine.

## Host responsibilities

Select and bound memory before returning it to the runtime. Tool results must fit the configured limit.
Oversized results stop the turn unless `toolResultOverflow` supplies a complete, bounded replacement.
The runtime never clips facts or selected IDs into a preview.

Register only tools appropriate for the runtime's callers, validate their inputs, and enforce authorization inside their implementations. `allowedTools` limits both offered tools and actual dispatch; host authorization remains necessary.

Persist consequential work in the host and make mutating tools idempotent. A rejected output or failed turn does not undo earlier tool effects. Durable recovery and delivery belong to the host application.

Cancellation stops waiting and prevents new work; it cannot undo a running tool or provider request that ignores
the signal. Reconcile uncertain outcomes in the host using the report's stable IDs. Reports are in-memory
snapshots, so the host must persist receipts during execution if they need to survive a process crash.
