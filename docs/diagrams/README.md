# Runtime diagrams

The [runtime guide](../runtime.md) provides text descriptions of all three diagrams. PNG previews render directly in repository browsers. JSON files are the editable source; interactive HTML and SVG exports can be generated with [Archify](https://github.com/tt-a1i/archify).

| Source | Diagram | Code boundaries |
| --- | --- | --- |
| [architecture.json](architecture.json) | Application, runtime, provider and storage responsibilities | [Runtime](../../src/runtime.ts), [call accounting](../../src/model-calls.ts), [tools](../../src/tools/registry.ts), [providers](../providers.md) |
| [turn.json](turn.json) | One successful tool exchange | [Execution loop](../../src/runtime.ts), [admission](../../src/model-calls.ts), [deadline](../../src/deadline.ts) |
| [recovery.json](recovery.json) | Completed replay and explicitly authorized recovery | [Model steps](../../src/durable/model-steps.ts), [spending](../../src/durable/model-spend.ts), [task recovery](../../src/durable/tasks.ts) |

## Regenerate

Use Archify 2.17 from a separate checkout. The runtime has no diagram-generation dependency. Set `ARCHIFY_CLI` to that checkout's `bin/archify.mjs`, then run from this repository's root:

```sh
node "$ARCHIFY_CLI" validate architecture docs/diagrams/architecture.json --repo-root . --quality showcase --json
node "$ARCHIFY_CLI" deliver architecture docs/diagrams/architecture.json /tmp/small-hour-architecture.html --repo-root . --quality showcase --json
node "$ARCHIFY_CLI" deliver sequence docs/diagrams/turn.json /tmp/small-hour-turn.html --quality showcase --json
node "$ARCHIFY_CLI" deliver workflow docs/diagrams/recovery.json /tmp/small-hour-recovery.html --quality showcase --json
```

Run `visual-check` against each delivered HTML file. Open it in a browser, select the light theme and Classic style, then use **Export → PNG** to replace the matching preview. SVG exports retain editable vectors. Keep the standalone viewer, validation receipts and browser screenshots outside the package.

When behavior changes, update the specification and its text description together. The architecture source pins repository evidence to a commit; update that revision after checking the corresponding code. Require nine passing showcase checks with no composition errors or warnings, then inspect both themes, desktop layouts and the exported image before committing.
