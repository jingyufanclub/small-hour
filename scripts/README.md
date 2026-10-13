# Package verification

`npm run check:package` builds and packs the current checkout, then checks its public JavaScript and TypeScript exports in a separate consumer.

The check verifies the export map, type declarations, license, and package contents, then exercises runtime and SQLite APIs through the installed artifact. It starts from source without an existing build. Stubbed provider responses avoid paid model calls; installation requires registry access. Temporary files are removed afterward.

Pass `--core-only` to omit SQLite execution, or `--out-dir /absolute/path` to retain the verified tarball and checksum. The output directory must not already contain either artifact.

CI runs this check alongside `npm run check`. Scripts and fixtures are excluded from the published package. See [Testing](../docs/testing.md) for the behavioral testing contract.
