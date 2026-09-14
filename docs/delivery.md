# Saved-output delivery

The task runner hands exact saved products to application-supplied sinks. Applications select destinations, authorize disclosure, implement transports, and verify receipts.

## Stage and send

Define a workflow with one `{ id, kind: "delivery", sink }` step. Model/local steps and a local retry policy are prohibited. The task's scoped identity and JSON input are the immutable output contract, including destination and payload. Version changed sink semantics; capabilities are bound in the saved manifest. Referenced media must retain its original bytes throughout recovery.

Enqueue in the transaction that commits the originating product or local effect. Both commit or roll back together. Dispatch uses an independent transaction and cannot send uncommitted output.

The existing runner claims work, checks current permission/cancellation, and commits an uncertain attempt before invoking the sink. `DeliverySink` supplies `idempotency: "key" | "none"`, `send(product, context)`, and optional `reconcile(product, context)`. Context includes a stable scoped `idempotencyKey`, signal, and `assertActive()`.

Preserve product identity, destination, and payload. Issue one attempt per invocation with SDK retries disabled. Supply request timeouts, cooperative cancellation, and a sufficiently long claim lease. Recheck changing permissions at the actual effect boundary; a callback cannot make remote authorization atomic.

## Evidence

| Outcome | Contract |
| --- | --- |
| `deferred` | Reason, due time, and evidence prove non-acceptance and exclude late acceptance; retry may occur later. |
| `rejected` | Reason and evidence establish terminal refusal without acceptance. |
| `uncertain` | Reason and optional evidence; acceptance remains unknown. |
| `accepted` | `receipt: { id, evidence }` establishes provider acceptance. |
| `confirmed` | Same receipt plus `confirmation: { level, evidence }`; level identifies destination, device, or user receipt. |

Definite outcomes require JSON evidence. Validation rejects malformed or contradictory fields; applications verify authenticity. Acceptance alone does not prove device/user receipt. Send exceptions retain uncertainty and return the original error. Storage/validation errors propagate. A failed pre-send commit prevents dispatch; failed post-send storage cannot claim success.

## Recovery and inspection

`runNext()` handles due deferrals and expired claims. `retryDelivery(key, { signal? })` explicitly recovers uncertain tasks using the original product. Every claimed recovery consumes the task allowance; exhaustion stops sink calls.

`"key"` requires remote deduplication across the entire recovery window, including overlapping expired workers. Attaching a key is insufficient. Otherwise, authoritative reconciliation must cover every unresolved send and possible late acceptance. A lookup miss, timeout, or cancellation cannot establish non-acceptance. Reconciliation receives current authorization and must not send or regenerate output. Unknown work remains blocked and occupies its scope.

`recordDeliveryOutcome(key, { attemptId, outcome })` saves verified evidence for an existing attempt without sending or claiming. Confirmation retains the remote identity; weaker evidence cannot erase acceptance. `retryDelivery()` can settle known acceptance after exhaustion; `runNext()` recovers expired claims. Recording evidence alone does not complete the task.

Inspection exposes the exact product in `steps[0].request`, and attempt outcomes in `steps[0].delivery`. Check task lifecycle separately. Late receipts survive claim loss and cancellation; stale workers cannot finalize tasks. Conflicting receipt identities block recovery. No general exactly-once guarantee is supplied.

Payload remains in the task row; `small_hour_deliveries` stores attempt evidence. Retain both and compatible handlers during rollout/rollback. No backfill or second transport authority is added. See [tasks](tasks.md) and [storage and access](security.md).
