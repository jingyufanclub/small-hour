# Spending records and uncertain charges

For setup, start with [money budgets](model-spending.md). This page explains the records used to decide whether another call is affordable.

## States

| State | What counts against the budget |
| --- | --- |
| `denied` | Nothing; this attempt was not authorized. |
| `reserved` | The estimate, while the call or accounting is pending. |
| `accepted` | The known charge replaces the estimate. This does not mean the answer passed validation. |
| `rejected` | Nothing; definite evidence establishes no charge. |
| `unknown` | The estimate stays reserved because cost is uncertain. |

Admission checks all selected budgets and saves one reservation plus its memberships in an independent `BEGIN IMMEDIATE` transaction. Only a newly committed reservation permits dispatch. Reused call IDs raise `call_exists`; write failure rolls back admission.

Each provider retry gets a new call ID. Settlement records one charge, even if several budgets include it. Exact repeated accounting changes nothing; conflicting accounting fails. A refused or unusable response can still incur cost.

## Inspect

- `inspect(callId)` returns identity, quote, state, charge, provider evidence, reconciliation, and [timestamps](storage-schema.md#lifecycle-timestamps).
- `inspectBudget(scope)` returns `acceptedAmount`, `reservedAmount`, `unknownAmount`, and `totalAmount`.

Obtain call IDs from execution reports, checkpoints, or your database queries. Saved accounting remains authoritative even if a report still says `unrecorded`.

Quotes accept either `{ scopes: [{ scope, limit }], amount, pricing }` or `{ scope, limit, amount, pricing }`. Mixed forms, repeated scopes, or an empty scope list fail before dispatch. Narrow this union when reading it; extend it with a type intersection.

## Reconcile

Use `reconcile(callId, outcome)` with one outcome:

| Verified outcome | Value |
| --- | --- |
| A known charge | `{ status: "accepted", amount, evidence }` |
| No charge | `{ status: "rejected", evidence }` |

`evidence` is a nonempty string referencing something your app verified. Only reserved/unknown calls may change. Exact repeats are safe; conflicting resolutions raise `settlement_conflict`.

Check that old execution cannot produce a later contradictory charge. Time passing, cancellation, or a missing response cannot prove that no work happened. Reconciliation makes no provider call and does not continue a workflow. Unfinished model steps need their [own recovery decision](model-recovery.md).

Keep call records and budget memberships together. Initialization imports no historical spending; deleting records or changing scopes removes budget history. The store saves quotes, identities, usage, and evidence without automatically copying input or selected context. Your app controls retention and access.
