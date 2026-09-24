# Architecture decisions

Small Hour runs bounded model calls inside application-defined workflows. The application owns workflows, domain policy and the final user experience; models perform assigned interpretation and generation. The [runtime diagrams](runtime.md) show the call sequence and recovery path.

## Choose the execution pattern

Use an application-defined sequence when the stages are known. Small Hour supports model/tool turns and optional ordered durable steps. Routing to a workflow, model or tool set belongs to the application. The runtime does not generate workflows, spawn subagents or run a second model to judge every response.

Dynamic delegation can help when the required subtasks vary or independent work needs separate contexts. A generate/evaluate/revise loop can help when a clear rubric produces measurable improvements. Both need application-owned limits, failure behavior and evaluation. These are optional patterns in Anthropic's [workflow guidance](https://www.anthropic.com/engineering/building-effective-agents), not requirements for every application.

## Keep each decision with its owner

| Decision | Small Hour supplies | Application supplies |
| --- | --- | --- |
| What the model sees | Fresh instruction/context loading and provider encoding | Relevant sources, audience boundaries and memory selection |
| What may execute | Tool allowlists, argument-parser hooks and optional accepted-choice requirements | ID validation, current permission and effect implementation |
| Whether execution continues | Precise stop handling, call/deadline limits and bounded provider retries | Limits, escalation and authorized recovery policy |
| What may be returned | Structured-result parsing and configurable text output policy | Acceptance criteria and semantic evaluation |
| What survives failure | Optional local receipts, model checkpoints and spending reservations | Stable operation identities, storage and reconciliation evidence |
| What reaches a user | Optional saved-output dispatch through explicit sinks | Destination authorization, transport and receipt interpretation |

The [core loop](../src/runtime.ts), [tool registry](../src/tools/registry.ts) and [durable components](tasks.md) enforce different boundaries. A model-selected ID must still be checked against authoritative state. A schema, prompt or trace cannot grant permission.

## Validate distinct promises

1. **Provider completion:** a terminal response permits output checks; `tool_use` permits tool dispatch. Truncation, refusal, context exhaustion, pause and unknown stops remain distinct evidence. Completion alone does not establish task success.
2. **Structure:** a structured-output turn requires an application parser. Tool argument parsing is configurable. Valid JSON does not prove a selected object exists or belongs to the caller.
3. **State and effects:** application code checks current records, permission and committed receipts at the effect boundary. Preserve accepted IDs and outcomes through later generation.
4. **Meaning:** evaluate whether the final response is supported, complete and appropriate. Voice quality, factual accuracy and disclosure are separate criteria. Use representative cases and human-calibrated model graders where useful; no universal model judge is built in.
5. **Delivery:** validate the exact saved product and current permission before sending. A rewritten response is a new candidate. Transport acceptance, device receipt and user receipt are different evidence.

The default [text policy](../src/policy/output.ts) accepts output. A supplied `OutputPolicy` receives final text and `TurnContext`, not the execution report or tool receipts. Keep checks requiring authoritative receipts in application code. [Completed model-step replay](model-steps.md) returns the saved result without rerunning output policy; current delivery authorization therefore remains necessary.

Code, model and human grading answer different questions. Anthropic's [evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) distinguishes the execution transcript from the resulting environment state. Runtime tests with scripted responses establish mechanics; applications need semantic evaluations of the actual models, context and final outputs. Measure false rejection as well as missed errors, latency and cost before adding a live evaluator.

## Bound work and preserve evidence

Only the runtime retries provider calls; SDK retries are disabled. Output tokens constrain a call, while calls, hops and deadlines bound a turn. Optional spending scopes span reservations and charges across work. Applications provide prices and estimates; underestimated charges are recorded, and uncertain calls retain reservations. Reasoning effort guides model behavior rather than setting a spending ceiling. See [execution](execution.md), [providers](providers.md) and [spending](model-spending.md).

Local receipts commit local database effects and results together. Completed model steps replay saved results. Incomplete recovery requires an initially eligible tool-free step, explicit authorization and the inspected checkpoint. Cancellation cannot undo committed effects. Delivery retries consume the saved product without regenerating it. See [local operations](local-operations.md), [model steps](model-steps.md) and [delivery](delivery.md).

Context selection belongs to the application; the runtime adds no transcript archive, automatic retrieval or compaction. Cache reuse optimizes matching input and cannot establish memory or truth. Preserve necessary facts when reducing context, as discussed in Anthropic's [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and [caching guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

[Tracing](tracing.md) connects attempts, tools and checks while leaving capture, storage and access to the application. Trace handoff is observational, not proof of persistence or delivery. Required audit-before-effect controls need a separate enforcement contract.

## Adopt one boundary at a time

Start with one stable model operation and preserve its input, output, state validation and failure contract. Replace its existing provider/retry owner rather than nesting execution loops. Choose one spending authority. Evaluate optional durable components separately: existing workers, transaction boundaries and delivery identities do not become compatible merely because their concepts have similar names. Test restart, partial failure, changed permission and exact saved-output reuse before expanding adoption.
