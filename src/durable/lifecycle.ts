import type { SqliteDatabase } from "./sqlite.js";

export interface RecordTimestamps { createdAt: number | null; updatedAt: number | null }
export interface DurableClockOptions { now?: () => number }

type Table = "small_hour_operation_receipts" | "small_hour_model_steps" | "model_calls"
  | "model_call_scopes" | "small_hour_tasks" | "small_hour_deliveries";

function timestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError("Record times must be nonnegative integer milliseconds.");
}

export function recordTime(now: () => number, previous: number | null = null): number {
  const value = now(); timestamp(value);
  return Math.max(value, previous ?? 0);
}

export function readTimestamps(row: Record<string, unknown>): RecordTimestamps {
  const createdAt = row.created_at, updatedAt = row.updated_at;
  if (createdAt !== null) timestamp(createdAt);
  if (updatedAt !== null) timestamp(updatedAt);
  if (createdAt !== null && (updatedAt === null || updatedAt < createdAt)) throw new TypeError("Record times are inconsistent.");
  return { createdAt, updatedAt };
}

export function initializeTimestamps(database: SqliteDatabase, table: Table, versions: readonly (readonly [number, number])[]): void {
  database.exec("SAVEPOINT small_hour_record_times");
  try {
    const created = database.prepare("SELECT name FROM pragma_table_info(?) WHERE name = 'created_at'").get(table);
    const updated = database.prepare("SELECT name FROM pragma_table_info(?) WHERE name = 'updated_at'").get(table);
    if (!!created !== !!updated) throw new TypeError("The durable timestamp schema is incomplete.");
    if (!created) {
      if (versions.length) {
        const supported = versions.map(([from]) => from).join(",");
        if (database.prepare(`SELECT 1 FROM ${table} WHERE format_version NOT IN (${supported}) LIMIT 1`).get()) {
          throw new TypeError("The durable record format cannot be upgraded.");
        }
        database.exec(`UPDATE ${table} SET format_version = CASE format_version
          ${versions.map(([from, to]) => `WHEN ${from} THEN ${to}`).join(" ")} END`);
      }
      database.exec(`ALTER TABLE ${table} ADD COLUMN created_at INTEGER
        CHECK (created_at IS NULL OR (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991))`);
      const format = versions.length ? `format_version IN (${versions.map(([, to]) => to).join(",")}) AND ` : "";
      database.exec(`ALTER TABLE ${table} ADD COLUMN updated_at INTEGER CHECK (${format}
        (updated_at IS NULL OR (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991))
        AND (created_at IS NULL OR (updated_at IS NOT NULL AND updated_at >= created_at)))`);
    }
    database.exec("RELEASE SAVEPOINT small_hour_record_times");
  } catch (cause) {
    try { database.exec("ROLLBACK TO SAVEPOINT small_hour_record_times"); database.exec("RELEASE SAVEPOINT small_hour_record_times"); }
    catch (rollback) { throw new AggregateError([cause, rollback], "The record timestamp upgrade could not be rolled back.", { cause }); }
    throw cause;
  }
}
