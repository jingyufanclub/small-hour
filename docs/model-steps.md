# Save and reuse a model result

Use `SqliteModelStepStore` when your app must remember a model operation across restarts. A completed result can be returned again without another model call or repeated tools. An unfinished operation stays unresolved until your app investigates.

Import the store from `small-hour/durable/sqlite`, supply your synchronous SQLite connection, and call `initialize()`.

## Run and inspect

| Method | Result |
| --- | --- |
| `run(request, runtime, input)` | Runs new work or returns its completed result, with `attemptId`, `replayed`, and timestamps. |
| `inspect(request)` | Returns the saved state, or `undefined` if no step exists. |

`request` contains `scope`, `id`, `kind`, `version`, and JSON `input`. The combination of scope and ID identifies the operation. Reusing it with a different input or saved turn configuration raises `contract_conflict` before execution.

Include revisions for instructions, context sources, provider settings, validators, and effect policy in your operation contract. Small Hour cannot detect changed callback code or captured variables. Without an explicit turn ID, the initial attempt ID becomes the turn ID.

## What gets saved?

The store commits a started record before loading context or calling the model. During execution, it saves available progress: call IDs, stop reasons, usage/accounting state, accepted choices, tool outcomes, and receipt references.

Completion saves the full result, including reply, silence, structured, or rejected status. A saved rejection remains a rejection.

Explicit input, including image bytes, is stored. Retrieved memory and provider-native conversation history are not automatically copied. Your app controls [access and retention](security.md).

## What happens on repeat?

| Saved state | Behavior |
| --- | --- |
| `completed` | Return the saved result; skip context loading, model/tools, text policy, and accounting. |
| `started` | Work may still be running; raise `step_unresolved`. |
| `failed` | Costs or effects may be uncertain; raise `step_unresolved`. |
| Invalid saved data | Raise `invalid_checkpoint`; never regenerate automatically. |

Structured-result and choice parsers revalidate saved values. They must be pure, synchronous, and preserve the exact JSON values. Current permission to disclose a result remains your app's responsibility.

For eligible tool-free work, see [explicit recovery](model-recovery.md). A failed completion write can leave a received answer unresolved. Changing the ID does not make repetition safe.

## Transactions and cancellation

Start, progress, completion, and failure use independent short transactions. An outer transaction prevents execution; no transaction stays open while awaiting the model. Concurrent starts serialize; only the record's creator runs new work. Storage errors propagate.

Optional `{ assertActive() }` on `run` checks entry, progress, and final acceptance. Completed replay skips this guard. [Tasks](tasks.md) use it for claims and cancellation.

After cancellation, one synchronous save may preserve the failure report. Check [spending](spending-records.md) separately: a saved result does not prove complete accounting.

See [timestamps](storage-schema.md#lifecycle-timestamps) and [storage upgrades](releases.md#0100) before changing deployed versions.
