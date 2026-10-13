# Testing

Run `npm run check` for type checking, deterministic tests, and a build. The tests use fixture providers, local HTTP servers, and disposable SQLite databases. They make no paid model calls. Some recovery tests start a separate process and interrupt it to check what survives.

`npm run check:package` also installs the package built from the current checkout in a separate JavaScript and TypeScript consumer. CI runs both commands. See [package verification](https://github.com/jingyufanclub/small-hour/blob/main/scripts/README.md) for artifact options.

## What the tests protect

- **Permissions:** withheld tools cannot execute; rejected arguments cannot cause writes. Durable execution enforces application authorization before effects and local commits.
- **Privacy:** each turn receives fresh application-selected context. Metadata-only traces exclude instructions, messages, images, tool content, and provider content. Private tool errors stay out of model feedback.
- **Spending and retries:** admission precedes each provider attempt. Shared limits survive concurrent workers and restarts. Unknown charges retain their reservation until explicitly reconciled; a failed acknowledgement cannot authorize another write.
- **Recovery:** saved selections and receipts reach later steps unchanged. Interrupted work stays distinguishable from completed work. Delivery retries follow the sink's idempotency or reconciliation contract.
- **Outputs and observability:** incomplete or refused responses cannot become successful answers. Traces join requests, tools, checks, and outcomes; a failing exporter cannot grant permission or replay work.

## Adding or changing a test

Start with a caller, its preconditions, the expected outcome, and the effect that must never happen. Exercise the public operation and inspect the resulting request, database rows, delivery, or trace. For a bug fix, first reproduce the failure at that boundary.

Stubs supply external inputs, responses, or failures. They must not implement the control being tested. Exercise the real runtime or store, then inspect its decisions and effects. A canned answer cannot prove that a model chose correctly; a test-only application's ownership filter cannot prove application security. Include denied, missing, contradictory, and valid partial inputs where relevant.

Avoid source-text matching, implementation-derived expectations, and canned-answer echoes. Assert exact text only when the contract requires it: preserving saved output, forwarding selected context or protocol data, or detecting private content disclosure. Otherwise assert the outcome, state, and forbidden effects.

Keep a case when it protects a distinct contract or failure mode. Consolidate repeated validation cases at their owner, retaining checks that each adapter and persistence entry point enforces that boundary. A shorter test or higher count is not inherently better.

## What passing does not establish

Stubbed providers cannot demonstrate model judgment, factual accuracy, tone, or resistance to prompt injection. Each application must test its own authorization, context selection, output quality, and retention. Passing runtime checks establishes only the execution controls exercised.
