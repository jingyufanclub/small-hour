# Releases and upgrades

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

Use the versioned package from the [0.6.0 release](https://github.com/jingyufanclub/small-hour/releases/tag/v0.6.0):

```sh
npm install --save-exact https://github.com/jingyufanclub/small-hour/releases/download/v0.6.0/small-hour-0.6.0.tgz
```

Commit the application manifest and lockfile. The lockfile records the artifact URL and integrity; subsequent `npm ci` installs verify those bytes. The release also includes `SHA256SUMS` for checking a downloaded artifact. The package contains built ESM and declarations, so installation needs no source build. No public npm registry publication is configured.

Consumers and development checks require Node.js 26.10 or later. The application supplies its synchronous SQLite connection and driver. A source checkout or Git submodule still needs `nvm use`, `npm ci` and `npm run build`; pin its commit explicitly.

## Consumer obligations

- Handle `context_limit` and `pause` in exhaustive provider-stop switches. `ModelCallRecord` is now a discriminated union; replace interface inheritance with an intersection when extending it.
- Anthropic refusal now raises `provider_refused`; update callers that previously treated it as `incomplete_stop`. Context exhaustion and pause still raise `incomplete_stop`, with the distinction preserved in the call's `stop` evidence.
- Keep workflow revisions tied to provider settings, context sources, parsers and acceptance policy. Recovery requires pure callbacks and explicit tool exclusion. It is unavailable for prior steps that did not opt in. Adding task recovery changes the immutable manifest: use a new workflow version and retain old handlers for already-enqueued tasks, even when their model step has not started.
- Preserve old spending reservations until authoritative reconciliation. Recovery permission does not establish that an earlier call was free.
- Back up durable data before upgrading. Ordinary model rows remain format 1; recovery-enabled rows use format 2 in the existing table. No backfill runs. Older readers reject format 2, and older spending readers can discard new stop evidence when rewriting records. Retain compatible handlers or stop execution during rollback; restoring an older package alone is insufficient after new records exist.
- Verify the application's actual selection, effect, output and delivery boundaries before rollout. Keep the previous known-good dependency pin and a compatible recovery plan.

Provider mechanics are checked with controlled responses. Live model quality, model-specific capabilities and consumer integrations require separate verification. Streaming and audio input remain unavailable.

## Producing a release

Run `npm run check` and `npm run check:package` on the candidate. The package check starts without `dist`, builds and packs source in temporary storage, installs the tarball into a separate consumer, and verifies public exports plus runtime and SQLite recovery behavior. CI uses the Node.js version pinned in `.nvmrc`.

Use `npm run check:package -- --out-dir /absolute/release-directory` to retain the verified artifact and checksum. Review the version, notes and commit, then tag that exact commit and attach the verified files. Consumers upgrade separately.
