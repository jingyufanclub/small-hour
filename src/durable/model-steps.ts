import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { checkAbort } from "../deadline.js";
import { readInputContent } from "../input.js";
import type { SmallHourRuntime } from "../runtime.js";
import { RuntimeError, type StructuredTurnInput, type StructuredTurnResult, type TurnInput, type TurnReport, type TurnResult } from "../types.js";
import { canonicalJson } from "./json.js";
import { readReport, readResult, reportValue, resultJson, type SavedTurn } from "./model-step-record.js";
import type { OperationRequest, SqliteDatabase } from "./sqlite.js";

export interface ModelRecoveryContract { sideEffectFree: true; maxAttempts: number; maxModelCalls: number }
export interface ModelStepRecoveryDecision { action: "retry"; checkpoint: string; reason: string; evidence: unknown }
export type ModelStepAttempt = { attemptId: string; report: TurnReport } & (
  | { status: "started" | "completed"; recovery?: never; errorCode?: never }
  | { status: "failed"; errorCode: string; recovery?: ModelStepRecoveryDecision }
  | { status: "superseded"; recovery: ModelStepRecoveryDecision; errorCode?: never }
);
type ArchivedAttempt = ModelStepAttempt & { recovery: ModelStepRecoveryDecision };
export type ModelStepState = { attemptId: string; report: TurnReport; checkpoint: string;
  attempts: ModelStepAttempt[]; recovery?: ModelRecoveryContract } & (
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
export interface ModelStepOptions { assertActive?(): void; recovery?: ModelRecoveryContract }
export class ModelStepError extends Error {
  constructor(readonly code: "invalid_request" | "contract_conflict" | "step_unresolved" | "invalid_checkpoint" | "invalid_result" | "step_changed"
    | "recovery_not_allowed" | "recovery_limit" | "stale_checkpoint",
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

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Expected a nonempty string");
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("Unexpected stored field");
}
export function readModelRecoveryContract(value: unknown): ModelRecoveryContract {
  const row = object(value);
  exact(row, ["sideEffectFree", "maxAttempts", "maxModelCalls"]);
  if (row.sideEffectFree !== true || ![row.maxAttempts, row.maxModelCalls].every(limit => Number.isSafeInteger(limit) && Number(limit) > 0)) {
    throw new TypeError("Recovery requires side-effect-free execution and positive integer limits");
  }
  return { sideEffectFree: true, maxAttempts: row.maxAttempts as number, maxModelCalls: row.maxModelCalls as number };
}
export function readModelStepRecoveryDecision(value: unknown): ModelStepRecoveryDecision {
  const row = object(value);
  exact(row, ["action", "checkpoint", "reason", "evidence"]);
  nonempty(row.reason);
  if (row.action !== "retry" || typeof row.checkpoint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.checkpoint) || !("evidence" in row)) {
    throw new TypeError("Recovery needs a retry decision and the inspected checkpoint");
  }
  return JSON.parse(canonicalJson(row)) as ModelStepRecoveryDecision;
}
function toolFree(input: AnyInput): void {
  if (input.choice !== undefined || (!input.structuredOutput && (!Array.isArray(input.allowedTools) || input.allowedTools.length !== 0))
    || (input.structuredOutput && input.allowedTools !== undefined)) throw new TypeError("Recovery requires a tool-free turn without a choice");
}
function activeGuard(options?: ModelStepOptions): () => void {
  const guard = options?.assertActive;
  if (guard !== undefined && (typeof guard !== "function" || types.isAsyncFunction(guard))) {
    throw new ModelStepError("invalid_request", "Model-step guards must be synchronous.");
  }
  return () => {
    const value: unknown = guard?.call(options);
    if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
      if (types.isPromise(value)) void value.catch(() => {});
      throw new ModelStepError("invalid_request", "Model-step guards must be synchronous.");
    }
  };
}
function prepare(input: AnyInput) {
  if (input.signal) checkAbort(input.signal);
  if ([input.structuredOutput?.parse, input.choice?.parse].some(parse => types.isAsyncFunction(parse))) {
    throw new ModelStepError("invalid_request", "Model-step validators must be synchronous.");
  }
  let contract: string;
  try { contract = turnContract(input); } catch (cause) {
    throw new ModelStepError("invalid_request", "The model step turn needs JSON configuration.", { cause });
  }
  const selected = JSON.parse(contract) as AnyInput;
  selected.signal = input.signal;
  if (input.choice) selected.choice = { ...selected.choice!, parse: input.choice.parse,
    authorizeWrite: input.choice.authorizeWrite, onChoice: input.choice.onChoice };
  if (input.structuredOutput) selected.structuredOutput = { ...selected.structuredOutput!, parse: input.structuredOutput.parse };
  return { contract, selected };
}

function definedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function turnContract(input: AnyInput): string {
  const { choice, structuredOutput } = input;
  return canonicalJson(definedFields({
    agentId: input.agentId, input: readInputContent(input.input), turnId: input.turnId, maxTokens: input.maxTokens,
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

function callCount(attempts: readonly { report: TurnReport }[]): number {
  return attempts.reduce((count, attempt) => count + attempt.report.modelCalls.length, 0);
}
function recoveryReport(value: unknown, agentId: string, turnId: string): TurnReport {
  const report = readReport(value);
  if (report.agentId !== agentId || report.turnId !== turnId || report.choice !== undefined
    || report.toolCalls.some(call => call.status !== "not_started")) throw new TypeError("Recovery report contains incompatible work");
  return report;
}
function preservedReport(previous: TurnReport, next: TurnReport): TurnReport {
  const merged = structuredClone(next);
  if (previous.agentId !== next.agentId || previous.turnId !== next.turnId || previous.modelCalls.length > next.modelCalls.length
    || previous.toolCalls.length > next.toolCalls.length) throw new TypeError("Attempt progress lost previously saved work");
  for (const [index, old] of previous.modelCalls.entries()) {
    const current = merged.modelCalls[index];
    if (old.callId !== current.callId || old.provider !== current.provider || old.attempt !== current.attempt || old.hop !== current.hop) {
      throw new TypeError("Attempt progress changed a provider call identity");
    }
    if (old.status === "responded" && current.status !== "responded") merged.modelCalls[index] = old;
    else {
      if (old.usage && !current.usage) current.usage = old.usage;
      if (old.requestId && !current.requestId) current.requestId = old.requestId;
      if (old.status === "responded" && current.status === "responded" && old.stop && !current.stop) current.stop = old.stop;
      if (old.accounting === "recorded") current.accounting = "recorded";
    }
  }
  if (previous.usage.length > merged.usage.length) merged.usage = structuredClone(previous.usage);
  merged.hops = Math.max(previous.hops, merged.hops);
  return merged;
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
    return row === undefined ? undefined : this.load(checked, row).state;
  }

  async run<T>(request: OperationRequest, runtime: SmallHourRuntime, input: StructuredTurnInput<T>, options?: ModelStepOptions): Promise<ModelStepResult<StructuredTurnResult<T>>>;
  async run<T = unknown>(request: OperationRequest, runtime: SmallHourRuntime, input: TurnInput<T>, options?: ModelStepOptions): Promise<ModelStepResult<TurnResult<T>>>;
  async run(request: OperationRequest, runtime: SmallHourRuntime, input: AnyInput, options?: ModelStepOptions): Promise<ModelStepResult<SavedTurn>> {
    const assertActive = activeGuard(options), { contract, selected } = prepare(input);
    let recovery: ModelRecoveryContract | undefined;
    try {
      if (options?.recovery !== undefined) { recovery = readModelRecoveryContract(options.recovery); toolFree(selected); }
    } catch (cause) { throw new ModelStepError("invalid_request", "The recovery contract requires bounded, side-effect-free model work.", { cause }); }
    const checked = checkedRequest(request);
    const started = this.transaction(() => {
      const row = this.row(checked);
      if (row !== undefined) {
        const saved = this.load(checked, row);
        if (saved.turnJson !== contract || canonicalJson(saved.state.recovery ?? null) !== canonicalJson(recovery ?? null)) {
          throw new ModelStepError("contract_conflict", "This step identity is already bound to a different turn contract.");
        }
        return { state: saved.state, replayed: true };
      }
      assertActive();
      const attemptId = randomUUID(), turnId = selected.turnId ?? attemptId;
      const report: TurnReport = { agentId: selected.agentId, turnId, hops: 0, toolCalls: [], modelCalls: [], usage: [] };
      readReport(report);
      const storedTurn = recovery ? canonicalJson({ turn: JSON.parse(contract), recovery, turnId }) : contract;
      const storedReport = recovery ? canonicalJson({ report, attempts: [] }) : canonicalJson(report);
      const inserted = this.database.prepare(`INSERT INTO small_hour_model_steps
        (scope, id, kind, version, input_json, turn_json, attempt_id, status, report_json, format_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`)
        .run(checked.scope, checked.id, checked.kind, checked.version, checked.inputJson, storedTurn, attemptId, storedReport, recovery ? 2 : 1);
      if (Number(inserted.changes) !== 1) throw new ModelStepError("step_changed", "The started model step was not recorded.");
      return { state: this.load(checked, this.row(checked)).state, replayed: false };
    });
    if (started.replayed) return this.replay(started.state, selected);
    return this.execute(checked, runtime, selected, started.state, assertActive);
  }

  async recover<T>(request: OperationRequest, runtime: SmallHourRuntime, input: StructuredTurnInput<T>, decision: ModelStepRecoveryDecision, guard?: ModelStepGuard): Promise<ModelStepResult<StructuredTurnResult<T>>>;
  async recover<T = unknown>(request: OperationRequest, runtime: SmallHourRuntime, input: TurnInput<T>, decision: ModelStepRecoveryDecision, guard?: ModelStepGuard): Promise<ModelStepResult<TurnResult<T>>>;
  async recover(request: OperationRequest, runtime: SmallHourRuntime, input: AnyInput, decision: ModelStepRecoveryDecision, guard?: ModelStepGuard): Promise<ModelStepResult<SavedTurn>> {
    const assertActive = activeGuard(guard), { contract, selected } = prepare(input), checked = checkedRequest(request);
    let approved: ModelStepRecoveryDecision;
    try { approved = readModelStepRecoveryDecision(decision); }
    catch (cause) { throw new ModelStepError("invalid_request", "Recovery needs an explicit decision with JSON evidence.", { cause }); }
    const started = this.transaction(() => {
      const saved = this.load(checked, this.row(checked)), { state } = saved;
      if (saved.turnJson !== contract) throw new ModelStepError("contract_conflict", "Recovery cannot change the saved turn contract.");
      if (state.checkpoint !== approved.checkpoint) throw new ModelStepError("stale_checkpoint", "The inspected model step has changed.", { state });
      if (state.status === "completed") return { state, replayed: true };
      if (!state.recovery) throw new ModelStepError("recovery_not_allowed", "This model step did not opt into recovery before execution.", { state });
      if (state.attempts.length >= state.recovery.maxAttempts || callCount(state.attempts) >= state.recovery.maxModelCalls) {
        throw new ModelStepError("recovery_limit", "The model step has exhausted its recovery allowance.", { state });
      }
      assertActive();
      const archived: ArchivedAttempt = state.status === "failed"
        ? { attemptId: state.attemptId, status: "failed", errorCode: state.errorCode, report: state.report, recovery: approved }
        : { attemptId: state.attemptId, status: "superseded", report: state.report, recovery: approved };
      const attemptId = randomUUID();
      const report: TurnReport = { agentId: state.report.agentId, turnId: state.report.turnId, hops: 0, toolCalls: [], modelCalls: [], usage: [] };
      const changed = this.database.prepare(`UPDATE small_hour_model_steps
        SET attempt_id = ?, status = 'started', report_json = ?, result_json = NULL, error_code = NULL
        WHERE scope = ? AND id = ? AND attempt_id = ? AND status <> 'completed'`)
        .run(attemptId, canonicalJson({ report, attempts: [...saved.archived, archived] }), checked.scope, checked.id, state.attemptId);
      if (Number(changed.changes) !== 1) throw new ModelStepError("step_changed", "The recovery attempt was not recorded.");
      return { state: this.load(checked, this.row(checked)).state, replayed: false };
    });
    if (started.replayed) return this.replay(started.state, selected);
    return this.execute(checked, runtime, selected, started.state, assertActive);
  }

  private replay(state: ModelStepState, input: AnyInput): ModelStepResult<SavedTurn> {
    if (state.status !== "completed") throw new ModelStepError("step_unresolved",
      "This model step has no completed checkpoint; the application must reconcile it before starting new work.", { state });
    return { attemptId: state.attemptId, replayed: true, result: validateResult(resultJson(state.result), input, "invalid_checkpoint") };
  }

  private async execute(checked: CheckedRequest, runtime: SmallHourRuntime, selected: AnyInput, state: ModelStepState,
    assertActive: () => void): Promise<ModelStepResult<SavedTurn>> {
    let lastReport = state.report;
    try {
      assertActive();
      const invoke = { ...selected, turnId: state.report.turnId };
      const observer = { checkpoint: (report: TurnReport) => {
        lastReport = structuredClone(report);
        this.update(checked, state.attemptId, "started", report);
        assertActive();
      } };
      const result = invoke.structuredOutput
        ? await runtime.turn(invoke as StructuredTurnInput<unknown>, observer)
        : await runtime.turn(invoke as TurnInput, observer);
      lastReport = result;
      const json = resultJson(result), validated = validateResult(json, selected, "invalid_result");
      this.update(checked, state.attemptId, "completed", result, json, null, assertActive);
      return { attemptId: state.attemptId, replayed: false, result: validated };
    } catch (cause) {
      const failure = cause instanceof RuntimeError && cause.cause instanceof ModelStepError ? cause.cause : cause;
      try {
        const report = cause instanceof RuntimeError && cause.report ? cause.report : lastReport;
        this.update(checked, state.attemptId, "failed", report, null,
          failure instanceof RuntimeError || failure instanceof ModelStepError ? failure.code : "step_failed");
      } catch (saveFailure) {
        if (saveFailure instanceof ModelStepError && saveFailure.code === "step_changed") throw saveFailure;
        throw new AggregateError([cause, saveFailure], "The model step failed and its final state could not be saved.", { cause });
      }
      throw failure;
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
    result: string | null = null, errorCode: string | null = null, assertActive?: () => void): void {
    const incoming = readReport(JSON.parse(canonicalJson(reportValue(report))));
    const outcome = this.transaction(() => {
      const saved = this.load(request, this.row(request)), { state } = saved;
      if (saved.format === 2) recoveryReport(incoming, state.report.agentId, state.report.turnId);
      if (state.attemptId !== attemptId) {
        const archived = saved.archived.find(attempt => attempt.attemptId === attemptId);
        if (!archived) return "changed";
        archived.report = preservedReport(archived.report, incoming);
        const changed = this.database.prepare(`UPDATE small_hour_model_steps SET report_json = ?
          WHERE scope = ? AND id = ? AND attempt_id = ?`)
          .run(canonicalJson({ report: state.report, attempts: saved.archived }), request.scope, request.id, state.attemptId);
        if (Number(changed.changes) !== 1) throw new ModelStepError("step_changed", "The superseded attempt's evidence could not be saved.");
        return "changed";
      }
      if (state.status !== "started") return "changed";
      if (incoming.agentId !== state.report.agentId || incoming.turnId !== state.report.turnId) throw new TypeError("Attempt identity changed");
      const encoded = canonicalJson(saved.format === 2 ? { report: incoming, attempts: saved.archived } : incoming);
      assertActive?.();
      const changed = this.database.prepare(`UPDATE small_hour_model_steps
        SET status = ?, report_json = ?, result_json = ?, error_code = ?
        WHERE scope = ? AND id = ? AND attempt_id = ? AND status = 'started'`)
        .run(status, encoded, result, errorCode, request.scope, request.id, attemptId);
      if (Number(changed.changes) !== 1) throw new ModelStepError("step_changed", "The model step is no longer the active attempt.");
      return status === "started" && state.recovery && callCount([...saved.archived, { report: incoming }]) > state.recovery.maxModelCalls ? "limit" : "saved";
    });
    if (outcome === "changed") throw new ModelStepError("step_changed", "The model step is no longer the active attempt.");
    if (outcome === "limit") throw new ModelStepError("recovery_limit", "The model step has exhausted its cumulative call allowance.");
  }

  private row(request: CheckedRequest): unknown {
    return this.database.prepare("SELECT * FROM small_hour_model_steps WHERE scope = ? AND id = ?").get(request.scope, request.id);
  }

  private load(request: CheckedRequest, value: unknown): { state: ModelStepState; turnJson: string; archived: ArchivedAttempt[]; format: number } {
    if (!value || typeof value !== "object") throw new ModelStepError("invalid_checkpoint", "The model step record is unavailable.");
    const row = value as Record<string, unknown>;
    const format = Number(row.format_version);
    if (typeof row.kind !== "string" || typeof row.version !== "string" || typeof row.input_json !== "string"
      || (format !== 1 && format !== 2)) {
      throw new ModelStepError("invalid_checkpoint", "The model step format is unavailable or unsupported.");
    }
    if (row.kind !== request.kind || row.version !== request.version || row.input_json !== request.inputJson) {
      throw new ModelStepError("contract_conflict", "This step identity is already bound to a different workflow contract.");
    }
    try {
      nonempty(row.attempt_id);
      if (typeof row.report_json !== "string" || typeof row.turn_json !== "string") throw new TypeError("Missing step fields");
      const storedTurn = object(JSON.parse(row.turn_json)), storedReport = JSON.parse(row.report_json);
      let turn = storedTurn, report: TurnReport, recovery: ModelRecoveryContract | undefined, turnId: string;
      const archived: ArchivedAttempt[] = [];
      if (format === 2) {
        exact(storedTurn, ["turn", "recovery", "turnId"]);
        turn = object(storedTurn.turn); nonempty(storedTurn.turnId); turnId = storedTurn.turnId;
        recovery = readModelRecoveryContract(storedTurn.recovery);
        toolFree(turn as unknown as AnyInput);
        if (turn.turnId !== undefined && turn.turnId !== turnId) throw new TypeError("Changed logical turn identity");
        const envelope = object(storedReport); exact(envelope, ["report", "attempts"]);
        if (!Array.isArray(envelope.attempts) || envelope.attempts.length >= recovery.maxAttempts) throw new TypeError("Invalid attempt history");
        nonempty(turn.agentId);
        for (const value of envelope.attempts) {
          const attempt = object(value); exact(attempt, ["attemptId", "report", "status", "errorCode", "recovery"]);
          nonempty(attempt.attemptId);
          const base = { attemptId: attempt.attemptId, report: recoveryReport(attempt.report, turn.agentId, turnId), recovery: readModelStepRecoveryDecision(attempt.recovery) };
          if (attempt.status === "failed") { nonempty(attempt.errorCode); archived.push({ ...base, status: "failed", errorCode: attempt.errorCode }); }
          else if (attempt.status === "superseded" && attempt.errorCode === undefined) archived.push({ ...base, status: "superseded" });
          else throw new TypeError("Invalid archived attempt");
        }
        report = recoveryReport(envelope.report, turn.agentId, turnId);
      } else {
        report = readReport(storedReport);
        turnId = typeof turn.turnId === "string" ? turn.turnId : row.attempt_id;
      }
      if (report.agentId !== turn.agentId || report.turnId !== turnId) throw new TypeError("Mismatched turn identity");
      readInputContent(turn.input);
      let current: ModelStepAttempt, result: SavedTurn | undefined;
      if (row.status === "completed") {
        if (typeof row.result_json !== "string" || row.error_code !== null) throw new TypeError("Missing completion");
        result = readResult(JSON.parse(row.result_json));
        if (canonicalJson(reportValue(result)) !== canonicalJson(report)) throw new TypeError("Mismatched completion report");
        current = { attemptId: row.attempt_id, report, status: "completed" };
      } else {
        if (row.result_json !== null) throw new TypeError("Unexpected result");
        if (row.status === "started" && row.error_code === null) current = { attemptId: row.attempt_id, report, status: "started" };
        else if (row.status === "failed") { nonempty(row.error_code); current = { attemptId: row.attempt_id, report, status: "failed", errorCode: row.error_code }; }
        else throw new TypeError("Invalid step state");
      }
      const attempts = [...archived, current], attemptIds = new Set<string>(), callIds = new Set<string>();
      for (const attempt of attempts) {
        if (attemptIds.has(attempt.attemptId)) throw new TypeError("Repeated model attempt identity");
        attemptIds.add(attempt.attemptId);
        for (const call of attempt.report.modelCalls) {
          if (callIds.has(call.callId)) throw new TypeError("Repeated model call identity");
          callIds.add(call.callId);
        }
      }
      const checkpoint = "sha256:" + createHash("sha256").update(canonicalJson({ scope: request.scope, id: request.id,
        kind: row.kind, version: row.version, input: JSON.parse(request.inputJson), turn: storedTurn,
        format, attempt: current, archived, result: result ?? null })).digest("hex");
      const base = { attemptId: row.attempt_id, report, checkpoint, attempts, ...(recovery ? { recovery } : {}) };
      const state: ModelStepState = current.status === "completed" ? { ...base, status: "completed", result: result! }
        : current.status === "failed" ? { ...base, status: "failed", errorCode: current.errorCode } : { ...base, status: "started" };
      return { state, turnJson: canonicalJson(turn), archived, format };
    } catch (cause) {
      throw new ModelStepError("invalid_checkpoint", "The saved model step failed validation.", { cause });
    }
  }
}
