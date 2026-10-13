# Storage reference

See [why storage is useful](storage.md).

## Relationships and authority

`scope` and `id` identify saved work. Local receipts and model steps may exist independently. Task-step identities derive from the task and step; delivery evidence shares its task's identity.

The ERD shows selected columns. Dotted relationships are enforced by runtime code; the spending link is a SQL foreign key.

SQLite guards protect accepted task identity, input, steps, and original schedule, including concurrency scope. Current due times and execution progress remain mutable. Applications control deletion and schema access; the guards do not prevent deliberate database tampering.

```mermaid
erDiagram
    accTitle: Small Hour's saved records
    accDescr: Tasks link to local receipts, model steps or delivery evidence. Spending memberships reference a single charge through a SQL foreign key.
    small_hour_tasks |o..o{ small_hour_operation_receipts : "local steps (logical)"
    small_hour_tasks |o..o{ small_hour_model_steps : "model steps (logical)"
    small_hour_tasks ||..o| small_hour_deliveries : "delivery task (logical)"
    small_hour_model_spend ||--|{ small_hour_model_spend_scopes : indexes
    small_hour_tasks {
        TEXT scope PK
        TEXT id PK
        TEXT input_json "fixed accepted input"
        TEXT plan_json "fixed workflow steps"
        TEXT schedule_json "fixed original schedule"
        TEXT status "execution progress"
        INTEGER attempts "all task claims"
        INTEGER admission_pauses "claims paused at admission"
    }
    small_hour_operation_receipts {
        TEXT scope PK
        TEXT id PK
        TEXT result_json "committed local result"
    }
    small_hour_model_steps {
        TEXT scope PK
        TEXT id PK
        TEXT report_json "calls, refusals and recovery evidence"
        TEXT result_json "completed result, if available"
    }
    small_hour_deliveries {
        TEXT scope PK
        TEXT id PK
        TEXT attempts_json "sending and receipt evidence"
    }
    small_hour_model_spend {
        TEXT call_id PK
        TEXT quote_json "quote or explicit denial"
        INTEGER charged_amount "null while unresolved"
    }
    small_hour_model_spend_scopes {
        TEXT call_id PK,FK
        TEXT scope PK
    }
```

Enable SQLite foreign-key checks. Budget memberships reference one call's balance; keep both tables together. `quote_json` stores a cost quote or explicit denial with scopes, reason, and evidence. Denials have zero exposure. Spending call IDs also appear in model reports.

`admission_pauses` counts [claim credits](admission-pauses.md) backed by model refusals; credits cannot release money or erase history.

## Lifecycle timestamps

All six tables have nullable `created_at` and `updated_at` columns. Public records expose `createdAt` and `updatedAt`: nonnegative integer milliseconds since the Unix epoch, or `null` when historical time is unknown.

- `createdAt` records the first insertion. Recovery keeps that time.
- `updatedAt` records a saved change, including claim renewal or stronger delivery evidence.
- Reading, completed replay, duplicate enqueue, and identical reconciliation preserve times.
- Budget memberships keep their admission times; settlement updates the call row.
- Migrated records keep unknown historical times. A later change can set `updatedAt` while `createdAt` stays `null`.

Stores accept `{ now: () => milliseconds }`, defaulting to `Date.now`. The runner shares its clock with its stores. Times never move backward; equal times are possible. Timestamps cannot establish remote outcomes or authorize recovery.

Local receipts and enqueued tasks remain provisional until an enclosing transaction commits; these timestamps do not record that outer commit. Delivery timestamps describe local evidence, not remote receipt time. Unattempted deliveries have null times.

See [upgrades](releases.md#0100) before opening old data. Your app owns retention; no automatic cleanup runs.
