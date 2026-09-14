# Local operations

Import `SqliteOperationStore` from `small-hour/durable/sqlite`, supply an existing synchronous connection, and call `initialize()` to create `small_hour_operation_receipts`. The structural connection interface supports `node:sqlite` and `better-sqlite3`; no driver or connection is created by the package.

## API

| Method | Result |
| --- | --- |
| `commit(request, { execute, parseResult })` | Executes local work and returns `{ receipt, replayed }`. A completed duplicate returns its original receipt. |
| `find(request, parseResult)` | Reads a validated receipt without execution, or returns `undefined`. |

`OperationRequest` contains nonempty `scope`, `id`, `kind`, `version`, and JSON `input`. `(scope, id)` is bound to the exact contract. Conflicting reuse throws `contract_conflict` before execution.

Inputs and results accept plain JSON: finite numbers, strings, booleans, null, dense arrays, and plain data objects. Unsupported values fail. Object-key order is insignificant; array order and values remain exact. No size limit or truncation policy is imposed.

`parseResult` validates new and replayed results synchronously and preserves their JSON values. It cannot substitute IDs or reinterpret decisions. Invalid new results throw `invalid_result`; invalid saved receipts throw `invalid_receipt`. Neither permits replaying the effect under that identity.

## Atomic boundary

`commit()` opens a savepoint and reserves the identity before calling `execute(database)`. Application mutations, a replayable result, and any [staged output](delivery.md) use the same connection and transaction. They commit or roll back together. Concurrent duplicates serialize through SQLite.

An existing outer transaction controls final commit. Released savepoints and returned receipts remain provisional until that commit; `find()` on the same connection can see provisional work.

Executors and parsers must be synchronous. Only participating database writes are atomic. Model calls, filesystem writes, sends, and transaction-control statements must remain outside executors. Async functions are rejected; returned promises cause rollback but cannot cancel already-started continuations. The receipt table and `small_hour_operation` savepoint are reserved.

Storage and busy errors propagate without retries. An unconfirmed rollback preserves the original error. Connection durability, lifetime, and busy timeout remain application responsibilities.

## Recovery and retention

A crash leaves either the committed effect and receipt or neither. An uncommitted local operation can run again. The receipt stores the scoped identity, kind, version, and result; it does not establish a remote outcome or current permission to disclose it.

Applications authenticate identities, authorize effects and result disclosure, and retain receipts throughout the duplicate-request window. Deletion removes protection. Initialization performs no application migration or backfill. Incompatible contracts require an explicit migration or new identity with a justified recovery decision. See [storage and access](security.md).
