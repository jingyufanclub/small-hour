# Package verification

`npm run check:package` builds and packs the current checkout, then checks its public JavaScript and TypeScript exports in a separate consumer.

`node scripts/check-released-consumer.mjs` verifies the released 0.6.0 artifact in a fresh consumer. It downloads the GitHub release tarball, checks its pinned SHA256, installs without lifecycle scripts, and runs the read-only workflow fixtures using public exports. To use an already downloaded artifact, pass `--artifact /absolute/path/small-hour-0.6.0.tgz`; the same checksum is required.

The released-consumer checks exercise:

- Application-owned argument parsing and committed access audit before synthetic source reads, including failed inserts and commits.
- Separate evidence gathering and structured synthesis, shared spending, correlated traces and explicit content omissions.
- Provider outcomes, cancellation, preserved uncertain spending, completed-result replay and process interruption during tool-bearing work.

SQLite files and independent connections provide persistence evidence. Scripted providers establish execution mechanics, not model quality or a real application's authorization policy. No production source or paid model call is used. The fixture processes receive a minimal environment and run with Node network permission disabled, including the interruption child process. Installation still requires registry access. Temporary consumers and databases are removed after the checks.

CI runs both commands. These scripts and fixtures are excluded from the published package.
