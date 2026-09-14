# Durable tasks

`SqliteTaskRunner` composes fixed application-defined workflows from local operations and model steps, or a single saved-output delivery step. It uses an existing synchronous SQLite connection and the same receipt stores exposed separately by `small-hour/durable/sqlite`. It supplies no model-authored plan, calendar, transport, background timer or polling service.

## Definition and submission

Requires Node.js 20.3 or later for [combined cancellation signals](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals). Construct the runner with a connection, workflow definitions and `{ leaseMs, now? }`. The optional clock returns nonnegative integer epoch milliseconds; all workers must share a consistent clock. `initialize()` explicitly creates `small_hour_tasks`, two queue indexes, the delivery-evidence table, and the existing local-operation and model-step tables. Connection durability, busy timeout and lifecycle remain application-owned.

A `TaskWorkflow` binds `kind` and `version` to an ordered nonempty array of uniquely named steps and a synchronous `authorize(context)` policy. Local steps have `kind: "local"`, `execute(database, context)` and `parseResult(value)`. Model steps have `kind: "model"` and synchronous `prepare(context)` returning `{ runtime, input }`. The input supports structured results or ordinary tool turns. A delivery workflow contains only one `kind: "delivery"` step with a consumer-supplied sink; see [delivery contracts](delivery.md). Preparation, authorization, retry selection and result parsers must not cause effects or open transactions. Local executors perform synchronous database work only.

The context contains the submitted task, current `stepId`, detached preceding `results`, optional worker signal and `assertActive()`. Parsers validate and preserve saved JSON. Application callbacks own domain validation; arbitrary callback implementations cannot be fingerprinted. Bump workflow versions when semantics, instructions, validation or effect policy change, and include immutable context/configuration references in task input where needed. Model preparation must reconstruct the same turn contract during replay.

`enqueue(request, schedule)` accepts the scoped `OperationRequest` identity and `{ concurrencyScope, dueAt, maxAttempts }`. Initial schedule, ordered step identities, workflow version and input are immutable. Enqueue uses a savepoint and can share an existing application or local-step transaction; returned state is provisional until its outer commit. Claiming and execution require independent transactions. An exact duplicate returns the existing state; conflicting reuse fails. Unsupported workflow versions cannot be submitted through that runner. Older workers skip queued versions they do not implement; a changed manifest under an existing version fails before claiming.

## Claims and execution

Each explicit `runNext({ signal? })` claims at most one due task and executes its steps in order. It returns `TaskRunResult`, which extends the inspected task state with an optional original `error` from the current invocation, or `undefined` when no eligible task is available or the supplied signal was already aborted. Original errors are returned for application logging and are not persisted; saved reasons and model reports remain available across restarts. Selection uses due time followed by scoped task identity. A deferred task does not reserve ordering ahead of later tasks.

SQLite serializes claims. Each claim gets a new token and consumes one attempt, including recovery and permission deferral. A named concurrency scope allows one running or uncertain task at a time; independent scopes can proceed concurrently. Expired running claims remain recoverable by workers supporting that workflow version. They do not free their scope for different tasks.

Completed results come from existing receipts, without repeating their effects or reauthorizing the completed operation. Model replay still validates the supplied turn contract and saved values. Each new step receives these preceding results. `authorize` returns `allow`, `rejected` with a reason, or `deferred` with a reason and due time. It checks current permission for new work, not whether already committed effects should be reinterpreted. Downstream operations still validate relevant changing domain facts and disclosure permissions.

Local execution, its receipt, and claim/permission checks before and after execution share one short transaction. Failure rolls back participating changes. No transaction spans an asynchronous model call. The model-step guard checks claim, cancellation and permission at progress boundaries; accepted report facts are saved before rejecting further work. A rejected model output stops the task as rejected and retains its result.

Leases renew between completed steps. Configure `leaseMs` above the longest expected step, including the runtime deadline and local processing. No heartbeat extends a blocked step. An expired or replaced worker throws `claim_lost` and cannot finalize the task or commit a subsequent runner-owned local step. Its already-started external work may continue. Tool implementations and remote effects need their own idempotency and atomic authorization/fencing at the effect boundary; a callback check cannot make an arbitrary asynchronous effect atomic.

## Recovery and cancellation

`inspect(key)` reads a consistent snapshot containing state, attempts, current due time, cancellation reason, resolution and step evidence. Step states are `not_started`, `completed`, or `unresolved`; model entries retain the underlying report, and delivery entries retain handoff outcomes and attempt evidence. Inspection validates receipt structure and step ordering; application domain validation and access checks remain required. Receipt IDs are exposed for inspection, not independent execution outside the runner.

| Task state | Meaning |
| --- | --- |
| `queued` | Submitted; no claim yet. |
| `running` | A worker owns a time-limited claim. |
| `deferred` | Safe continuation is eligible at the saved due time. |
| `completed` | All ordered step results are committed. A delivery task has acceptance evidence; this alone does not establish device or user receipt. |
| `cancelled` | Cancellation stopped further work; earlier effects remain. |
| `rejected` | Permission or model-output acceptance prevented continuation. |
| `failed` | Safe local execution failed, the attempt limit was reached, or reconciliation explicitly closed the task. |
| `uncertain` | Unfinished model work, uncertain delivery or exhausted recovery attempts require reconciliation. Its scope remains occupied. |

The optional synchronous `retry(error, context)` chooses a reason and next due time only for a local attempt whose transaction rolled back. Attempts remain bounded by the saved maximum. It does not retry a model step, storage failure outside local execution, or an unconfirmed rollback. Provider retries remain inside `SmallHourRuntime`; SDK retries stay disabled. Configure its model-spending hooks with stable budget scopes across tasks and continuations.

`cancel(key, reason)` immediately cancels queued/deferred tasks. For running tasks and uncertain delivery tasks it records a request checked at the next execution boundary; it does not undo committed effects or forcibly interrupt an in-flight provider/tool. Aborting the worker signal interrupts cooperative model execution and defers safe unstarted work. Unknown external outcomes remain uncertain, including after cancellation or claim exhaustion. Storage and lost-claim errors propagate; callers must inspect surviving state before deciding what to do next. An unconfirmed task rollback throws `rollback_failed` without using the connection for more work. Restore or replace the connection before recovery; committed receipts determine what can resume.

`resolve(key, { status: "failed" | "cancelled", reason, evidence })` closes an uncertain task only after application verification establishes that outstanding effects cannot continue unexpectedly. Exact repeated resolutions are idempotent; conflicting resolutions fail. The method records evidence and releases the scope; it does not reset model steps, replay effects, refund reservations or verify external evidence itself. Preserve accepted results and explicitly define any continuation from reconciled facts. Unfinished model work is never silently regenerated.

## Adoption and retention

All task input, results, reasons and reconciliation evidence are application data. Authenticate submission and administrative APIs and authorize inspection/disclosure. The runner stores a fixed step manifest and task lifecycle; local receipts and model checkpoints remain the single sources of step results. Retain all participating rows for the duplicate/recovery window. Deletion removes protection.

Initialization performs no application backfill. Mixed versions require retaining handlers for outstanding tasks. Rollback must stop task execution or leave a compatible runner responsible for saved work; do not enable a second worker authority or drop the evidence tables. Sink implementation and delivery policy remain consumer boundaries; the runner owns dispatch when its optional delivery step is selected.
