# Model steps

`SqliteModelStepStore` wraps a `SmallHourRuntime` and preserves completed results and available progress. Import it from `small-hour/durable/sqlite`, supply a synchronous connection, and call `initialize()` to create `small_hour_model_steps`.

## Execution

`run(request, runtime, input)` returns `{ attemptId, replayed, result }`. The result retains structured, reply, silence, or rejected status. A completed rejection remains a rejection on replay.

The scoped `OperationRequest` binds kind, version, JSON input, and turn configuration: agent/input identity, explicit turn ID, schemas, token/choice settings, and allowed tools. Changed contracts fail before model or tool execution. Signals and callback implementations are excluded. Include revisions or immutable references for instructions, context, provider settings, validators, and effect policy; closure contents cannot be fingerprinted. Inputs are copied. Without an explicit turn ID, the attempt ID becomes its turn ID.

A `started` record commits before context loading or provider execution. Awaited checkpoints preserve model-call IDs, usage/accounting state, accepted choices, tool outcomes, and receipt references. The runtime retains provider retry and deadline ownership. Failed checkpoints stop further execution.

Completion validates and saves the full result before returning. Exact replay skips context loading, models, tools, text policy, and accounting. Structured-result and choice parsers revalidate saved values; they must be pure, synchronous, and JSON-preserving.

## Inspection and recovery

`inspect(request)` validates identity/storage and returns `undefined` or:

| State | Available evidence |
| --- | --- |
| `started` | Attempt ID and latest committed progress; execution may still be active. |
| `failed` | Attempt ID, partial report, and error code; effects or costs may remain uncertain. |
| `completed` | Exact result and report, including acceptance status. |

Application domain validation still applies. Malformed checkpoints fail with `invalid_checkpoint`; they never authorize regeneration. Re-entry into started or failed work throws `step_unresolved` with inspected state. There is no reset, takeover, or automatic replay of incomplete steps.

Reconciliation must establish whether old work can continue, preserve accepted decisions, and inspect authoritative effects and spending. Any next execution needs an explicit identity and authorization; changing an ID alone does not make repetition safe. A response received before a failed completion commit remains incomplete. Known charges do not complete a model step, and a saved result does not prove complete accounting. Use stable scopes with [model spending](model-spending.md).

## Transactions and guards

Start, progress, completion, and failure use independent short transactions. An outer transaction prevents execution; no database transaction spans a model/tool await. Concurrent starts serialize; only the new record's creator executes. Busy/storage errors propagate. After cancellation, failure handling may make one synchronous attempt to preserve its report without starting effects.

The optional fourth argument `{ assertActive() }` supplies a synchronous guard. It checks entry and progress boundaries, saving available facts before rejecting continuation. Completed replay skips the guard; consuming boundaries still authorize disclosure and effects. [Tasks](tasks.md) use it for claims and cancellation.

The table stores explicit contracts, configuration, reports, and results. It does not automatically retain retrieved memory or provider-native history. Keep secrets out of contracts and tool arguments. Retain evidence and compatible handlers during rollback; initialization makes no backfill. See [storage and access](security.md) and the [runtime observer](execution.md).
