# Small Hour

Small Hour is a compact TypeScript runtime for persistent character agents. Each turn receives a persona, a bounded view of memory, and an explicit set of tools. The host application keeps the database, permissions, scheduling, delivery, and every real-world side effect.

The design came out of Bosie's live runtime: continuity is rebuilt from durable state instead of maintained as a growing model transcript. The model gets voice and bounded choice, not authority.

## Status

This is an extraction-stage package. It is private to prevent accidental publication while the API and license are being decided.

## Install and check

```bash
npm install
npm run check
```

## Minimal turn

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
  persona: new StaticPersonaSource("You are a quiet observatory caretaker."),
  memory: new EmptyMemorySource(),
  tools: new ToolRegistry(),
});

const result = await runtime.turn({
  agentId: "caretaker-1",
  input: "what is the sky doing?",
});

if (result.status === "reply") console.log(result.output);
```

See [embedding](docs/embedding.md), [security](docs/security.md), and the [Bosie extraction map](docs/bosie-extraction.md).

## Boundary

Small Hour owns:

- one provider-neutral turn loop;
- persona and bounded-memory interfaces;
- an allowlisted tool registry with strict schemas and read/write modes;
- retries, timeouts, usage records, and output-policy hooks;
- optional structured choice as a first tool call.

Completed turns report `reply`, `silence`, or `rejected`. Provider failures and incomplete contracts throw a
`RuntimeError`; partial `max_tokens` responses and final-hop tool calls are never treated as successful output.

It intentionally does not own persistence, channels, cron, secrets, authorization, long-term memory policy, or a workflow engine.
