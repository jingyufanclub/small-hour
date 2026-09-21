# Tasks

`SqliteTaskRunner` executes fixed workflows using an application-supplied synchronous SQLite connection. Construct it with workflow definitions and `{ leaseMs, now? }`, then call `initialize()`. Initialization creates `small_hour_tasks`, its indexes and the local-operation, model-step, and delivery-evidence tables. No polling loop starts.

## Definitions and submission

A workflow specifies `kind`, `version`, unique ordered steps, and synchronous `authorize(context)`:

| Step | Callback |
| --- | --- |
| `local` | Synchronous `execute(database, context)` and JSON-preserving `parseResult(value)`. |
| `model` | Synchronous `prepare(context)` returning `{ runtime, input }`; optional initial `recovery` contract. |
| `delivery` | A consumer-supplied sink; must be the workflow's only step. See [delivery](delivery.md). |

Local executors perform synchronous SQL work only. See [local operations](local-operations.md).

Context includes the submitted task, `stepId`, detached preceding results, signal, and `assertActive()`. Preparation, validation, authorization, and retry selection must be pure. Version changed semantics or closure configuration; model replay must reconstruct the original turn contract.

`enqueue(request, { concurrencyScope, dueAt, maxAttempts })` binds an `OperationRequest` to an immutable manifest and initial schedule. Exact duplicates return existing state; conflicts fail. Enqueue uses a savepoint and may share a local transaction. Its result remains provisional until outer commit. Claiming requires an independent transaction.

## Execution and claims

Each `runNext({ signal? })` claims at most one due or expired task for a supported version, ordered by due time and scoped identity. Unknown versions are skipped; changed manifests fail before claim. It returns inspected state with an optional transient `error`, or `undefined` when no task is eligible. Already-aborted calls do no work.

Each claim consumes an attempt, including recovery and permission deferral. One running or uncertain task occupies its concurrency scope. Deferral does not reserve ordering. Workers need consistent nonnegative millisecond clocks.

Completed steps replay receipts. New steps receive preceding results and current permission: `allow`, `rejected` with reason, or `deferred` with reason/due time. Local effects, receipts, and before/after guards commit together. Model guards preserve progress before stopping. Rejected model output ends the task as rejected.

Leases renew between steps. Set `leaseMs` above the longest step; no heartbeat extends blocked work. A stale worker throws `claim_lost` and cannot commit subsequent local steps or finalize the task. External effects need their own authorization and fencing.

## Recovery

`inspect(key)` returns lifecycle, reasons, attempts, cancellation, resolutions, and step evidence. `completed` requires accepted step results; device/user receipt still requires delivery evidence.

`retry(error, context)` may return `{ dueAt, reason }` only for rolled-back local attempts within the limit. Incomplete model work is never replayed automatically. Provider retries remain in the core.

A model step may initially opt in with `recovery: { sideEffectFree: true, maxAttempts, maxModelCalls }`. Its turn must be tool-free and its preparation, context sources and output checks must have no effects. The limits become part of the immutable task manifest. Existing steps without this contract cannot gain recovery later.

After inspecting an uncertain task, the application may call `retryModel(key, { stepId, action: "retry", checkpoint: step.model.checkpoint, reason, evidence }, { signal? })`. The decision must refer to the first unfinished model step and its exact current evidence. Recovery consumes a task claim and a model attempt, rechecks current authorization and cancellation, and preserves prior local receipts. Each model attempt has separate reports and spending records; the model call limit spans all attempts. A completed result is reused without regeneration. See [model steps](model-steps.md) for spending reconciliation and recovery eligibility.

`cancel(key, reason)` immediately stops queued/deferred tasks and records requests for running or uncertain tasks. Committed effects remain. Aborted workers defer safe unstarted work; unknown effects retain the scope.

`resolve(key, { status: "failed" | "cancelled", reason, evidence })` closes uncertain work after verification that old effects cannot continue unexpectedly. Exact repeats are safe. It does not reset steps, replay effects, or refund spending.

Storage errors propagate. `rollback_failed` requires restoring/replacing the connection before recovery. Retain task/evidence rows and compatible handlers during upgrades or stop execution during rollback; initialization performs no backfill. See [storage and access](security.md).
