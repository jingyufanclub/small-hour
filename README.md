# Small Hour

**One runtime for AI workflows you can control, inspect, and recover.**

Small Hour is a TypeScript library that runs inside your app. It handles model calls, tool execution, retries, limits, and configured output checks through the same API for Anthropic, OpenAI, and OpenAI-compatible servers. Add cost budgets, traces, and saved work as you need them; reuse those controls across features and apps.

Your app supplies instructions, context, and tools—functions the model can request—and keeps ownership of permissions, business rules, memory, and delivery.

## Install and try

Requires Node.js 26.10+ and ESM imports.

```sh
npm install --save-exact https://github.com/jingyufanclub/small-hour/releases/download/v0.11.0/small-hour-0.11.0.tgz
```

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in your server environment. Save this as `quickstart.mts` and run `node quickstart.mts`. This makes a billable request.

```ts
import {
  SmallHourRuntime, StaticPersonaSource, EmptyMemorySource,
} from "small-hour";
import { OpenAIProvider } from "small-hour/providers/openai";

const model = process.env.OPENAI_MODEL;
if (!model) throw new Error("Set OPENAI_MODEL.");

const options = {
  provider: new OpenAIProvider({ model }),
  persona: new StaticPersonaSource("Answer concisely."),
  memory: new EmptyMemorySource(),
  maxTokens: 1024,
  maxModelCalls: 1,
  timeoutMs: 30_000,
  retry: { attempts: 1 },
};
const runtime = new SmallHourRuntime(options);

const result = await runtime.turn({
  agentId: "example",
  input: "What does an agent runtime do?",
  allowedTools: [],
});
if (result.status === "reply") console.log(result.output);
console.log(result.status, result.usage);
```

This allows one model attempt and no tools. See [execution limits](docs/execution.md) for errors and retries.

## Next steps

- [How it works](docs/runtime.md) · [Tools and validated JSON](docs/embedding.md) · [Providers and images](docs/providers.md)
- Optional [cost budgets](docs/model-spending.md) use your prices and estimates; [traces](docs/tracing.md) go to your chosen destination.
- Optional [saved work](docs/storage.md) uses your SQLite connection to preserve completed results for recovery.
- [Security](docs/security.md) · [Releases and upgrades](docs/releases.md)

Development: `npm run check`; package verification: `npm run check:package`.

Copyright 2026 Jing Yu. [Apache-2.0](LICENSE).
