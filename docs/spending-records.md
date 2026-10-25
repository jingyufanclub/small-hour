# Model-call records and cost

[`SqliteModelCallStore`](model-spending.md) keeps one row per attempted provider call, including denied attempts. Input, output/failure, checks, usage and accounting share the call ID. Budget memberships point to that row; they carry no separate charge.

## Saved evidence

`inspect(callId)` returns:

- `context`: agent, turn, call and trace IDs, provider/model, attempt, hop and token configuration.
- `attributes`: immutable app-supplied source IDs, workflow/prompt versions or other scalar metadata. Supply a pure synchronous `attributes(identity)` callback in store options. Applications enforce source relationships and access.
- `request` and `response`: normalized model data, each with an explicit capture status. An unreturned response is `null`.
- `failure`: a safe error code when recorded; arbitrary exception text is excluded.
- `checks`: named accepted, rejected or unavailable validation outcomes.
- The quote or denial, provider outcome and token usage, charge/reconciliation, and lifecycle timestamps. `finishedAt` and `durationMs` remain null when completion was not recorded.

Enable content with `{ content: { maxBytes } }` on the store. The default saves metadata and marks content `omitted: disabled`. Oversized content is explicitly omitted with its byte size; unsafe serialization is unavailable. Nothing is silently clipped. Legacy or manually unsupplied content is `not_recorded`. Apps choose limits and access controls appropriate to their private evidence.

The runtime supplies complete normalized instructions, selected memory, conversation, tools and schema before dispatch. The provider response and charge commit together. Runtime structured-output and final-output checks are saved automatically. Application checks can call `recordCheck(callId, { name, verdict, issues })`; names identify immutable checks. Identical repeats are safe; changed verdicts need a new check identity. A check requires a recorded response.

A saved response is not proof of valid gameplay, permission or delivery. Recovery checkpoints and application records retain their respective accepted results. Obtain call IDs from execution reports or database queries; agent/turn and trace lookups are indexed. Shared trace identity does not group independent work into one transaction.

## Budget state

| State | Exposure |
| --- | --- |
| `denied` | Zero; no dispatch was authorized. |
| `reserved` | Estimated cost while dispatch/accounting is unresolved. |
| `accepted` | Known charge, even if output validation failed. |
| `rejected` | Zero with definite provider-rejection evidence. |
| `unknown` | Estimated cost until reconciliation. |

Admission commits before dispatch; each retry gets a new call ID. Settlement uses the frozen price quote. `inspectBudget(scope)` reports accepted, reserved, unknown and total amounts. Do not sum overlapping budgets as overall spending.

`ModelSpendPolicy.quote` can return `{ denied: true, scopes, reason, evidence }` without invented pricing. A thrown policy error saves no decision. Scope selection is application-authorized.

## Recovery and retention

`reconcile(callId, { status: "accepted", amount, evidence })` or `{ status: "rejected", evidence }` resolves only reserved/unknown cost. Cancellation, timeout or silence cannot prove zero cost. Identical reconciliation changes nothing; contradictions fail. Reconciliation makes no provider call.

A crash can leave a reservation and missing completion/check evidence. Preserve that uncertainty; the application verifies it before authorizing recovery. Completed model-step replay neither dispatches nor charges again.

The store has no automatic expiry. Apps set explicit retention and access for evaluation evidence separately from routine diagnostics. Keep charges and budget memberships together. See [schema and upgrade requirements](storage-schema.md).
