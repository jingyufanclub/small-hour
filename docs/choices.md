# Keep a model's selection consistent

Use a **choice** when a model should select a validated value and later tools must act on that same selection. For example, the model can choose a record from an authorized set, then request a change to that record.

Add `choice` to a normal tool turn. Small Hour offers a synthetic tool named `small_hour_choose` by default and keeps the parsed selection in `result.choice` or the error report.

| Option | Meaning |
| --- | --- |
| `description`, `inputSchema`, `parse` | Explain and validate the selection. The parser checks application constraints. |
| `name` | Optional name; must not conflict with a registered tool. |
| `required` | Defaults to `true`; an answer without a choice fails. |
| `requiredFirst` | Allows preparatory reads, but requires a choice before writes. |
| `authorizeWrite(choice, tool, context)` | Must explicitly permit each choice-governed write. |
| `onChoice(choice, context)` | Optional notification after acceptance. Failure stops the turn and preserves the accepted selection. |

Choice values must support structured cloning. Callbacks receive copies; parsing and write authorization must not mutate application state. For [saved model steps](model-steps.md), parsers must also be synchronous and preserve the exact JSON value.

Your app still checks current permission and record state inside the actual tool. A choice is evidence of a selection, not permission to act. Keep its validated ID through later steps; do not ask the model to rediscover it from prose.

After acceptance, the choice tool is removed from subsequent calls. Recoverable choice errors follow the same [safe-error rules](embedding.md#context-and-tools) as tools. Use `ModelSafeToolError` only for deliberately shareable repair instructions.

Choose [structured output](embedding.md#structured-results) when you only need a validated object returned to your app. Structured-output mode cannot be combined with `choice` or tools.
