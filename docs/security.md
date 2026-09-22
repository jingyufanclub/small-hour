# Security and storage

Model input and output are untrusted. Applications authenticate callers, select identity partitions, and authorize context, effects, inspection, cancellation, reconciliation, and disclosure. `agentId` and storage scopes are identifiers, not authentication mechanisms.

## Execution boundaries

- Register narrow tools and validate domain inputs. Per-turn allowlists constrain execution; schemas alone cannot authorize effects.
- Declare read/write modes. Choice-governed writes require an accepted choice and explicit authorization for each call. Stable operation IDs must cover repeated requests arriving under different provider IDs.
- Validate and moderate final output for its destination. A saved result or receipt does not grant permission for new disclosure.
- Configure context bounds, model-call limits, deadlines, token allowances, and tool-result handling. Preserve required facts when selecting context or replacing oversized results.
- Keep SDK retries disabled. Unknown effects require evidence-based recovery. Cancellation, lease expiry, and timeouts cannot undo work already started.
- Choose trusted endpoints and verified model capabilities. HTTP adapters reject redirects; compatible endpoints receive only explicit credentials. Opaque provider history stays unchanged within its original provider's turn.

The package exposes no unrestricted shell, filesystem, browser, proxy, channel, or credential capabilities. Application tools and sinks remain responsible for the capabilities they implement.

## Storage and access

Durable components are opt-in and use a supplied synchronous SQLite connection through `exec`, `prepare`, `get`, and `run`. Constructors open no connection or worker. `initialize()` creates versioned tables; it does not migrate application rows or import historical effects/spending.

Applications own connection lifetime, durability settings, busy timeout, backup, access control, and retention. Authenticate all administrative APIs. Storage/busy errors propagate without another retry loop. Restore or replace a connection after an unconfirmed rollback before attempting recovery.

| Component | Saved data |
| --- | --- |
| Local operations | Explicit contract and validated result. |
| Model steps | Explicit contract, turn configuration, reports, and completed result. |
| Spending | Identity, token limits, pricing quote, normalized outcome/usage, and reconciliation evidence. |
| Tasks | Input, manifest, schedule, claims, lifecycle, and resolution. |
| Delivery | Attempt IDs and receipt/outcome evidence; payload remains in the task. |

Contracts, input text and image bytes, tool arguments, generated results, destinations, pricing JSON, and evidence may contain private data. Explicit image input is stored when model steps are selected; applications own image disclosure and storage retention. Keep credentials outside instructions, memory, contracts, and tool results. Retrieved memory packets and provider-native history are not automatically copied into durable storage.

Retain participating rows for the duplicate/recovery window. Deleting receipts removes replay protection; deleting spending or changing scopes removes budget history. Keep compatible workflow handlers during upgrades or stop execution during rollback. Adoption must replace the previous effect, retry, accounting, or transport authority for the selected path.

Claims fence runner-owned local commits and task transitions. Remote systems require actual idempotency and effect-boundary authorization. Applications verify reconciliation evidence and establish that old work cannot later contradict it. Receipt shape validation cannot establish authenticity or universal exactly-once behavior.
