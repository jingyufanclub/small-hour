# Testing

Run `npm run check` for type checking, deterministic tests, and a build. The tests use fixture providers, local HTTP servers, and disposable SQLite databases. They make no paid model calls. Some recovery tests start a separate process and interrupt it to check what survives.

`npm run check:package` also installs the packaged library in a separate JavaScript and TypeScript consumer. CI runs both commands and the [released-consumer checks](https://github.com/jingyufanclub/small-hour/blob/main/scripts/README.md).

## What the tests protect

- **Permissions:** withheld tools cannot execute; rejected arguments cannot cause writes. Application fixtures check ownership before context disclosure, persistence, and delivery.
- **Privacy:** each turn receives fresh application-selected context. Metadata-only traces exclude instructions, messages, images, tool content, and provider content. Private tool errors stay out of model feedback.
- **Spending and retries:** admission precedes each provider attempt. Shared limits survive concurrent workers and restarts. Unknown charges retain their reservation until explicitly reconciled; a failed acknowledgement cannot authorize another write.
- **Recovery:** saved selections and receipts reach later steps unchanged. Interrupted work stays distinguishable from completed work. Delivery retries follow the sink's idempotency or reconciliation contract.
- **Outputs and observability:** incomplete or refused responses cannot become successful answers. Traces join requests, tools, checks, and outcomes; a failing exporter cannot grant permission or replay work.

## Adding or changing a test

Start with a caller, its preconditions, the expected outcome, and the effect that must never happen. Exercise the public operation and inspect the resulting request, database rows, delivery, or trace. For a bug fix, first reproduce the failure at that boundary.

Use scripted responses to provoke the situation, then assert the runtime's decision and consequences. Derive expected results from the contract rather than calling the implementation to calculate its own answer. Include denied, missing, contradictory, and valid partial inputs when they change behavior.

Keep a case when it protects a distinct contract or failure mode. Consolidate repeated validation cases at their owner, retaining checks that each adapter and persistence entry point enforces that boundary. A shorter test or higher count is not inherently better.

## What passing does not establish

Scripted providers cannot demonstrate model judgment, factual accuracy, tone, or resistance to prompt injection. Application fixtures cannot certify another application's authorization. Each application needs its own behavioral evaluations, current-permission checks, and retention policy. Runtime tests establish execution controls, not the quality of a model's answer.
