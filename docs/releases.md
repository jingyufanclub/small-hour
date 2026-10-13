# Install and upgrade

Requires Node.js 26.10+ with ESM imports. Install the built [0.13.0 artifact](https://github.com/jingyufanclub/small-hour/releases/tag/v0.13.0):

```sh
npm install --save-exact https://github.com/jingyufanclub/small-hour/releases/download/v0.13.0/small-hour-0.13.0.tgz
```

Commit your manifest and lockfile; `npm ci` verifies recorded integrity. Releases include `SHA256SUMS`.

Artifacts contain JavaScript and TypeScript declarations. Public npm publication is not configured. Source installs require `nvm use`, `npm ci`, and `npm run build` at a pinned commit.

## Admission pauses

Stop workers and upgrade readers before enabling [admission pauses](admission-pauses.md). `runner.initialize()` adds `admission_pauses`, defaulting existing tasks to zero without changing their limits. Setup can join an app transaction. Older packages reject opted-in contracts and paused tasks.

## 0.11.0

Spending schema initialization can join an app transaction or savepoint. Commit setup before execution; admission, settlement, and reconciliation still require independent transactions.

`ModelSpendPolicy.quote` returns a quote or [explicit denial](spending-records.md#deny-before-pricing). Inspection returns `quote: null` plus `denial` for explicit denials; narrow before reading quote fields.

No table migration from 0.10.0. Denials use the existing `quote_json` decision snapshot in format 3. **Upgrade all readers before writing explicit denials:** older readers reject them. Existing quoted records keep their meaning.

## 0.10.0

This version adds [timestamps](storage-schema.md#lifecycle-timestamps), initializes stores required by registered steps, and includes receipts with completed local steps.

**Databases predating 0.10.0 require an upgrade.**

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

Run `npm run check` and `npm run check:package`. The latter tests public exports and recovery in a separately installed consumer. CI uses `.nvmrc`.

Use `npm run check:package -- --out-dir /absolute/release-directory` to retain verified files. Review the version and exact commit, tag it, and attach that artifact and checksum. Applications upgrade separately.

Checks use controlled responses; live model quality and application integration need separate verification.
