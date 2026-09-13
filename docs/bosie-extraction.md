# Bosie extraction map

Small Hour begins from the live loop in Bosie's `server/runtime.ts`, but the public package is not a copy of Bosie.

## Extracted mechanism

| Bosie mechanism | Small Hour boundary |
| --- | --- |
| Anthropic message/tool loop | `SmallHourRuntime` plus `AnthropicProvider` |
| per-bosie SOUL loader | `PersonaSource` interface |
| bounded SQLite conversation window | `MemorySource` interface |
| fixed interior tool list and dispatcher | `ToolRegistry` plus per-turn `allowedTools` |
| transient retry | `RetryPolicy` |
| six-hop cap and 4,000-character tool results | visible runtime limits |
| usage rows | `UsageSink` interface |
| `bosie_choose` first-call decision | optional structured `choice` tool |
| spoken-line scrub and length contract | `OutputPolicy` hook |
| atomic local effect and replayable outcome | optional `SqliteOperationStore` |
| saved presentation output and interrupted-attempt evidence | optional `SqliteModelStepStore` |
| model-spend reservation, settlement and inspection | optional `SqliteModelSpendStore` |

## Stays in Bosie

- game schema, queries, and connection ownership;
- SOUL contents, voice rules, feral stance, and expression logic;
- recent-window anti-parrot selection;
- fan club, status, profile, notes, journal, and history endpoints;
- channel delivery, moderation, proactive scheduling, and world clock;
- game receipt semantics, narration jobs, and workflow policy; generic local transactions and model-step checkpoints are available separately, and Bosie's callers have not adopted it;
- model choice, prompt composition, cost tables, household/global ceilings and spend notices specific to Bosie. Generic spending storage is available separately; Bosie's spending authority has not adopted it.

## Adoption path

1. Keep Bosie's current runtime untouched while Small Hour's fake-provider contracts settle.
2. Add a Bosie-local adapter implementing persona, memory, tools, usage, and output policy.
3. Compare current and extracted paths in dry-run mode using identical prompt packs.
4. Verify voice, tool ordering, latency, and token accounting before switching any live call.
5. Pin Small Hour to a commit or version; never make Bosie follow an unpinned moving package.

Package publication remains separate from extraction and requires the owner's decision.

## Generic hardening sync

The 2026-08-09 audit compared this extraction with Bosie's later live runtime. Small Hour now carries the reusable
lessons: strict provider schemas, connection-aware retries, abortable backoff, valid bounded tool-result envelopes,
complete-stop enforcement, a reserved post-tool hop, explicit reply/silence/rejection status, and read-before-choice
with host-authorized writes. Bosie's grounding envelopes, voice repair, entity provenance, game tools, and durable
telemetry remain host-specific and intentionally stay out of this package.
