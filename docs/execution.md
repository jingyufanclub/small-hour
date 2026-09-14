# Execution limits

The runtime owns provider retries and the deadline covering context loading, calls, retry waits, tools, validation, accounting, and checkpoints. Provider adapters must disable internal retries.

| Option | Default | Effect |
| --- | --- | --- |
| `timeoutMs` | 30,000 | Deadline for the complete turn. |
| `maxHops` | 6 | Model/tool-loop bound. |
| `retry.attempts` | 3 | Maximum provider attempts per hop. |
| `maxModelCalls` | `maxHops × retry.attempts` | Total attempts across all hops and retries. |
| `maxTokens` | 512 | Provider-specific output allowance. |
| `maxToolResultCharacters` | 4,000 | JSON-encoded tool-result size. |

Tools require capacity for a following model call; the final hop cannot execute tools. Oversized results fail unless `toolResultOverflow` supplies a bounded replacement. The runtime never silently truncates them. Token and reasoning semantics are documented per [provider](providers.md).

## Admission and accounting

Configure `modelCalls.admit(context)` to authorize each provider attempt. It must return exactly `true`. Context includes a unique `callId`, agent/turn IDs, provider/model, attempt, hop, and token limits. Denial or a callback failure ends the turn without retrying the hook.

`modelCalls.record(call, context)` receives the provider outcome and available usage/request ID before tools execute or the loop continues:

| Status | Meaning |
| --- | --- |
| `responded` | The provider returned; output validation may still fail. |
| `rejected` | Definite provider rejection. |
| `unknown` | The outcome is uncertain. Missing usage cannot establish zero cost. |

Accounting failure stops further calls. Reports retain `unrecorded` until the accounting callback finishes. `usage.record` remains available for successful-response telemetry; avoid charging the same call through both hooks. The optional [spending store](model-spending.md) supplies persistent reservation and settlement.

A call limit does not establish a monetary ceiling. Applications supply prices, conservative reservation estimates, and stable budget scopes. Model calls inside tools or context loaders need their own admission boundary.

## Cancellation and reports

The turn signal combines the supplied cancellation signal with its deadline and is aborted when execution finishes. Failed context loading cancels its pending sibling. Cooperative callbacks can stop; blocking synchronous code cannot be forcibly interrupted. Elapsed time is checked before subsequent work or success.

Cancellation starts no new accounting callback. An in-flight admission, provider request, tool, or accounting callback can still complete. Reports are detached snapshots and do not gain late results. Reconcile pending reservations and external effects through durable evidence; `not_started` proves no provider invocation, but admission may still need settlement.

`runtime.turn(input, { checkpoint(report) })` exposes an awaited persistence boundary. Observers participate in the deadline, must not start effects or retries, and fail the turn with `checkpoint_failed` when they throw. [Model steps](model-steps.md) use this boundary to preserve progress.
