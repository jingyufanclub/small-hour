# Local operation contracts

`small-hour/durable/sqlite` exports `SqliteOperationStore`, its structural `SqliteDatabase` connection interface, operation request/receipt types, and `OperationError`. The adapter uses an existing synchronous connection; it imports no database driver and opens no files or background services. `node:sqlite` requires a compatible Node version; a consumer-supplied driver such as `better-sqlite3` can supply the same interface.

## Identity and results

`OperationRequest` supplies `scope`, `id`, `kind`, `version`, and `input`. All identity fields are nonempty strings and are retained exactly. `(scope, id)` identifies one operation. A reused identity with a different kind, version, or input fails with `contract_conflict` before the application executor runs.

Inputs and results must be JSON data: null, strings, booleans, finite numbers, dense arrays, and plain objects with enumerable data properties. Unsupported values fail instead of being silently omitted or converted. Object-key order is insignificant; array order and values are preserved. The adapter applies no truncation or application size policy.

`parseResult` validates both new and stored results and must return the same JSON value. It may not reinterpret accepted choices or substitute IDs. A failed decoder produces `invalid_result` for new work or `invalid_receipt` for stored work. An invalid receipt cannot authorize another execution. Keep contract versions stable while stored operations remain eligible for replay; changed contracts require an explicit application migration or a new operation identity.

## Atomic execution

`initialize()` explicitly creates `small_hour_operation_receipts`. The constructor performs no database work. The table's row format is versioned independently of application contracts; unsupported formats fail on read.

`commit()` opens a SQLite savepoint and reserves the operation identity before calling `execute(database)`. The executor receives the same connection. It may validate current facts and permissions, mutate application tables, and stage application output records. The result and receipt are saved before the savepoint is released. Concurrent duplicates contend through SQLite and replay the completed result. SQLite busy and storage errors propagate; the adapter starts no retries.

If execution, result validation, or receipt persistence fails, the savepoint rolls back all participating writes. Failure to confirm rollback is surfaced with the original error. If an outer transaction exists, releasing the savepoint does not commit it: returned receipts are provisional until the application commits that transaction. The adapter does not change journal, synchronization, timeout, or connection-lifecycle settings.

Executors and parsers must be synchronous. Declared async functions are rejected before execution; returned promises cause rollback. This cannot cancel asynchronous continuations already started or undo external effects. Model calls, filesystem writes, sends, network calls, and transaction-control statements must remain outside the executor. Only writes on the supplied connection participate in its transaction. Receipt tables and the `small_hour_operation` savepoint name are reserved for the adapter.

## Recovery and ownership

`find(request, parseResult)` returns a validated receipt or `undefined` when no committed operation is present. Within an outer transaction it can also see that transaction's provisional completed receipts. The receipt includes the exact scope, ID, kind, version, and result. `commit()` returns the same receipt plus `replayed`, and never invokes the executor for a completed matching receipt.

The adapter stores completed local operations, not failed attempts, model checkpoints, delivery confirmations, or conversation memory. A process crash during the transaction leaves either committed effects with their receipt or no participating writes. Recovery can repeat an uncommitted local operation; it cannot infer whether an unrelated external action completed.

Consumers authenticate callers, choose scopes and stable request IDs, authorize effects before commit, authorize access before returning a saved result, and implement retention. A receipt proves a past local operation, not current permission to disclose or deliver it. Deleting a receipt removes duplicate protection for that identity. Existing application rows are neither migrated nor backfilled automatically. The bounded turn runtime remains independent of this store.
