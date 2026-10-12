# Spending records and uncertain charges

For setup, start with [money budgets](model-spending.md).

## States

| State | What counts against the budget |
| --- | --- |
| `denied` | Nothing; this attempt was not authorized. |
| `reserved` | The estimate, while the call or accounting is pending. |
| `accepted` | The known charge replaces the estimate. This does not mean the answer passed validation. |
| `rejected` | Nothing; definite evidence establishes no charge. |
| `unknown` | The estimate stays reserved because cost is uncertain. |

Admission saves each decision and its memberships in an independent `BEGIN IMMEDIATE` transaction. Only a newly committed reservation permits dispatch. Reused call IDs raise `call_exists`; write failure rolls back admission.

Each provider retry gets a new call ID. Settlement records one charge across its budgets. Identical accounting changes nothing; conflicting accounting fails. A refused response can still cost money.

## Deny before pricing

`ModelSpendPolicy.quote` can return a quote or this explicit decision:

```ts
return {
  denied: true,
  scopes: [serviceBudgetScope, authenticatedAccountScope],
  reason: "unknown_model",
  evidence: "rate-card:2026-10-12",
};
```

Your app authenticates scope selection and supplies nonempty reason/evidence strings. Scopes must be nonempty and distinct. No price, estimate, or monetary limit is required or allowed. The saved denial has zero exposure, starts no call, and cannot be settled or reconciled. A thrown policy error instead raises `model_call_admission_failed`; it saves no decision.

## Inspect

- `inspect(callId)` returns identity, state, charge, evidence, and [timestamps](storage-schema.md#lifecycle-timestamps). Explicit denials have `quote: null` and `denial`; other records retain their quote. Narrow this union before reading quote fields.
- `inspectBudget(scope)` returns `acceptedAmount`, `reservedAmount`, `unknownAmount`, and `totalAmount`.

Obtain call IDs from execution reports, checkpoints, or your database queries. Saved accounting remains authoritative even if a report still says `unrecorded`.

Quotes accept `{ scopes: [{ scope, limit }], amount, pricing }` or `{ scope, limit, amount, pricing }`. Mixed decisions and malformed scopes fail before dispatch.

## Reconcile

Use `reconcile(callId, outcome)` with one outcome:

| Verified outcome | Value |
| --- | --- |
| A known charge | `{ status: "accepted", amount, evidence }` |
| No charge | `{ status: "rejected", evidence }` |

`evidence` references something your app verified. Only reserved/unknown calls may change. Identical resolutions are safe; conflicting ones raise `settlement_conflict`.

Exclude a later contradictory charge from old execution. Time passing or cancellation cannot prove zero cost. Reconciliation makes no call and does not continue a workflow. Unfinished steps need their [own recovery decision](model-recovery.md).

Keep calls and memberships together. Deleting records or changing scopes removes budget history. Input and selected context are not automatically copied. Use private-safe evidence references; your app controls retention and access.
