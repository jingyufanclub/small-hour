import { types } from "node:util";
import { canonicalJson } from "./json.js";
export { SqliteModelStepStore, ModelStepError, type ModelStepState, type ModelStepResult } from "./model-steps.js";

type SqliteValue = string | number | null;

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...values: SqliteValue[]): unknown;
    run(...values: SqliteValue[]): { changes: number | bigint };
  };
}

export interface OperationRequest {
  scope: string;
  id: string;
  kind: string;
  version: string;
  input: unknown;
}

export interface OperationReceipt<T> {
  scope: string;
  id: string;
  kind: string;
  version: string;
  result: T;
}

export interface LocalOperation<Database, Result> {
  execute(database: Database): Result;
  parseResult(value: unknown): Result;
}

export type OperationErrorCode = "invalid_request" | "contract_conflict" | "invalid_receipt" | "invalid_result" | "async_operation";

export class OperationError extends Error {
  constructor(readonly code: OperationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperationError";
  }
}


function checkedRequest(request: OperationRequest) {
  try {
    const { scope, id, kind, version, input } = request;
    for (const key of [scope, id, kind, version]) {
      if (typeof key !== "string" || !key.trim()) throw new TypeError("Operation identity fields must be nonempty strings");
    }
    return { scope, id, kind, version, inputJson: canonicalJson(input) };
  } catch (cause) {
    throw new OperationError("invalid_request", "The operation needs an identity and JSON input.", { cause });
  }
}

function synchronous<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    if (types.isPromise(value)) void value.catch(() => {});
    throw new OperationError("async_operation", "Local operations and result parsers must be synchronous.");
  }
  return value;
}

function parseResult<T>(json: string, parse: (value: unknown) => T, code: "invalid_receipt" | "invalid_result"): T {
  try {
    const result = synchronous(parse(JSON.parse(json)));
    if (canonicalJson(result) !== json) throw new TypeError("Result parsing must preserve the recorded JSON value");
    return result;
  } catch (cause) {
    throw new OperationError(code, "The operation result failed validation.", { cause });
  }
}

type CheckedRequest = ReturnType<typeof checkedRequest>;

export class SqliteOperationStore<Database extends SqliteDatabase> {
  constructor(private readonly database: Database) {}

  initialize(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS small_hour_operation_receipts (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      version TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      format_version INTEGER NOT NULL,
      PRIMARY KEY (scope, id)
    )`);
  }

  find<T>(request: OperationRequest, parse: (value: unknown) => T): OperationReceipt<T> | undefined {
    const checked = checkedRequest(request);
    const row = this.row(checked);
    return row === undefined ? undefined : this.receipt(checked, row, parse);
  }

  commit<T>(request: OperationRequest, operation: LocalOperation<Database, T>): { receipt: OperationReceipt<T>; replayed: boolean } {
    const checked = checkedRequest(request);
    if (typeof operation.execute !== "function" || typeof operation.parseResult !== "function") {
      throw new OperationError("invalid_request", "Local operations require an executor and result parser.");
    }
    if (types.isAsyncFunction(operation.execute) || types.isAsyncFunction(operation.parseResult)) {
      throw new OperationError("async_operation", "Local operations and result parsers must be synchronous.");
    }
    const db = this.database;
    db.exec("SAVEPOINT small_hour_operation");
    try {
      const inserted = db.prepare(`INSERT INTO small_hour_operation_receipts
        (scope, id, kind, version, input_json, result_json, format_version) VALUES (?, ?, ?, ?, ?, NULL, 1)
        ON CONFLICT (scope, id) DO NOTHING`)
        .run(checked.scope, checked.id, checked.kind, checked.version, checked.inputJson);
      let receipt: OperationReceipt<T>;
      const replayed = Number(inserted.changes) === 0;
      if (replayed) {
        receipt = this.receipt(checked, this.row(checked), operation.parseResult);
      } else {
        const result = synchronous(operation.execute(db));
        let json: string;
        try { json = canonicalJson(result); } catch (cause) {
          throw new OperationError("invalid_result", "Local operations must return JSON data.", { cause });
        }
        const parsed = parseResult(json, operation.parseResult, "invalid_result");
        const updated = db.prepare(`UPDATE small_hour_operation_receipts SET result_json = ?
          WHERE scope = ? AND id = ? AND result_json IS NULL`)
          .run(json, checked.scope, checked.id);
        if (Number(updated.changes) !== 1) throw new OperationError("invalid_receipt", "The operation receipt changed during execution.");
        receipt = { scope: checked.scope, id: checked.id, kind: checked.kind, version: checked.version, result: parsed };
      }
      db.exec("RELEASE SAVEPOINT small_hour_operation");
      return { receipt, replayed };
    } catch (cause) {
      try {
        db.exec("ROLLBACK TO SAVEPOINT small_hour_operation");
        db.exec("RELEASE SAVEPOINT small_hour_operation");
      } catch (rollbackError) {
        throw new AggregateError([cause, rollbackError], "The operation failed and SQLite rollback could not be confirmed.", { cause });
      }
      throw cause;
    }
  }

  private row(request: CheckedRequest): unknown {
    return this.database.prepare(`SELECT kind, version, input_json, result_json, format_version
      FROM small_hour_operation_receipts WHERE scope = ? AND id = ?`).get(request.scope, request.id);
  }

  private receipt<T>(request: CheckedRequest, row: unknown, parse: (value: unknown) => T): OperationReceipt<T> {
    if (!row || typeof row !== "object" || !("kind" in row) || !("version" in row) || !("input_json" in row)
      || !("result_json" in row) || !("format_version" in row) || Number(row.format_version) !== 1
      || typeof row.kind !== "string" || typeof row.version !== "string" || typeof row.input_json !== "string") {
      throw new OperationError("invalid_receipt", "The stored receipt format is unavailable or unsupported.");
    }
    if (row.kind !== request.kind || row.version !== request.version || row.input_json !== request.inputJson) {
      throw new OperationError("contract_conflict", "This scoped operation ID is already bound to a different contract.");
    }
    if (typeof row.result_json !== "string") throw new OperationError("invalid_receipt", "The stored operation has no completed result.");
    return { scope: request.scope, id: request.id, kind: request.kind, version: request.version,
      result: parseResult(row.result_json, parse, "invalid_receipt") };
  }
}
