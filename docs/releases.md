# Install and upgrade

Requires Node.js 26.10+ with ESM imports. Install the built [0.10.0 artifact](https://github.com/jingyufanclub/small-hour/releases/tag/v0.10.0):

```sh
npm install --save-exact https://github.com/jingyufanclub/small-hour/releases/download/v0.10.0/small-hour-0.10.0.tgz
```

Commit your application's manifest and lockfile. Later `npm ci` installs verify the recorded integrity. The release also includes `SHA256SUMS`.

The artifact contains JavaScript and TypeScript declarations; installation needs no source build. Public npm publication is not configured. From a source checkout, pin a commit and run `nvm use`, `npm ci`, and `npm run build`.

## 0.10.0

This version adds record timestamps and initializes only stores required by registered task steps. Completed local task steps include their receipt. See [storage](storage.md) and its [schema reference](storage-schema.md).

**Existing databases require an upgrade.** Fresh databases can initialize normally.

1. Stop users of the affected stores, including in-flight model and delivery work.
2. Take a verified database backup.
3. Upgrade the package and call each required store's `initialize()`.
4. Verify saved results, task recovery, and budgets before resuming work.

Initialization adds nullable timestamps and changes record formats:

| Records | Format change |
| --- | --- |
| Local receipts, tasks, deliveries | 1 → 2 |
| Ordinary model steps | 1 → 3 |
| Recovery-enabled model steps | 2 → 4 |
| Spending | 2 → 3 |

Earlier single-scope spending first follows its scope migration. IDs, results, charges, reservations, and recovery checkpoints remain intact. Unknown historical dates stay `null`; application data is not backfilled.

Each store's timestamp migration rolls back on failure. The runner may have initialized another store first. Keep execution stopped while correcting the failure and rerunning initialization, or restore the complete backup.

## Rollback and older versions

Older readers reject upgraded records. Mixed-version writers and automatic downgrade are unsupported. **Restoring only the old package is insufficient.**

Before any new work, restore the pre-upgrade database and package together. After new work, preserve and reconcile later effects, calls, charges, and delivery evidence before rollback.

When crossing earlier releases, also read [older-version upgrade requirements](upgrading.md). Keep workflow versions tied to provider settings, context, validators, and effect policy. Retain compatible handlers for queued work.

## Producing a release

Run `npm run check` and `npm run check:package` on the candidate. The package check builds and installs an artifact into a separate consumer, exercising public exports and recovery. CI uses the Node version in `.nvmrc`.

Use `npm run check:package -- --out-dir /absolute/release-directory` to retain verified files. Review the version and exact commit, tag it, and attach that artifact and checksum. Applications upgrade separately.

These checks use controlled model responses. Live model quality and actual application integration need separate verification.
