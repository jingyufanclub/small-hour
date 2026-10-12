# Send a saved output

Use a delivery task when your app has already decided **what to send and where**, and needs to track sending across failures. Recovery uses the same saved content; it does not ask the model to rewrite it.

Your app implements the transport, checks permission, and verifies evidence from the destination.

## Stage and send

Define a workflow with one `{ id, kind: "delivery", sink }` step. A delivery workflow cannot contain model/local steps or a local retry policy.

Save its destination and payload in the task input. Enqueue it in the transaction that commits the originating product or database change. Sending cannot begin before that transaction commits. Preserve referenced media bytes during recovery.

The runner claims work, checks permission/cancellation, and saves an uncertain attempt **before** calling the sink.

A **sink** is your transport implementation:

- `idempotency: "key" | "none"` describes its duplicate protection.
- `send(product, context)` makes one sending attempt.
- Optional `reconcile(product, context)` checks what happened without sending.

Context supplies a stable `idempotencyKey`, signal, and `assertActive()`. Disable transport SDK retries, set timeouts, and keep the claim lease long enough. Recheck permission where sending occurs.

## What the result means

| Outcome | Required meaning |
| --- | --- |
| `deferred` | Evidence proves non-acceptance, excludes late acceptance, and supplies a later due time. |
| `rejected` | Evidence proves terminal refusal without acceptance. |
| `uncertain` | Acceptance is unknown. |
| `accepted` | `receipt: { id, evidence }` proves provider acceptance. |
| `confirmed` | Receipt plus `confirmation: { level, evidence }` proves destination, device, or user receipt. |

Supply reasons for deferred/rejected/uncertain outcomes. Definite outcomes require JSON evidence; your app verifies authenticity. Provider acceptance alone does not prove the user received anything.

A send exception keeps the attempt uncertain. Failed pre-send storage prevents dispatch; failed post-send storage cannot claim success.

## Recover safely

`runNext()` handles due deferrals and expired claims. `retryDelivery(key, { signal? })` explicitly revisits uncertainty. Every claimed attempt consumes the task allowance.

For `"key"`, the remote service must actually deduplicate across the recovery window, including overlapping workers. Otherwise, reconciliation must establish the outcome of every unresolved send and rule out late acceptance. A missing lookup, timeout, or cancellation cannot prove non-acceptance. Unknown work stays blocked and holds its scope.

`recordDeliveryOutcome(key, { attemptId, outcome })` records verified evidence without sending. It does not itself complete the task. Known acceptance can still be settled after attempts are exhausted. Late evidence survives cancellation/claim loss; conflicting receipt IDs block recovery.

Inspect the saved product at `steps[0].request`, delivery evidence at `steps[0].delivery`, and task status separately. Keep both task and evidence records. [Timestamps](storage-schema.md#lifecycle-timestamps) describe local evidence, not remote receipt time. Version changes to sink behavior in the workflow definition.
