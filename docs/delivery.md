# Saved-output delivery

The optional SQLite task runner stages exact output contracts and hands them to consumer-supplied sinks. The application owns output creation, destination selection, authorization, transport implementation and receipt verification. The runner owns claims and dispatch; no transport, polling service, retry timer or additional workflow executor is installed.

## Stage and dispatch

Define a `TaskWorkflow` with one `{ id, kind: "delivery", sink }` step and a synchronous `authorize` policy. Delivery workflows cannot contain local/model steps or a local `retry` policy. The workflow's `kind` and `version` identify its sink contract. The submitted task's `scope`, `id` and JSON `input` identify the fixed product; include the exact destination, payload and immutable artifact references in that input. Callback implementations cannot be fingerprinted. Change the workflow version when transport, destination interpretation or recovery semantics change. The runner records idempotency and reconciliation capabilities in the immutable manifest and rejects incompatible reuse.

Call `enqueue(request, schedule)` inside the transaction that commits the originating product or local effect. This works inside a local operation receipt callback or a runner local step. The output task and participating local changes commit or roll back together. The returned state is provisional until the outer transaction commits. `runNext()` requires an independent transaction and cannot send uncommitted output. Large media can remain in application storage through immutable references; the application must preserve their bytes and availability for the recovery window.

Each `runNext({ signal? })` call claims at most one task using the existing queue, due times, concurrency scopes and attempt limits. Before invoking the sink, the runner checks current authorization, cancellation and claim ownership, then commits an uncertain attempt record. It supplies a detached copy of the saved product. The sink must preserve its identity, destination and payload. Output staging is explicit; completing an unrelated local/model task does not itself publish anything.

## Sink contract

`DeliverySink` supplies `idempotency`, `send(product, context)` and optional `reconcile(product, context)`. The context contains:

- `idempotencyKey`: a stable hash of the output's scoped identity, unchanged across worker claims and restarts.
- `signal`: the optional worker cancellation signal.
- `assertActive()`: rechecks the claim, current authorization and cancellation before an effect.

A sink performs one handoff attempt per invocation. Disable SDK retries; the runner owns retry decisions. Supply bounded request timeouts and honor cancellation where possible. Configure the claim lease above the expected request duration; no heartbeat extends a blocked request. A policy callback cannot make a remote effect atomic with a later permission change. Transport implementations must enforce any additional authorization/fencing required at the actual effect boundary.

| Outcome | Required evidence and meaning |
| --- | --- |
| `deferred` | `reason`, `dueAt` and `evidence` establish that no acceptance occurred and this attempt cannot later accept. Another attempt may run at the saved time. |
| `rejected` | `reason` and `evidence` establish a definite terminal refusal without remote acceptance. |
| `uncertain` | A `reason`, with optional `evidence`; acceptance is unknown. A timeout, disconnected socket or eventual-consistency lookup miss cannot establish non-acceptance. |
| `accepted` | `receipt: { id, evidence }` establishes provider acceptance of the exact output. It does not prove receipt by a destination, device or user. |
| `confirmed` | The same receipt plus `confirmation: { level, evidence }`, where `level` explicitly identifies `destination`, `device` or `user` receipt. |

Evidence must be JSON and definite outcomes cannot omit it. The runner validates structure and incompatible fields, not authenticity. A thrown send error leaves an uncertain attempt and returns the original error for application logging. Invalid outcomes or storage failures propagate; inspect the surviving task and attempt before taking further action. Failed commits before an attempt starts prevent a send. Failed commits after a send preserve uncertainty rather than claiming success.

## Recovery

Safe deferrals use `runNext()` at their saved due time. Expired running claims can also be recovered by `runNext()`. An uncertain completed invocation remains blocked until an explicit `retryDelivery(key, { signal? })` call or application reconciliation. Recovery uses the original saved output; it has no model, tool or local creation steps to execute.

With `idempotency: "key"`, the sink guarantees that all sends with the supplied key represent one remote effect throughout the application's entire recovery window, including overlapping requests from an expired worker. Merely attaching the key to a request is insufficient. If a provider cannot honor that window, use `"none"` and reconciliation.

If `reconcile` exists, the runner calls it for uncertain work instead of resending. It must query authoritative evidence for this exact output and cover every unresolved send, including possible late acceptance. Positive evidence completes the handoff without another send. Definitive non-acceptance can defer a later attempt. An uncertain result keeps the scope occupied. Reconciliation must not itself send, regenerate, alter the product or invoke another workflow. Current authorization is required because the callback receives the saved product; applications can separately record verified receipts obtained through an authorized channel.

Without reconciliation or guaranteed idempotency, an uncertain handoff cannot be retried. Unknown work holds its concurrency scope. Each claimed recovery, including reconciliation and authorization deferral, consumes the saved attempt allowance. Exhaustion stops further sink calls; known acceptance can still settle the task, while unresolved effects require application evidence. Exact duplicates, due times, cancellation and claim fencing follow the [task contract](tasks.md).

`recordDeliveryOutcome(key, { attemptId, outcome })` records verified external evidence against an existing attempt. It performs no network call and does not create another claim or send. Confirmation must retain the remote receipt identity. Repeated evidence is safe, weaker evidence cannot erase acceptance, and inspection preserves the strongest confirmed receipt level. This method does not complete an active or uncertain task on its own; `runNext()` recovers expired claims and `retryDelivery()` settles uncertain tasks from the saved evidence, even when the send allowance is exhausted. The generic `resolve()` API can close uncertain work only after application verification establishes that outstanding effects cannot continue unexpectedly.

A late result may record its own receipt after losing a claim, but the stale worker cannot finalize the task. Cancellation and revocation prevent further disclosure without erasing prior acceptance or uncertain work. If an in-flight send completes after cancellation, inspection can correctly show a cancelled task with an accepted output. Conflicting remote receipt identities block recovery and require investigation; the runtime makes no general exactly-once guarantee.

## Inspection and storage

`inspect(key).steps[0].request` is the exact product passed to the sink. `inspect(key).steps[0].delivery` reports the output outcome and each attempt's ID and latest evidence. Before any attempt, the output is queued; task authorization or cancellation can supply a rejected/deferred outcome without a send. In-flight attempts are uncertain until evidence arrives. The task lifecycle remains separate: `completed` means this handoff has acceptance evidence, while `accepted` and `confirmed` retain their distinct delivery meanings. Always inspect task status as well as delivery evidence when deciding whether more work is eligible.

The immutable product remains in `small_hour_tasks.input_json`. One additional table, `small_hour_deliveries`, stores per-output attempt evidence; it does not duplicate the product or add another queue. There are no schema changes or backfills for existing tasks. Application database durability, privacy, access control and retention apply to the payload, destination, receipts and reasons. Retain task and evidence rows together for the duplicate/recovery window. Removing them removes protection.

Old workers can continue processing their supported local/model workflow versions. Deploy delivery handlers under new versions; old workers should not receive them. Keep handlers for pending versions during upgrades. Rollback must leave a compatible runner responsible for saved outputs or stop dispatch. Never activate a second transport authority alongside the runner for the same output.
