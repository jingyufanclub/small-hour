# Architecture and responsibilities

Small Hour runs a model/tool exchange inside your application. Your app decides the workflow; Small Hour carries out its model calls and execution checks. The [runtime diagram](runtime.md) shows the order.

## Give each decision one owner

| Decision | Owner |
| --- | --- |
| Which workflow, model, instructions, and context to use | Application |
| How to interpret information and generate a candidate answer | Model |
| Which tools may be offered and what their arguments mean | Application |
| Enforcing the tool list, invoking argument validation, and dispatching tools | Small Hour |
| Whether this caller may read or change a specific record | Application, inside the tool |
| Provider retries, turn limits, and execution reports | Small Hour |
| Budget amounts, prices, and who shares a budget | Application; optional Small Hour spending store enforces reservations |
| Whether an answer is useful and what reaches the user | Application |

One component should own each retry, effect, and charge. SDK retries are disabled so they cannot multiply the runtime's attempts. When adopting Small Hour, replace the existing retry/accounting owner for that path.

## Check different things at different boundaries

1. **Did the model finish?** Small Hour checks the provider's stop reason. Truncation or refusal cannot pass as a completed answer.
2. **Is the data valid?** Your parser checks tool arguments or structured output. A schema alone cannot establish permission or truth.
3. **May this action happen?** Your application checks current records and permission where it reads, writes, or sends. Preserve validated IDs through later steps.
4. **Is the answer good?** Use application-specific evaluations for accuracy, completeness, tone, and disclosure. A second model can help grade against a tested rubric; Small Hour does not run one automatically.
5. **Was it delivered?** Check transport evidence. Provider acceptance, device receipt, and user receipt are different outcomes.

The default text output policy accepts completed text. A custom `OutputPolicy` receives text and `TurnContext`, without tool receipts or the execution report. Checks needing those records belong in application code. Completed model-step replay skips the text policy; check current permission before disclosure.

## Add capabilities when the workflow needs them

Start with one turn. Add [saved results](storage.md) for recovery, [tasks](tasks.md) for ordered work, and [tracing](tracing.md) for observation. Traces cannot authorize effects or guarantee audit records were saved.

Routing, delegation, retrieval, memory selection, and context reduction belong to the application. Fixed workflows need no autonomous subagents. Reasoning effort guides the model; [execution limits](execution.md) and [spending controls](model-spending.md) bound its work.

Test realistic inputs, denied access, interruption, uncertain effects, changed permissions, and reuse of exact saved results. Scripted model tests establish mechanics; evaluate actual model answers separately. Preserve compatible workflow handlers and records through upgrades.
