# Retry an unfinished model step

An interrupted request may already have cost money or changed something. Small Hour therefore refuses to rerun unfinished [model steps](model-steps.md) automatically.

Built-in recovery is available only when your app opted in before the first attempt and the work is safe to repeat.

## Opt in at the start

```ts
await steps.run(request, runtime, input, {
  recovery: { sideEffectFree: true, maxAttempts: 3, maxModelCalls: 5 },
});
```

These are example limits. The turn must use structured output or explicit `allowedTools: []`, with no `choice`. Context loading, parsing, and output policy must have no application effects. `sideEffectFree` is your promise; Small Hour cannot inspect callback implementations.

Keep provider settings, callback revisions, and spending policy tied to the saved workflow version. An existing step cannot gain recovery permission afterward.

## Inspect, decide, retry

1. Call `steps.inspect(request)`. Check its state, report, and ordered `attempts` history.
2. Verify effects and spending using authoritative records. A known charge does not complete the step; a saved answer does not prove accounting finished.
3. If another attempt is authorized, call:

```ts
await steps.recover(request, runtime, input, {
  action: "retry",
  checkpoint: inspected.checkpoint,
  reason,
  evidence,
});
```

`inspected`, `reason`, and JSON `evidence` come from your review. The **checkpoint** identifies the exact saved state you inspected. Changed evidence invalidates an older decision; inspect again.

The store verifies the unchanged contract, archives the old attempt with your decision, and saves a new attempt ID. Logical step/turn IDs stay the same; provider call IDs are new. Completed results return unchanged, including rejected output.

## Limits survive restart

`maxAttempts` includes the first attempt. `maxModelCalls` covers all attempts and transport retries. By default every call record counts, including `not_started`; a new runtime cannot reset the allowance. Opt into [admission pauses](admission-pauses.md) to preserve retries through proven refusals without dispatch.

Late workers can add facts to their archived attempt, then receive `step_changed`. They cannot replace the current result. A crash during recovery requires fresh inspection and authorization. No recovery worker starts automatically.

Recovery does not refund or settle earlier calls. Uncertain [spending reservations](spending-records.md) remain until verified reconciliation.

## Through the task runner

Put the same `recovery` contract on the original model step definition. Use:

```ts
await runner.retryModel(key, {
  stepId, action: "retry", checkpoint, reason, evidence,
}, { signal });
```

Select the first unfinished model step and its checkpoint. Recovery rechecks permission/cancellation and preserves earlier receipts. Claims and model attempts count unless the saved contract permits admission pauses. Changing that contract requires a new workflow version; keep old handlers for queued work.
