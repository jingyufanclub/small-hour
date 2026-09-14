import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { SmallHourRuntime } from "../runtime.js";
import type { StructuredTurnInput, TurnInput } from "../types.js";
import { canonicalJson } from "./json.js";
import { SqliteModelStepStore, type ModelStepState } from "./model-steps.js";
import { SqliteOperationStore, type OperationRequest, type SqliteDatabase } from "./sqlite.js";

export type TaskStatus = "queued" | "running" | "deferred" | "completed" | "cancelled" | "rejected" | "failed" | "uncertain";
export interface TaskSchedule { concurrencyScope: string; dueAt: number; maxAttempts: number }
export type TaskPermission = { status: "allow" } | { status: "rejected"; reason: string }
  | { status: "deferred"; reason: string; dueAt: number };
export interface TaskContext {
  task: OperationRequest;
  stepId: string;
  results: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  assertActive(): void;
}
export type TaskStep<Database> = { id: string } & (
  | { kind: "local"; execute(database: Database, context: TaskContext): unknown; parseResult(value: unknown): unknown }
  | { kind: "model"; prepare(context: TaskContext): { runtime: SmallHourRuntime; input: TurnInput | StructuredTurnInput<unknown> } }
);
export interface TaskWorkflow<Database> {
  kind: string;
  version: string;
  steps: readonly TaskStep<Database>[];
  authorize(context: TaskContext): TaskPermission;
  retry?(error: unknown, context: TaskContext): { dueAt: number; reason: string } | undefined;
}
export interface TaskResolution { status: "failed" | "cancelled"; reason: string; evidence: unknown }
type CompletedModelStep = Extract<ModelStepState, { status: "completed" }>;
export type TaskStepState = {
  id: string;
  request: OperationRequest;
} & (
  | { kind: "local"; model?: never } & ({ status: "not_started"; result?: never } | { status: "completed"; result: unknown })
  | { kind: "model" } & (
    | { status: "not_started"; model?: never; result?: never }
    | { status: "unresolved"; model: Exclude<ModelStepState, CompletedModelStep>; result?: never }
    | { status: "completed"; model: CompletedModelStep; result: CompletedModelStep["result"] }
  )
);
export interface TaskState extends OperationRequest, TaskSchedule {
  status: TaskStatus;
  attempts: number;
  reason: string | null;
  cancellationReason: string | null;
  leaseUntil: number | null;
  resolution: TaskResolution | null;
  steps: TaskStepState[];
}
export interface TaskRunResult extends TaskState { error?: unknown }
export class TaskError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_task" | "contract_conflict" | "claim_lost" | "task_changed" | "rollback_failed",
    message: string, options?: ErrorOptions) {
    super(message, options); this.name = "TaskError";
  }
}
type Stop = { status: "cancelled" | "rejected" | "deferred"; reason: string; dueAt?: number };
class TaskStopped extends Error { constructor(readonly outcome: Stop) { super(outcome.reason); } }
type Plan = { id: string; kind: "local" | "model" }[];
type StoredTask = Omit<TaskState, "steps"> & { plan: Plan; token: string | null; scheduleJson: string };
type Key = Pick<OperationRequest, "scope" | "id">;

function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Expected a nonempty string");
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError("Expected a bounded nonnegative integer");
}
function sync<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    if (types.isPromise(value)) void value.catch(() => {});
    throw new TypeError("Task definitions and policies must be synchronous");
  }
  return value;
}
function schedule(value: TaskSchedule): TaskSchedule {
  nonempty(value.concurrencyScope); integer(value.dueAt); integer(value.maxAttempts, 1);
  return { concurrencyScope: value.concurrencyScope, dueAt: value.dueAt, maxAttempts: value.maxAttempts };
}
function plan(steps: readonly { id: string; kind: string }[]): Plan {
  if (!Array.isArray(steps) || !steps.length) throw new TypeError("A workflow requires ordered steps");
  const ids = new Set<string>();
  return steps.map(step => {
    nonempty(step.id);
    if (ids.has(step.id) || (step.kind !== "local" && step.kind !== "model")) throw new TypeError("Invalid or repeated step");
    ids.add(step.id); return { id: step.id, kind: step.kind };
  });
}
function identity(task: OperationRequest): OperationRequest {
  for (const field of [task.scope, task.id, task.kind, task.version]) nonempty(field);
  return { scope: task.scope, id: task.id, kind: task.kind, version: task.version, input: JSON.parse(canonicalJson(task.input)) };
}
function operation(task: StoredTask, step: Plan[number]): OperationRequest {
  return { scope: canonicalJson(["small-hour-task", task.scope, task.id]), id: step.id,
    kind: task.kind, version: task.version, input: { input: task.input, steps: task.plan } };
}

export class SqliteTaskRunner<Database extends SqliteDatabase> {
  private readonly workflows: TaskWorkflow<Database>[];
  private readonly operations: SqliteOperationStore<Database>;
  private readonly models: SqliteModelStepStore;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(private readonly database: Database, workflows: readonly TaskWorkflow<Database>[], options: { leaseMs: number; now?: () => number }) {
    integer(options.leaseMs, 1);
    this.leaseMs = options.leaseMs; this.now = options.now ?? Date.now;
    const keys = new Set<string>();
    this.workflows = workflows.map(workflow => {
      nonempty(workflow.kind); nonempty(workflow.version); plan(workflow.steps);
      const key = canonicalJson([workflow.kind, workflow.version]);
      if (keys.has(key)) throw new TypeError("Repeated workflow version");
      keys.add(key);
      const callbacks = [workflow.authorize, ...(workflow.retry ? [workflow.retry] : []),
        ...workflow.steps.flatMap<unknown>(step => step.kind === "local" ? [step.execute, step.parseResult] : [step.prepare])];
      if (callbacks.some(callback => typeof callback !== "function" || types.isAsyncFunction(callback))) throw new TypeError("Task definitions require synchronous callbacks");
      return { ...workflow, steps: workflow.steps.map(step => ({ ...step })) };
    });
    this.operations = new SqliteOperationStore(database); this.models = new SqliteModelStepStore(database);
  }

  initialize(): void {
    this.operations.initialize(); this.models.initialize();
    this.database.exec(`CREATE TABLE IF NOT EXISTS small_hour_tasks (
      scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
      input_json TEXT NOT NULL, plan_json TEXT NOT NULL, schedule_json TEXT NOT NULL,
      concurrency_scope TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL,
      status TEXT NOT NULL, token TEXT, lease_until INTEGER, reason TEXT, cancellation_reason TEXT,
      resolution_json TEXT, format_version INTEGER NOT NULL, PRIMARY KEY (scope, id)
    );
    CREATE INDEX IF NOT EXISTS small_hour_tasks_due ON small_hour_tasks (kind, version, status, due_at);
    CREATE INDEX IF NOT EXISTS small_hour_tasks_scope ON small_hour_tasks (concurrency_scope, status)`);
  }

  enqueue(request: OperationRequest, timing: TaskSchedule): TaskState {
    let selected: OperationRequest, selectedSchedule: TaskSchedule;
    try { selected = identity(request); selectedSchedule = schedule(timing); }
    catch (cause) { throw new TaskError("invalid_request", "Tasks require a scoped versioned identity, JSON input and a bounded schedule.", { cause }); }
    const workflow = this.definition(selected);
    const expectedPlan = canonicalJson(plan(workflow.steps)), expectedSchedule = canonicalJson(selectedSchedule);
    this.transaction(() => {
      const existing = this.read(selected);
      if (existing) {
        if (canonicalJson(identity(existing)) !== canonicalJson(selected) || canonicalJson(existing.plan) !== expectedPlan || existing.scheduleJson !== expectedSchedule) {
          throw new TaskError("contract_conflict", "This task identity is already bound to a different contract.");
        }
        return;
      }
      this.changed(this.database.prepare(`INSERT INTO small_hour_tasks
        (scope, id, kind, version, input_json, plan_json, schedule_json, concurrency_scope, due_at, attempts, status, format_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', 1)`)
        .run(selected.scope, selected.id, selected.kind, selected.version, canonicalJson(selected.input), expectedPlan, expectedSchedule,
          selectedSchedule.concurrencyScope, selectedSchedule.dueAt));
    });
    return this.inspect(selected)!;
  }

  inspect(key: Key): TaskState | undefined {
    this.database.exec("SAVEPOINT small_hour_task_inspect");
    try { return this.snapshot(key); }
    finally { this.database.exec("RELEASE SAVEPOINT small_hour_task_inspect"); }
  }

  private snapshot(key: Key): TaskState | undefined {
    const task = this.read(key);
    if (!task) return undefined;
    const { plan, token: _token, scheduleJson: _schedule, ...state } = task;
    const steps: TaskStepState[] = plan.map(step => {
      const request = operation(task, step);
      if (step.kind === "local") {
        const receipt = this.operations.find(request, value => value);
        return receipt ? { id: step.id, kind: "local", request, status: "completed", result: receipt.result }
          : { id: step.id, kind: "local", request, status: "not_started" };
      }
      const model = this.models.inspect(request);
      if (!model) return { id: step.id, kind: "model", request, status: "not_started" };
      return model.status === "completed" ? { id: step.id, kind: "model", request, status: "completed", model, result: model.result }
        : { id: step.id, kind: "model", request, status: "unresolved", model };
    });
    let unfinished = false;
    for (const step of steps) {
      if (unfinished && step.status !== "not_started") throw new TaskError("invalid_task", "Stored steps are out of order.");
      if (step.status !== "completed" || (step.model?.status === "completed" && step.model.result.status === "rejected")) unfinished = true;
    }
    if (state.status === "completed" && unfinished) throw new TaskError("invalid_task", "Completed tasks require every step to have an accepted result.");
    return { ...state, steps };
  }

  cancel(key: Key, reason: string): TaskState {
    nonempty(reason);
    this.transaction(() => {
      const task = this.required(key);
      if (!["queued", "deferred", "running"].includes(task.status)) return;
      this.changed(this.database.prepare(`UPDATE small_hour_tasks SET cancellation_reason = ?,
        status = CASE WHEN status = 'running' THEN status ELSE 'cancelled' END,
        reason = CASE WHEN status = 'running' THEN reason ELSE ? END WHERE scope = ? AND id = ?`)
        .run(task.cancellationReason ?? reason, task.cancellationReason ?? reason, key.scope, key.id));
    });
    return this.inspect(key)!;
  }

  resolve(key: Key, resolution: TaskResolution): TaskState {
    nonempty(resolution.reason);
    if (!["failed", "cancelled"].includes(resolution.status) || resolution.evidence == null) throw new TaskError("invalid_request", "Resolution requires a terminal outcome and verified evidence.");
    const json = canonicalJson({ status: resolution.status, reason: resolution.reason, evidence: resolution.evidence });
    this.transaction(() => {
      const task = this.required(key);
      if (task.resolution && canonicalJson(task.resolution) === json) return;
      if (task.status !== "uncertain") throw new TaskError("task_changed", "Only uncertain tasks accept a resolution.");
      this.changed(this.database.prepare(`UPDATE small_hour_tasks SET status = ?, reason = ?, resolution_json = ? WHERE scope = ? AND id = ?`)
        .run(resolution.status, resolution.reason, json, key.scope, key.id));
    });
    return this.inspect(key)!;
  }

  async runNext(options: { signal?: AbortSignal } = {}): Promise<TaskRunResult | undefined> {
    if (options.signal?.aborted) return undefined;
    const claimed = this.claim();
    if (!claimed) return undefined;
    if (claimed.status !== "running") return this.inspect(claimed);
    if (this.inspect(claimed)!.steps.some(step => step.status === "unresolved")) {
      return this.finish(claimed, "uncertain", "model_step_unresolved");
    }
    const workflow = this.definition(claimed);
    const results = new Map<string, unknown>();
    let stepId = workflow.steps[0].id, stopped: TaskStopped | undefined;
    const context = (): TaskContext => ({ task: identity(claimed), stepId,
      results: structuredClone(Object.fromEntries(results)), signal: options.signal, assertActive });
    const assertActive = () => {
      try {
        this.active(claimed);
        if (options.signal?.aborted) throw new TaskStopped({ status: "deferred", dueAt: this.time(), reason: "worker_aborted" });
        const permission = sync(workflow.authorize(context()));
        if (permission.status !== "allow") {
          if (permission.status !== "deferred" && permission.status !== "rejected") throw new TypeError("Invalid task permission");
          nonempty(permission.reason);
          if (permission.status === "deferred") integer(permission.dueAt);
          throw new TaskStopped(permission);
        }
        this.active(claimed);
      } catch (error) { if (error instanceof TaskStopped) stopped = error; throw error; }
    };
    for (const step of workflow.steps) {
      stepId = step.id;
      const request = operation(claimed, step);
      let localAttempt = false;
      try {
        this.active(claimed);
        let result: unknown;
        if (step.kind === "local") {
          const existing = this.operations.find(request, step.parseResult);
          if (existing) { results.set(step.id, existing.result); this.renew(claimed); continue; }
          localAttempt = true;
          result = this.transaction(() => {
            assertActive();
            const saved = this.operations.commit(request, { execute: db => sync(step.execute(db, context())), parseResult: step.parseResult });
            assertActive();
            return saved.receipt.result;
          });
          localAttempt = false;
        } else {
          const existing = this.models.inspect(request);
          if (!existing) assertActive();
          const prepared = sync(step.prepare(context()));
          const signal = options.signal && prepared.input.signal ? AbortSignal.any([options.signal, prepared.input.signal]) : options.signal ?? prepared.input.signal;
          const input = { ...prepared.input, signal };
          const guard = { assertActive };
          const saved = input.structuredOutput
            ? await this.models.run(request, prepared.runtime, input as StructuredTurnInput<unknown>, guard)
            : await this.models.run(request, prepared.runtime, input as TurnInput, guard);
          result = saved.result;
          if (saved.result.status === "rejected") return this.finish(claimed, "rejected", "model_output_rejected");
        }
        results.set(step.id, result);
        this.renew(claimed);
      } catch (error) {
        if (error instanceof TaskError && error.code === "rollback_failed") throw error;
        this.fenced(claimed);
        if (error instanceof TaskStopped) stopped = error;
        const model = step.kind === "model" ? this.models.inspect(request) : undefined;
        const unknown = model && (model.status === "started" || model.report.modelCalls.some(call => call.status === "unknown")
          || model.report.toolCalls.some(call => call.status === "unknown"));
        if (unknown || (model && model.status !== "completed" && (!stopped || stopped.outcome.status === "deferred"))) {
          return { ...this.finish(claimed, "uncertain", "model_step_unresolved"), error };
        }
        if (stopped) return this.finish(claimed, stopped.outcome.status, stopped.outcome.reason, stopped.outcome.dueAt);
        if (localAttempt && workflow.retry && claimed.attempts < claimed.maxAttempts) {
          const retry = sync(workflow.retry(error, context()));
          if (retry) { integer(retry.dueAt); nonempty(retry.reason); return { ...this.finish(claimed, "deferred", retry.reason, retry.dueAt), error }; }
        }
        if (!localAttempt) throw error;
        return { ...this.finish(claimed, "failed", claimed.attempts >= claimed.maxAttempts ? "attempt_limit" : "step_failed"), error };
      }
    }
    return this.finish(claimed, "completed", null);
  }

  private claim(): StoredTask | undefined {
    if (!this.workflows.length) return undefined;
    return this.transaction(() => {
      const now = this.time();
      const supported = this.workflows.map(() => "(t.kind = ? AND t.version = ?)").join(" OR ");
      const candidate = this.database.prepare(`SELECT t.scope, t.id FROM small_hour_tasks t
        WHERE (${supported}) AND ((t.status IN ('queued', 'deferred') AND t.due_at <= ?) OR (t.status = 'running' AND t.lease_until <= ?))
        AND NOT EXISTS (SELECT 1 FROM small_hour_tasks other WHERE other.concurrency_scope = t.concurrency_scope
          AND (other.scope != t.scope OR other.id != t.id) AND other.status IN ('running', 'uncertain'))
        ORDER BY t.due_at, t.scope, t.id LIMIT 1`)
        .get(...this.workflows.flatMap(workflow => [workflow.kind, workflow.version]), now, now) as Key | undefined;
      if (!candidate) return undefined;
      const task = this.required(candidate);
      this.snapshot(task);
      const workflow = this.definition(task);
      if (canonicalJson(plan(workflow.steps)) !== canonicalJson(task.plan)) throw new TaskError("contract_conflict", "The stored task requires its original step manifest.");
      if (task.attempts >= task.maxAttempts) {
        this.changed(this.database.prepare(`UPDATE small_hour_tasks SET status = ?, reason = 'attempt_limit', token = NULL, lease_until = NULL WHERE scope = ? AND id = ?`)
          .run(task.status === "running" ? "uncertain" : "failed", task.scope, task.id));
      } else {
        const expires = now + this.leaseMs; integer(expires);
        this.changed(this.database.prepare(`UPDATE small_hour_tasks SET status = 'running', token = ?, lease_until = ?, attempts = attempts + 1, reason = NULL WHERE scope = ? AND id = ?`)
          .run(randomUUID(), expires, task.scope, task.id));
      }
      return this.required(task);
    });
  }

  private active(task: StoredTask): void {
    const current = this.fenced(task);
    if (current.cancellationReason) throw new TaskStopped({ status: "cancelled", reason: current.cancellationReason });
  }
  private fenced(task: StoredTask): StoredTask {
    const current = this.required(task);
    if (current.status !== "running" || current.token !== task.token || current.leaseUntil! <= this.time()) {
      throw new TaskError("claim_lost", "This worker no longer owns the task.");
    }
    return current;
  }
  private renew(task: StoredTask): void {
    this.transaction(() => {
      this.fenced(task);
      const expires = this.time() + this.leaseMs; integer(expires);
      this.changed(this.database.prepare("UPDATE small_hour_tasks SET lease_until = ? WHERE scope = ? AND id = ? AND token = ?")
        .run(expires, task.scope, task.id, task.token));
    });
  }
  private finish(task: StoredTask, status: Exclude<TaskStatus, "queued" | "running">, reason: string | null, dueAt = task.dueAt): TaskState {
    this.transaction(() => {
      const current = this.fenced(task);
      if (current.cancellationReason && status !== "uncertain") { status = "cancelled"; reason = current.cancellationReason; }
      this.changed(this.database.prepare(`UPDATE small_hour_tasks SET status = ?, reason = ?, due_at = ?, token = NULL, lease_until = NULL WHERE scope = ? AND id = ? AND token = ?`)
        .run(status, reason, dueAt, task.scope, task.id, task.token));
    });
    return this.inspect(task)!;
  }
  private definition(task: Pick<OperationRequest, "kind" | "version">): TaskWorkflow<Database> {
    const workflow = this.workflows.find(value => value.kind === task.kind && value.version === task.version);
    if (!workflow) throw new TaskError("invalid_request", "This runner has no matching workflow version.");
    return workflow;
  }
  private time(): number { const now = this.now(); integer(now); return now; }
  private changed(result: { changes: number | bigint }): void {
    if (Number(result.changes) !== 1) throw new TaskError("claim_lost", "The task transition did not commit one row.");
  }
  private required(key: Key): StoredTask {
    const task = this.read(key);
    if (!task) throw new TaskError("invalid_task", "The task record is unavailable.");
    return task;
  }
  private read(key: Key): StoredTask | undefined {
    nonempty(key.scope); nonempty(key.id);
    const row = this.database.prepare("SELECT * FROM small_hour_tasks WHERE scope = ? AND id = ?").get(key.scope, key.id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    try {
      if (Number(row.format_version) !== 1) throw new TypeError("Unsupported task format");
      for (const field of ["input_json", "plan_json", "schedule_json"]) nonempty(row[field]);
      const request = identity({ scope: key.scope, id: key.id, kind: row.kind as string, version: row.version as string, input: JSON.parse(row.input_json as string) });
      const timing = schedule(JSON.parse(row.schedule_json as string));
      const steps = plan(JSON.parse(row.plan_json as string));
      if (canonicalJson(steps) !== row.plan_json || canonicalJson(timing) !== row.schedule_json || canonicalJson(request.input) !== row.input_json
        || row.concurrency_scope !== timing.concurrencyScope) throw new TypeError("Inconsistent task contract");
      integer(row.attempts); integer(row.due_at);
      if ((row.attempts as number) > timing.maxAttempts) throw new TypeError("Invalid attempts");
      const status = row.status as TaskStatus;
      if (!["queued", "running", "deferred", "completed", "cancelled", "rejected", "failed", "uncertain"].includes(status)) throw new TypeError("Invalid status");
      if (status === "queued" ? row.attempts !== 0 : status !== "cancelled" && row.attempts === 0) throw new TypeError("Status and attempts disagree");
      if (status === "running") { nonempty(row.token); integer(row.lease_until); }
      else if (row.token !== null || row.lease_until !== null) throw new TypeError("Unexpected claim");
      if (["deferred", "cancelled", "rejected", "failed", "uncertain"].includes(status)) nonempty(row.reason);
      else if (row.reason !== null) throw new TypeError("Unexpected reason");
      if (row.cancellation_reason !== null) nonempty(row.cancellation_reason);
      const resolution = row.resolution_json === null ? null : JSON.parse(row.resolution_json as string) as TaskResolution;
      if (row.resolution_json !== null && (!resolution || !["failed", "cancelled"].includes(resolution.status) || resolution.status !== status
        || resolution.reason !== row.reason || resolution.evidence == null || canonicalJson(resolution) !== row.resolution_json)) throw new TypeError("Invalid resolution");
      return { ...request, ...timing, dueAt: row.due_at as number, plan: steps, status, attempts: row.attempts as number,
        reason: row.reason as string | null, cancellationReason: row.cancellation_reason as string | null,
        token: row.token as string | null, leaseUntil: row.lease_until as number | null, resolution, scheduleJson: row.schedule_json as string };
    } catch (cause) { throw new TaskError("invalid_task", "The saved task failed validation.", { cause }); }
  }
  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.database.exec("COMMIT"); return value; }
    catch (cause) {
      try { this.database.exec("ROLLBACK"); }
      catch (rollback) { throw new TaskError("rollback_failed", "The task transaction failed and rollback could not be confirmed.", { cause: new AggregateError([cause, rollback]) }); }
      throw cause;
    }
  }
}
