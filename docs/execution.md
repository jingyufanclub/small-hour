# Execution limits

Limits stop an individual request from running indefinitely. A **turn** is the whole exchange; a **hop** is one model response and any requested tools. A failed provider request may retry within that hop, using another call.

## Defaults

| Option | Default | Applies to |
| --- | --- | --- |
| `timeoutMs` | 30,000 | The whole turn, including context loading, callbacks, and waits. |
| `maxHops` | 6 | Model/tool exchanges. |
| `retry.attempts` | 3 | Provider attempts per hop. |
| `maxModelCalls` | `maxHops × retry.attempts` | All provider attempts in the turn. |
| `maxTokens` | 512 | Each call's output allowance; [reasoning rules differ](providers.md). |
| `maxToolResultCharacters` | 4,000 | Each JSON-encoded tool result. |

Choose limits for your workflow. A turn can override `maxTokens`; other limits are runtime options. Tools require room for a following model call, so the final hop cannot execute tools.

Oversized results fail; `toolResultOverflow(value, context)` can supply one bounded replacement. Small Hour never silently clips results. Preserve required IDs and facts.

## What happens at the limit?

Small Hour stops further work and throws `RuntimeError` with available progress. A truncated answer is not accepted. Previous effects and charges remain. Your app decides whether to show an error, inspect saved work, or authorize another attempt.

Only a `tool_use` stop allows tools. Final output needs `end_turn` or `stop_sequence`, then the configured output checks. Refusal, filtering, token/context exhaustion, pause, and unknown endings remain distinct; they authorize no continuation or partial answer.

## Money and accounting

Call counts are not money limits. Use [spending hooks](model-spending.md) for monetary allowances.

- `modelCalls.admit(context)` must return exactly `true` before each attempt. Denial or callback failure stops dispatch.
- `modelCalls.record(call, context)` records the outcome before tools or another call. Accounting failure stops continuation.
- `usage.record` is successful-response telemetry; do not charge the same call twice.

Call records distinguish `responded`, `rejected`, and `unknown`. Responded calls retain normalized stop evidence and available native reasons. Missing usage does not mean free. Reports remain `unrecorded` until accounting finishes. Separate calls made inside your tools or loaders need their own budget controls.

## Cancellation and saved progress

The cancellation signal and deadline cover the whole turn. Callbacks must cooperate with the signal; synchronous blocking code cannot be interrupted. An already-started request or effect may finish later. Cancellation starts no new accounting callback, so check durable records for pending reservations.

Reports are snapshots; they do not receive late results. `not_started` proves the provider was not invoked, but an admission reservation may still exist.

`turn(input, { checkpoint(report) })` awaits your progress-saving callback. It shares the deadline and must not start effects or retries. Failure raises `checkpoint_failed`. [Model steps](model-steps.md) use this to save progress automatically.
