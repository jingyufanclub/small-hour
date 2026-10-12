# Run an ordered workflow

Use `SqliteTaskRunner` when a request has several fixed steps that must survive interruption. For example: save a database change, ask a model to analyze it, then save the result.

Your app defines and submits tasks and decides when to call the runner. **Small Hour starts no polling loop or worker.**

## Define and submit

Construct the runner with your synchronous SQLite connection, workflow definitions, and `{ leaseMs, now? }`. Call `initialize()`; it prepares the task table and only the stores needed by registered step types. Initialize spending separately.

A workflow has `kind`, `version`, ordered unique step IDs, and synchronous `authorize(context)`.

| Step | Callback |
| --- | --- |
| `local` | Synchronous SQL `execute(database, context)` and JSON-preserving `parseResult`. |
| `model` | Synchronous `prepare(context)` returns `{ runtime, input }`. |
| `delivery` | App-supplied sending function; must be the only step. See [delivery](delivery.md). |

Context includes the task, step ID, preceding results, cancellation signal, and `assertActive()`. Preparation, parsing, authorization, and retry selection must have no effects.

`enqueue(request, { concurrencyScope, dueAt, maxAttempts })` saves an [operation identity](local-operations.md#identity-and-results), fixed step definition, and schedule. Exact duplicates return existing state; changes conflict. Enqueue can share a local transaction and remains provisional until it commits.

## Run work

`runNext({ signal? })` claims at most one eligible task, runs it, and returns inspected state with any transient `error`. It returns `undefined` when nothing is eligible. Unknown workflow versions are skipped; keep old definitions while their tasks remain.

A **claim** gives one worker temporary ownership. Its **lease** expires after `leaseMs`. A **concurrency scope** groups work that must not overlap: running or uncertain work holds its scope.

Every claim consumes an attempt, including permission deferral and recovery. Permission returns `allow`, `rejected` with a reason, or `deferred` with a reason/due time.

Completed steps reuse saved results. New steps recheck permission; rejected model output ends the task as rejected. Deferral does not reserve ordering.

Leases renew between steps. Set the lease longer than the longest step; blocked work has no heartbeat. Stale workers cannot commit subsequent local steps or finalize the task. Remote effects need separate duplicate protection.

## Inspect, cancel, recover

- `inspect(key)`: progress, reasons, attempts, timestamps, and step evidence. Completed local steps include their receipt.
- `cancel(key, reason)`: stop queued/deferred work or request cancellation of running/uncertain work. Completed effects remain.
- `retry(error, context)`: optional scheduling of rolled-back local work within its attempt limit.
- `retryModel(...)`: explicit [recovery of eligible model work](model-recovery.md#through-the-task-runner); unfinished model work never repeats automatically.
- `resolve(key, { status, reason, evidence })`: close verified uncertain work as failed/cancelled without replay or refund.

Storage errors propagate. Replace or restore the connection after `rollback_failed`. Retain evidence and compatible handlers through [upgrades](releases.md).
