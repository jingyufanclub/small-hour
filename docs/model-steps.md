# Durable model steps

`SqliteModelStepStore` from `small-hour/durable/sqlite` wraps an existing `SmallHourRuntime`. It records one bounded execution per scoped step identity. `initialize()` explicitly creates `small_hour_model_steps` on an existing synchronous SQLite connection. The constructor opens no connection or background service.

## Execution contract

`run(request, runtime, input)` accepts the same `OperationRequest` identity fields as local operations and the runtime's structured or tool-turn input. It returns `{ attemptId, replayed, result }`; `result` retains the runtime's structured, reply, silence, or rejected outcome. Completion is distinct from output acceptance. A completed rejection is replayed as a rejection.

The store binds `(scope, id)` to `kind`, workflow `version`, JSON `input`, and the supplied turn configuration. Configuration includes agent identity, input text, explicit turn ID, schemas, token settings, choice settings, and tool allowlists. Signals, callback implementations, and unrelated properties on the caller object are excluded. A changed contract fails before any model or tool call.

Applications must include revisions or immutable references for relevant context, instructions, provider configuration, validation rules, and tool policy in the request contract. The store cannot fingerprint closure contents or discover changed domain facts. The request and configuration are copied before execution. If no turn ID is supplied, the saved attempt ID becomes its turn ID.

Before loading context or calling the provider, the store commits a `started` record. Runtime progress checkpoints preserve model-call IDs, available usage, accounting status, accepted partial choices, tool status, and recorded local receipt references. The existing runtime remains the sole owner of provider retries, allowlists, tool dispatch, and deadlines. A failed checkpoint stops execution; it cannot become a recoverable tool error followed by more model calls.

After the runtime finishes, the store validates and saves the complete result before returning it. A matching completed step reuses that result without loading memory, calling the model, executing tools, applying text policy again, or repeating accounting hooks. Structured-result and choice parsers revalidate saved values and must be pure, synchronous, JSON-preserving validators. They may reject incompatible results but cannot substitute selected IDs or normalize saved decisions into different values. Version or migrate incompatible contracts explicitly.

## Inspection and recovery

`inspect(request)` returns `undefined` for an absent step, otherwise one of:

| State | Surviving evidence |
| --- | --- |
| `started` | Attempt ID and the most recent committed progress report. Execution may still be running or may have been interrupted. |
| `failed` | Attempt ID, available partial report, and error code. Prior effects and provider costs may still be uncertain. |
| `completed` | Attempt ID, report, and the exact saved result, including its acceptance status. |

Inspection validates storage structure and identity. Values in its reports and results still require application domain validation before use. `run()` additionally applies the supplied result/choice validators when replaying completed steps. Malformed or incompatible stored state fails with `invalid_checkpoint`; it never authorizes regeneration.

Re-entering a started or failed step throws `ModelStepError` with code `step_unresolved` and its inspected `state`. The store supplies no automatic reset, takeover, polling, or retry of that step. The application owns reconciliation: establish whether old work is still running, inspect authoritative operation receipts and provider accounting, and preserve any accepted partial choice. Continuing from those facts is an application-defined next step. Any authorized new execution needs an explicit identity and spending decision; changing an ID alone does not make repeating effects safe. Completed steps remain immutable.

A process can die after a provider response arrives but before the result checkpoint commits. That remains an incomplete step, even if the report says `responded`. A progress report proves only the most recent saved boundary; it cannot recover unrecorded asynchronous completions. No universal exactly-once provider guarantee or unattended paid recovery is supplied.

## Transactions and storage

Each start, changed progress snapshot, completion, or failure uses a short SQLite transaction. No transaction stays open across a model call or tool await. An existing outer transaction prevents the store from starting work: a provisional marker cannot guard an external call. The connection must also be outside an outer transaction when progress and completion are saved. Local-operation callbacks may use their own short transactions within a tool.

Concurrent starts serialize through SQLite. Only the caller that creates the started row may execute; subsequent callers inspect or replay it. Storage/busy errors propagate without another retry loop. Connection lifetime, durability settings, retention, and busy timeout remain application-owned.

The table stores the explicit request contract, turn configuration, reports, and final result. These may include private input text, tool arguments, selections, and generated output. It stores no growing conversation, retrieved memory packet, provider-native transcript, or automatic model-authored plan. It does not read credentials; applications must keep secrets out of explicit contracts and report-bearing tool inputs. Applications control access and retention and must authorize disclosure or effects again at their consuming boundaries. Deleting a row removes duplicate protection.

The row format is versioned separately from workflow contracts. Initialization performs no backfill or migration of existing application rows. Keeping the table when rolling back the library preserves its evidence; older runtimes cannot enforce model-step replay automatically. Adoption must keep one execution owner for each workflow.

## Runtime observer

`runtime.turn(input, { checkpoint(report) })` exposes the awaited report boundary used by the store. Reports are detached snapshots. Observers should persist progress without starting effects or provider retries; their work participates in the turn deadline. An observer exception produces `checkpoint_failed`, with the available report. A failed durable-step call may make a final synchronous attempt to save its failure report after cancellation; it starts no model call or application tool.
