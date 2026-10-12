# Releases and upgrades

## 0.10.0

Durable receipts, model-step states/results, spending records, task states and delivery states expose `createdAt` and `updatedAt`. New records use an application-supplied clock or `Date.now`; inspection, completed replay and identical reconciliation preserve saved times. Old records retain `null` historical times. These fields describe local persistence, not remote receipt or execution times. See [lifecycle semantics and the storage ERD](storage.md).

The task runner initializes only evidence stores needed by registered step kinds. Local/model workflows do not require delivery storage. Spending remains separately configured and initialized by the application. Completed local task steps now expose their `receipt` alongside `result`.

Stop all users of the affected durable stores and take a verified database backup before calling `initialize()`. Initialization adds nullable timestamp columns and upgrades record formats: receipts/tasks/deliveries 1→2, ordinary model steps 1→3, recovery-enabled model steps 2→4, and spending 2→3. Earlier single-scope spending data first follows the existing scope migration. Scope memberships also gain nullable timestamps. Payloads, IDs, results, charges, uncertain reservations and recovery checkpoints remain intact; no historical creation date or application data is backfilled. Each store's metadata migration rolls back on failure; a runner may have initialized another required store before a later store fails. Keep execution stopped, correct the failure and rerun initialization, or restore the complete backup.

Older readers reject the upgraded records. Mixed-version writers and automatic downgrade are unsupported: stop existing workers before migration, including in-flight model and delivery work. Restoring only the previous package pin is insufficient. Before new work occurs, restore the verified pre-upgrade database and package together; after new work, preserve and reconcile later effects, model calls and delivery evidence before any rollback. Consumers upgrade separately. Model/provider APIs and execution policy are unchanged.

## 0.9.0

Managed Anthropic connections use only an explicit `apiKey` or `ANTHROPIC_API_KEY`, fix the endpoint to `https://api.anthropic.com`, and disable SDK logging. Missing or blank keys fail during construction; an explicit blank key does not fall back. Ambient bearer tokens, alternate endpoints and SDK profile/configuration no longer select this connection. A nonblank `ANTHROPIC_CUSTOM_HEADERS` fails construction.

Before upgrading, check how the application configures Anthropic. Ordinary API-key consumers need no new option. Applications needing custom endpoints, credentials, headers or SDK logging must explicitly supply their own `client` and review its configuration. Each Messages request disables SDK retries and requests redirect rejection, even with an injected client. Custom clients and fetch implementations remain trusted application code; Small Hour cannot force them to honor these options.

No storage migration or backfill is required. Provider settings belong in the application's workflow revision. Keep the previous package pin for rollback; reverting restores the previous SDK-default behavior, including redirects and environment configuration. Consumer upgrades remain separate. Transport behavior is verified with fake credentials and controlled HTTP responses; live account access is a separate check.

## 0.8.0

Registered tools now require explicit selection and local validation. Recoverable errors no longer forward arbitrary exception details to the model. This changes the public tool API:

- Supply `allowedTools` on every ordinary turn whose runtime has registered tools. Choose names deliberately; `[]` withholds all registered tools. Omission fails with `tool_allowlist_required` before loading context or admitting a model call. Tool-free runtimes and structured-output turns retain their behavior.
- Add a synchronous `parse(input)` to every registered tool. Validate the actual argument contract and return the checked value; a pass-through cast is not validation. Missing parsers reject registration, and promises or thrown errors prevent execution. Providers' schemas do not replace this local check.
- Expect generic `Tool failed.` feedback with `tool_failed`, or a fixed runtime denial code. For safe repair instructions, throw `ModelSafeToolError(message, { cause })`; only its message is forwarded. Exception causes remain private, and uncertain writes still stop the turn. Explicit tool results and opt-in captured content keep their disclosure contract.

See the [tool example and error contract](embedding.md#context-and-tools). No tables, schema migrations or backfills are added. Saved results are unchanged; completed replay does not rerun tool validation or sanitize historical content. Keep compatible handlers for pending workflows and bind changed selections or validation rules to new workflow revisions. A rollback restores the old permissive defaults and error disclosure behavior; retain explicit selections and safe error handling in the application. Consumer upgrades remain separate.

## 0.7.0

The optional SQLite spending store accepts overlapping budget scopes. A call must fit every selected allowance before dispatch; one reservation and charge count toward each scope. Existing single-scope quote inputs and inspection shapes remain supported. `ModelSpendQuote` is now a union; narrow `quote.scopes` when reading it and use an intersection rather than interface inheritance when extending it. See the [policy, sequence and storage ERD](model-spending.md).

`initialize()` now runs an independent transaction and migrates existing Small Hour spending rows to format 2. It validates the saved calls, preserves quotes, charges, uncertainty and reconciliation evidence, creates the scope-membership projection, and removes the old parent `scope` column. Other durable tables are unchanged. SQLite 3.35 or later is required for this migration. Initialization failure rolls back all changes; it never imports another ledger or invents memberships for historical calls.

Stop spending callers and back up before initializing the upgraded store. Older runtimes cannot read or write this schema, preventing admission that overlooks overlapping limits. Mixed-version spending writers and automatic downgrades are unsupported. Before any new provider work, a verified pre-upgrade backup can restore the old schema; after new work, preserve and reconcile those later charges before any rollback. Keep compatible spending readers/writers available. Consumer migrations remain separate.

## 0.6.1

The Anthropic adapter accepts optional `temperature` from 0 to 1, preserving explicit zero in requests and traces. Omission keeps the provider default. Invalid values and combinations with thinking are rejected before HTTP. Select a model supporting the requested sampling setting and include it in durable workflow revisions. No storage migration or backfill is required; existing unconfigured consumers retain their behavior.

## 0.6.0

Optional [execution tracing](tracing.md) joins turn, model-attempt, tool-call and output-check records with a shared trace ID and distinct spans. Applications supply a synchronous sink, explicitly enable content capture, and choose its byte limit. Built-in adapters expose their effective request and decoded response bodies; transport headers and credentials are excluded. Export or capture failures are reported without retrying effects or overriding execution outcomes.

Existing untraced execution retains its behavior and report shape. Traced SQLite model steps save optional correlation metadata in existing reports; no tables, migrations or backfills are added. Persist and resupply trace IDs when correlating recovery across invocations. Completed replay returns saved evidence without generating new model/tool events.

Keep 0.6-compatible readers for traced records: older versions can reject completed traced records or drop trace metadata when rewriting reports. Disabling tracing does not remove metadata already saved. Retain the previous package pin and compatible readers when planning rollback. Applications own content storage, access, retention, export flushing and downstream delivery evidence.

## 0.5.0

Requires Node.js 26.10 or later. The OpenAI Responses adapter uses the official OpenAI SDK, with SDK retries disabled and cancellation controlled by the runtime. Existing provider options, structured-output parsers, tool dispatch, image input and outcome contracts remain available. OpenAI credentials and endpoint selection retain their explicit boundaries.

Upgrade the application's Node runtime and reinstall dependencies before consuming this artifact; native application dependencies may need rebuilding for the new Node major. No storage migration or backfill is required. Existing workflow identities and incomplete-work recovery rules remain unchanged. Retain the prior package pin and compatible application handlers for rollback.

## 0.4.0

Turns accept ordered text/image blocks through Anthropic and OpenAI Responses. Shared validation rejects malformed, unsupported or oversized images before a model call; explicit input is copied and frozen before context loading. Existing string input keeps its behavior. See [image input](images.md) for the fixed count/byte limits and application obligations.

`TurnContext.input` now has type `InputContent`; callbacks using string methods must narrow it first. Durable model steps save explicit image bytes and order in their existing turn record. No schema migration or backfill runs, but older readers reject array-input rows. Retain compatible workflow handlers or stop affected execution during rollback. Bind memory-image identity and provider settings to workflow revisions.

The OpenAI adapter's public `reasoningEffort` type also accepts `max`, allowing that effort with supported models. Protocol, runtime and recovery behavior are verified with controlled responses. Live model quality and account access require separate verification.

## 0.3.0

The Anthropic adapter supports explicit adaptive thinking with optional effort. In this mode, `maxTokens` is the total per-call output ceiling, including reasoning. A manual turn-level thinking budget cannot be combined with adaptive mode; the runtime rejects the conflict before context loading, spending admission or provider dispatch. Existing unconfigured and manual-budget requests keep their behavior.

See [providers](providers.md) for configuration and supported-model obligations. Bind thinking mode and effort into the application's workflow revision when persisting model steps. No storage schema changes or backfills are required. Rollback requires retaining handlers for workflows configured with adaptive thinking; an older adapter does not support that setting. Provider protocol behavior is tested with controlled responses; live model quality requires separate evaluation.

## 0.2.0

This release adds precise provider stop evidence and explicit recovery for unfinished, tool-free model steps. It includes a [runtime overview and diagram](runtime.md).

Responded calls retain their normalized stop reason through execution reports, SQLite checkpoints and spending records. Anthropic responses also retain the original stop string. Refusal, token exhaustion, context exhaustion, provider pause and unknown stops remain distinct. None authorize partial output or tool execution.

Applications can initially opt a pure model step into fixed attempt/call limits, then authorize recovery against its exact inspected checkpoint. The same logical step preserves prior attempts, accepted results and uncertain charges. The task runner exposes this through `retryModel`; ordinary execution never retries incomplete work automatically. See [model steps](model-steps.md) and [tasks](tasks.md).

## Install a built artifact

Use the versioned package from the [0.10.0 release](https://github.com/jingyufanclub/small-hour/releases/tag/v0.10.0):

```sh
npm install --save-exact https://github.com/jingyufanclub/small-hour/releases/download/v0.10.0/small-hour-0.10.0.tgz
```

Commit the application manifest and lockfile. The lockfile records the artifact URL and integrity; subsequent `npm ci` installs verify those bytes. The release also includes `SHA256SUMS` for checking a downloaded artifact. The package contains built ESM and declarations, so installation needs no source build. No public npm registry publication is configured.

Consumers and development checks require Node.js 26.10 or later. The application supplies its synchronous SQLite connection and driver. A source checkout or Git submodule still needs `nvm use`, `npm ci` and `npm run build`; pin its commit explicitly.

## Consumer obligations

- Handle `context_limit` and `pause` in exhaustive provider-stop switches. `ModelCallRecord` is now a discriminated union; replace interface inheritance with an intersection when extending it.
- Anthropic refusal now raises `provider_refused`; update callers that previously treated it as `incomplete_stop`. Context exhaustion and pause still raise `incomplete_stop`, with the distinction preserved in the call's `stop` evidence.
- Keep workflow revisions tied to provider settings, context sources, parsers and acceptance policy. Recovery requires pure callbacks and explicit tool exclusion. It is unavailable for prior steps that did not opt in. Adding task recovery changes the immutable manifest: use a new workflow version and retain old handlers for already-enqueued tasks, even when their model step has not started.
- Preserve old spending reservations until authoritative reconciliation. Recovery permission does not establish that an earlier call was free.
- Back up durable data before upgrading and follow the selected release's storage requirements. The current timestamp upgrade changes record formats without inventing historical dates. Stop old writers; restoring an older package alone is insufficient after migration or new work.
- Verify the application's actual selection, effect, output and delivery boundaries before rollout. Keep the previous known-good dependency pin and a compatible recovery plan.

Provider mechanics are checked with controlled responses. Live model quality, model-specific capabilities and consumer integrations require separate verification. Streaming and audio input remain unavailable.

## Producing a release

Run `npm run check` and `npm run check:package` on the candidate. The package check starts without `dist`, builds and packs source in temporary storage, installs the tarball into a separate consumer, and verifies public exports plus runtime and SQLite recovery behavior. CI uses the Node.js version pinned in `.nvmrc`.

Use `npm run check:package -- --out-dir /absolute/release-directory` to retain the verified artifact and checksum. Review the version, notes and commit, then tag that exact commit and attach the verified files. Consumers upgrade separately.
