# Durable model spending

`SqliteModelSpendStore` from `small-hour/durable/sqlite` connects persistent admission and settlement to the runtime's existing `modelCalls` hooks. Pass an existing synchronous SQLite connection and call `initialize()` to create `small_hour_model_spend` and its scope index. It opens no connection and starts no worker.

## Integration and policy

Set `modelCalls: store.hooks(policy)` on `SmallHourRuntime`. Both policy functions must be synchronous:

- `quote(context)` returns `{ scope, limit, amount, pricing }`. The context includes the runtime-generated `callId`, agent and turn IDs, provider/model, attempt, hop, input text, and requested output-token limits. `amount` is the conservative reservation for this attempt; `limit` is the current ceiling for the complete scope. `pricing` is application-defined JSON captured with the reservation.
- `charge(usage, pricing)` calculates the actual charge from validated provider token usage and the saved pricing value. It runs only for a response with complete usage. The application must account for all billable token categories and preserve the meaning of saved pricing versions when its pricing implementation changes.

Amounts and limits are nonnegative safe integers in an application-defined unit. The library has no currency, rate card, token estimator, calendar period, or price-fetching service. The quote must cover the full input, output and reasoning allowance, including context and tool results. `maxTokens` alone does not bound input cost. A hard ceiling depends on conservative quotes and correct provider pricing; an underestimated actual charge is recorded in full, even above the reservation or limit, and restricts subsequent admission.

Each call belongs to one application-selected budget scope. Use stable scopes across retries, restarts and workflow steps, with explicit period/unit identity where needed. Different scopes are independent; hierarchical or overlapping ceilings are not provided by this adapter. Changing the supplied limit changes future admission without erasing prior charges. The application must supply current policy and authorize scope selection; a scope is not an authentication boundary. A new call or turn ID never resets spending within that scope.

Do not add another charging sink or provider retry loop around these hooks. `usage.record` may receive successful usage for telemetry, but must not charge the same call again. Direct model calls made by tools or context loaders do not pass through the runtime's hooks and need their own admission boundary.

## Admission and settlement

Admission takes a short `BEGIN IMMEDIATE` transaction, reads the application's quote, sums confirmed charges plus unresolved reservations in the scope, and records either `reserved` or `denied`. A quote can read current policy from the same connection under that transaction; callbacks must not begin another transaction or cause external effects. Only a newly committed reservation returns `true` to the runtime. Reusing a call ID throws `call_exists`; it never authorizes a second provider invocation. A storage or commit failure stops before dispatch. SQLite serializes competing admissions across connections and processes.

After the provider attempt, the runtime invokes accounting before executing its requested tools or continuing the loop. The spending store records the following outcomes:

| State | Budget treatment |
| --- | --- |
| `denied` | Admission failed; no provider call was authorized and nothing is charged. |
| `reserved` | The reservation remains held. Execution or accounting may be pending or interrupted. |
| `accepted` | A known charge replaces the reservation. This means provider spending, independent of output acceptance. |
| `rejected` | A confirmed provider rejection or explicit reconciliation establishes no charge. |
| `unknown` | A lost response or missing usage retains the full reservation. |

Provider adapters must report `rejected` only for definite rejection. Included adapters retain uncertainty for server errors, timeouts and connection failures. A returned refusal, malformed result or application-rejected output does not establish free execution. A valid reply without usage can still complete, while its spending remains `unknown`.

The runtime retains sole ownership of bounded retries and deadlines. Every retry gets a new call ID and must reserve against the same persisted totals. Accounting failures stop further model calls and tools. Exact duplicate accounting is a no-op; conflicting accounting throws `settlement_conflict`. Cancellation starts no new accounting callback, so the original reservation may remain `reserved`. Reservations never expire automatically.

## Inspection and reconciliation

`inspect(callId)` returns the stored context identity, quote, status, charged amount, available provider record and reconciliation evidence, or `undefined`. `inspectBudget(scope)` returns accepted, reserved, unknown and total amounts. Obtain call IDs from runtime reports, durable model-step progress, or application queries against the spending table. The table is the accounting authority when a progress report still says `unrecorded` after a successful accounting commit.

`reconcile(callId, outcome)` accepts either `{ status: "accepted", amount, evidence }` or `{ status: "rejected", evidence }`. `evidence` must be a nonempty application-supplied reference to the authoritative conclusion. The library validates the shape; the application verifies the evidence and establishes that old execution cannot still produce a contradictory charge. Age, cancellation or a missing response alone is insufficient reason to release a reservation. A known `not_started` report may support release after admission has finished and provider non-execution is established.

Only `reserved` and `unknown` spending can transition through reconciliation. Repeating the exact same resolution is a no-op. A different resolution or an attempt to change settled spending throws `settlement_conflict`. Reconciliation never calls the provider, retries a task, changes an accepted model decision, or declares a model step complete.

With `SqliteModelStepStore`, completed-step replay bypasses both provider calls and accounting hooks. An explicitly authorized next step uses the remaining scope budget. Interrupted steps still require application reconciliation even when their spending is known; conversely a saved model result does not prove its spending was fully measured.

## Storage and rollout

Admission, accounting and reconciliation require independent transactions. They cannot run inside an application's outer transaction, and no transaction is held across a provider await. Storage/busy errors propagate without an additional retry loop. Applications own connection lifetime, SQLite durability settings, busy timeout, access control, backup and retention.

The table stores call/agent/turn identity, model and token limits, the explicit pricing quote, normalized provider outcome and usage, and reconciliation evidence. It does not automatically store input text, instructions, retrieved context, tool content, provider-native history or credentials. Pricing JSON and evidence can contain application-private data; keep them narrow and protect access.

Initialization adds a versioned table without changing existing application rows or importing historical charges. Adoption must account for existing spending and replace the previous charging authority. Retain these rows during rollback; an older caller that bypasses the hooks cannot enforce this budget. Deleting rows or choosing a new scope removes their spending from future admission. No unattended reconciliation, payment processing, production migration, or live provider verification is included.
