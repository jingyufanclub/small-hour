import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { checkAbort } from "../deadline.js";
import type { SmallHourRuntime } from "../runtime.js";
import { RuntimeError, type StructuredTurnInput, type StructuredTurnResult, type TurnInput, type TurnReport, type TurnResult } from "../types.js";
import { canonicalJson } from "./json.js";
import { readReport, readResult, reportValue, resultJson, type SavedTurn } from "./model-step-record.js";
import type { OperationRequest, SqliteDatabase } from "./sqlite.js";

export type ModelStepState = { attemptId: string; report: TurnReport } & (
  | { status: "started" }
  | { status: "failed"; errorCode: string }
  | { status: "completed"; result: SavedTurn }
);
export interface ModelStepResult<Result> {
  attemptId: string;
  replayed: boolean;
  result: Result;
}
export interface ModelStepGuard { assertActive(): void }
export class ModelStepError extends Error {
  constructor(readonly code: "invalid_request" | "contract_conflict" | "step_unresolved" | "invalid_checkpoint" | "invalid_result" | "step_changed",
    message: string, options?: ErrorOptions & { state?: ModelStepState }) {
    super(message, options);
    this.name = "ModelStepError";
    this.state = options?.state;
  }
  readonly state?: ModelStepState;
}

function checkedRequest(request: OperationRequest) {
  try {
    const { scope, id, kind, version, input } = request;
    if ([scope, id, kind, version].some(value => typeof value !== "string" || !value.trim())) throw new TypeError("Missing step identity");
    return { scope, id, kind, version, inputJson: canonicalJson(input) };
  } catch (cause) {
    throw new ModelStepError("invalid_request", "The model step needs an identity and JSON input.", { cause });
  }
}
type CheckedRequest = ReturnType<typeof checkedRequest>;
type AnyInput = TurnInput | StructuredTurnInput<unknown>;

function definedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function turnContract(input: AnyInput): string {
  const { choice, structuredOutput } = input;
  return canonicalJson(definedFields({
    agentId: input.agentId, input: input.input, turnId: input.turnId, maxTokens: input.maxTokens,
    thinking: input.thinking ? { budgetTokens: input.thinking.budgetTokens } : undefined,
    allowedTools: input.allowedTools,
    choice: choice ? definedFields({ name: choice.name, description: choice.description,
      inputSchema: choice.inputSchema, strict: choice.strict, required: choice.required, requiredFirst: choice.requiredFirst }) : undefined,
    structuredOutput: structuredOutput ? { schema: structuredOutput.schema } : undefined,
  }));
}

function validatePreserved(parse: (value: unknown) => unknown, value: unknown): void {
  const parsed = parse(structuredClone(value));
  if (types.isPromise(parsed)) {
    void parsed.catch(() => {});
    throw new TypeError("Model-step validators must be synchronous");
  }
  if (canonicalJson(parsed) !== canonicalJson(value)) throw new TypeError("Validation changed the saved value");
}

function validateResult(json: string, input: AnyInput, code: "invalid_result" | "invalid_checkpoint"): SavedTurn {
  try {
    const result = readResult(JSON.parse(json));
    if (result.status === "structured") {
      if (!input.structuredOutput) throw new TypeError("Unexpected structured result");
      validatePreserved(input.structuredOutput.parse, result.value);
    } else {
      if (input.structuredOutput) throw new TypeError("Missing structured result");
      if (result.choice !== undefined && input.choice?.parse) {
        validatePreserved(input.choice.parse, result.choice);
      }
      if (input.choice && (input.choice.required ?? true) && result.choice === undefined) throw new TypeError("Missing required choice");
    }
    return result;
  } catch (cause) {
    throw new ModelStepError(code, "The model step result failed validation.", { cause });
  }
}

export class SqliteModelStepStore {
  constructor(private readonly database: SqliteDatabase) {}

  initialize(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS small_hour_model_steps (
      scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
      input_json TEXT NOT NULL, turn_json TEXT NOT NULL, attempt_id TEXT NOT NULL,
      status TEXT NOT NULL, report_json TEXT NOT NULL, result_json TEXT, error_code TEXT,
      format_version INTEGER NOT NULL, PRIMARY KEY (scope, id)
    )`);
  }

  inspect(request: OperationRequest): ModelStepState | undefined {
    const checked = checkedRequest(request);
    const row = this.row(checked);
    return row === undefined ? undefined : this.state(checked, row);
  }

  async run<T>(request: OperationRequest, runtime: SmallHourRuntime, input: StructuredTurnInput<T>, guard?: ModelStepGuard): Promise<ModelStepResult<StructuredTurnResult<T>>>;
  async run<T = unknown>(request: OperationRequest, runtime: SmallHourRuntime, input: TurnInput<T>, guard?: ModelStepGuard): Promise<ModelStepResult<TurnResult<T>>>;
  async run(request: OperationRequest, runtime: SmallHourRuntime, input: AnyInput, guard?: ModelStepGuard): Promise<ModelStepResult<SavedTurn>> {
    if (guard && (typeof guard.assertActive !== "function" || types.isAsyncFunction(guard.assertActive))) {
      throw new ModelStepError("invalid_request", "Model-step guards must be synchronous.");
    }
    const assertActive = () => {
      const value: unknown = guard?.assertActive();
      if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
        if (types.isPromise(value)) void value.catch(() => {});
        throw new ModelStepError("invalid_request", "Model-step guards must be synchronous.");
      }
    };
    if (input.signal) checkAbort(input.signal);
    if ([input.structuredOutput?.parse, input.choice?.parse].some(parse => types.isAsyncFunction(parse))) {
      throw new ModelStepError("invalid_request", "Model-step validators must be synchronous.");
    }
    const checked = checkedRequest(request);
    let contract: string;
    try { contract = turnContract(input); } catch (cause) {
      throw new ModelStepError("invalid_request", "The model step turn needs JSON configuration.", { cause });
    }
    const selected = JSON.parse(contract) as AnyInput;
    selected.signal = input.signal;
    if (input.choice) selected.choice = { ...selected.choice!, parse: input.choice.parse,
      authorizeWrite: input.choice.authorizeWrite, onChoice: input.choice.onChoice };
    if (input.structuredOutput) selected.structuredOutput = { ...selected.structuredOutput!, parse: input.structuredOutput.parse };
    const started = this.transaction(() => {
      const row = this.row(checked);
      if (row !== undefined) {
        const state = this.state(checked, row);
        if ((row as Record<string, unknown>).turn_json !== contract) {
          throw new ModelStepError("contract_conflict", "This step identity is already bound to a different turn contract.");
        }
        return { state, replayed: true };
      }
      assertActive();
      const attemptId = randomUUID();
      const report: TurnReport = { agentId: selected.agentId, turnId: selected.turnId ?? attemptId,
        hops: 0, toolCalls: [], modelCalls: [], usage: [] };
      readReport(report);
      const inserted = this.database.prepare(`INSERT INTO small_hour_model_steps
        (scope, id, kind, version, input_json, turn_json, attempt_id, status, report_json, format_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, 1)`)
        .run(checked.scope, checked.id, checked.kind, checked.version, checked.inputJson, contract, attemptId, canonicalJson(report));
      if (Number(inserted.changes) !== 1) throw new ModelStepError("step_changed", "The started model step was not recorded.");
      return { state: { attemptId, status: "started", report } as ModelStepState, replayed: false };
    });
    const { state, replayed } = started;
    if (replayed) {
      if (state.status !== "completed") throw new ModelStepError("step_unresolved",
        "This model step has no completed checkpoint; the application must reconcile it before starting new work.", { state });
      return { attemptId: state.attemptId, replayed: true, result: validateResult(resultJson(state.result), selected, "invalid_checkpoint") };
    }
    try {
      assertActive();
      const invoke = { ...selected, turnId: state.report.turnId };
      const observer = { checkpoint: (report: TurnReport) => {
        this.update(checked, state.attemptId, "started", report);
        assertActive();
      } };
      const result = invoke.structuredOutput
        ? await runtime.turn(invoke as StructuredTurnInput<unknown>, observer)
        : await runtime.turn(invoke as TurnInput, observer);
      const json = resultJson(result);
      const validated = validateResult(json, selected, "invalid_result");
      this.update(checked, state.attemptId, "completed", result, json);
      return { attemptId: state.attemptId, replayed: false, result: validated };
    } catch (cause) {
      try {
        const report = cause instanceof RuntimeError && cause.report ? cause.report : this.state(checked, this.row(checked)).report;
        this.update(checked, state.attemptId, "failed", report, null,
          cause instanceof RuntimeError || cause instanceof ModelStepError ? cause.code : "step_failed");
      } catch (failure) {
        throw new AggregateError([cause, failure], "The model step failed and its final state could not be saved.", { cause });
      }
      throw cause;
    }
  }

  private transaction<T>(work: () => T): T {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (cause) {
      try { db.exec("ROLLBACK"); } catch (rollbackError) {
        throw new AggregateError([cause, rollbackError], "The checkpoint failed and SQLite rollback could not be confirmed.", { cause });
      }
      throw cause;
    }
  }

  private update(request: CheckedRequest, attemptId: string, status: ModelStepState["status"], report: TurnReport,
    result: string | null = null, errorCode: string | null = null): void {
    const encoded = canonicalJson(reportValue(report));
    readReport(JSON.parse(encoded));
    this.transaction(() => {
      const changed = this.database.prepare(`UPDATE small_hour_model_steps
        SET status = ?, report_json = ?, result_json = ?, error_code = ?
        WHERE scope = ? AND id = ? AND attempt_id = ? AND status = 'started'`)
        .run(status, encoded, result, errorCode, request.scope, request.id, attemptId);
      if (Number(changed.changes) !== 1) throw new ModelStepError("step_changed", "The model step is no longer the active attempt.");
    });
  }

  private row(request: CheckedRequest): unknown {
    return this.database.prepare("SELECT * FROM small_hour_model_steps WHERE scope = ? AND id = ?").get(request.scope, request.id);
  }

  private state(request: CheckedRequest, value: unknown): ModelStepState {
    if (!value || typeof value !== "object") throw new ModelStepError("invalid_checkpoint", "The model step record is unavailable.");
    const row = value as Record<string, unknown>;
    if (typeof row.kind !== "string" || typeof row.version !== "string" || typeof row.input_json !== "string" || Number(row.format_version) !== 1) {
      throw new ModelStepError("invalid_checkpoint", "The model step format is unavailable or unsupported.");
    }
    if (row.kind !== request.kind || row.version !== request.version || row.input_json !== request.inputJson) {
      throw new ModelStepError("contract_conflict", "This step identity is already bound to a different workflow contract.");
    }
    try {
      if (typeof row.attempt_id !== "string" || !row.attempt_id || typeof row.report_json !== "string" || typeof row.turn_json !== "string") throw new TypeError("Missing step fields");
      const report = readReport(JSON.parse(row.report_json));
      const turn = JSON.parse(row.turn_json);
      if (report.agentId !== turn.agentId || report.turnId !== (turn.turnId ?? row.attempt_id)) throw new TypeError("Mismatched turn identity");
      const base = { attemptId: row.attempt_id, report };
      if (row.status === "completed") {
        if (typeof row.result_json !== "string" || row.error_code !== null) throw new TypeError("Missing completion");
        const result = readResult(JSON.parse(row.result_json));
        if (canonicalJson(reportValue(result)) !== canonicalJson(report)) throw new TypeError("Mismatched completion report");
        return { ...base, status: "completed", result };
      }
      if (row.result_json !== null) throw new TypeError("Unexpected result");
      if (row.status === "started" && row.error_code === null) return { ...base, status: "started" };
      if (row.status === "failed" && typeof row.error_code === "string" && row.error_code) return { ...base, status: "failed", errorCode: row.error_code };
      throw new TypeError("Invalid step state");
    } catch (cause) {
      throw new ModelStepError("invalid_checkpoint", "The saved model step failed validation.", { cause });
    }
  }
}
