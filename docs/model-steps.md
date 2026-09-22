# Model steps

`SqliteModelStepStore` wraps a `SmallHourRuntime` and preserves completed results and available progress. Import it from `small-hour/durable/sqlite`, supply a synchronous connection, and call `initialize()` to create `small_hour_model_steps`.

## Execution

`run(request, runtime, input)` returns `{ attemptId, replayed, result }`. The result retains structured, reply, silence, or rejected status. A completed rejection remains a rejection on replay.

The scoped `OperationRequest` binds kind, version, JSON input, and turn configuration: agent/input identity, explicit turn ID, schemas, token/choice settings, and allowed tools. Changed contracts fail before model or tool execution. Signals and callback implementations are excluded. Include revisions or immutable references for instructions, context, provider settings, validators, and effect policy; closure contents cannot be fingerprinted. Inputs are copied. Without an explicit turn ID, the attempt ID becomes its turn ID.

A `started` record commits before context loading or provider execution. Awaited checkpoints preserve model-call IDs, [provider stop evidence](execution.md), usage/accounting state, accepted choices, tool outcomes, and receipt references. The runtime retains provider retry and deadline ownership. Failed checkpoints stop further execution.

Completion validates and saves the full result before returning. Exact replay skips context loading, models, tools, text policy, and accounting. Structured-result and choice parsers revalidate saved values; they must be pure, synchronous, and JSON-preserving.

## Inspection and recovery

`inspect(request)` validates identity/storage and returns `undefined` or:

| State | Available evidence |
| --- | --- |
| `started` | Attempt ID and latest committed progress; execution may still be active. |
| `failed` | Attempt ID, partial report, and error code; effects or costs may remain uncertain. |
| `completed` | Exact result and report, including acceptance status. |

Application domain validation still applies. Malformed checkpoints fail with `invalid_checkpoint`; they never authorize regeneration. Re-entry through `run` into started or failed work throws `step_unresolved` with inspected state. Inspection includes a stable `checkpoint` token and an ordered `attempts` history including the current attempt.

Reconciliation must establish whether old work can continue, preserve accepted decisions, and inspect authoritative effects and spending. Any next execution needs an explicit identity and authorization; changing an ID alone does not make repetition safe. A response received before a failed completion commit remains incomplete. Known charges do not complete a model step, and a saved result does not prove complete accounting. Use stable scopes with [model spending](model-spending.md).

## Explicit recovery

An application may opt a step into bounded recovery on its first `run`:

```ts
await steps.run(request, runtime, input, {
  recovery: { sideEffectFree: true, maxAttempts: 3, maxModelCalls: 5 },
});
```

Recovery requires structured output or explicit `allowedTools: []`, with no choice callback. `sideEffectFree` is the application's promise that context loading, parsing, and output policy have no domain effects. The runtime cannot inspect callback implementations. Keep their versions and provider/spending configuration bound to the workflow contract.

After inspecting incomplete work, the application can call `recover(request, runtime, input, decision, guard?)` with `{ action: "retry", checkpoint, reason, evidence }`. Evidence must be JSON; the checkpoint must exactly match the inspected state. The operation validates the unchanged turn and stored limits, archives the old attempt with the decision, and atomically replaces its attempt ID. The logical step and turn IDs remain stable; provider call IDs remain distinct. A fresh runtime cannot reset the stored allowance. Completed results replay without regeneration, including rejected output.

`maxAttempts` includes the original attempt. `maxModelCalls` applies across all attempts and provider retries, before admission or dispatch. Every call record counts conservatively, including `not_started`; a blocked extra record is retained as evidence. Recovery does not settle spending, refund an uncertain call, or supply a monetary ceiling.

Late workers can add report facts only to their archived attempt and then receive `step_changed`. They cannot replace the current result. New evidence changes the checkpoint, so an earlier recovery decision becomes stale. Crashes before or after takeover require a fresh inspection and decision; no recovery worker or automatic retry starts.

Recovery-enabled rows use format 2 in the existing table. Ordinary rows retain format 1 and remain readable and replayable, but cannot acquire recovery eligibility after execution. No backfill runs. Older readers reject format 2; retain compatible handlers or stop execution during rollback.

## Transactions and guards

Start, progress, completion, and failure use independent short transactions. An outer transaction prevents execution; no database transaction spans a model/tool await. Concurrent starts serialize; only the new record's creator executes. Busy/storage errors propagate. After cancellation, failure handling may make one synchronous attempt to preserve its report without starting effects.

The optional fourth argument `{ assertActive() }` supplies a synchronous guard alongside recovery options. It checks entry, progress, and final acceptance, saving available facts before rejecting continuation. Completed replay skips the guard; consuming boundaries still authorize disclosure and effects. [Tasks](tasks.md) use it for claims and cancellation.

The table stores explicit contracts, configuration, reports, and results. Explicit [image input](images.md) stores exact bytes and order in the existing turn record; changed valid input conflicts and malformed stored input fails validation. No schema change or backfill is needed. Older readers reject array-input rows, including ordinary format-1 rows. It does not automatically retain retrieved memory or provider-native history. Keep secrets out of contracts and tool arguments. Retain evidence and compatible handlers during rollback; initialization makes no backfill. See [storage and access](security.md) and the [runtime observer](execution.md).

Stop evidence is optional in format version 1. Rows written without it remain readable and are not backfilled. Readers validate supplied evidence and reject a final stop that contradicts the saved result. Older model-step readers tolerate the additional field; older spending readers omit it when presenting records. Rolling back therefore loses diagnostic visibility, and rewriting those records through older code can discard evidence. Retain a database backup and use the updated reader when investigating incomplete work. Consumers with exhaustive stop-reason switches must handle `context_limit` and `pause`.
