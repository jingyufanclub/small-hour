import { types } from "node:util";
import { readModelCallAdmission, readModelCallStop } from "../model-call-record.js";
import type { ModelCallCheck, ModelCallContext, ModelCallHooks, ModelCallRecord, ModelCallRequest, TokenUsage } from "../types.js";
import { captureContent, readTraceContext, type TraceContent } from "../tracing.js";
import { canonicalJson } from "./json.js";
import type { SqliteDatabase } from "./sqlite.js";
import { initializeTimestamps, readTimestamps, recordTime, type DurableClockOptions, type RecordTimestamps } from "./lifecycle.js";

export interface ModelSpendScope {
  scope: string;
  limit: number;
}

export type ModelSpendQuote = {
  amount: number;
  pricing: unknown;
  denied?: never;
} & (ModelSpendScope & { scopes?: never } | { scopes: readonly ModelSpendScope[]; scope?: never; limit?: never });

export interface ModelSpendDenial {
  denied: true;
  scopes: readonly string[];
  reason: string;
  evidence: string;
  amount?: never;
  pricing?: never;
  scope?: never;
  limit?: never;
}

export type ModelSpendDecision = ModelSpendQuote | ModelSpendDenial;

export interface ModelSpendPolicy {
  quote(context: ModelCallContext, request?: Readonly<ModelCallRequest>): ModelSpendDecision;
  charge(usage: Readonly<TokenUsage>, pricing: unknown): number;
}

export type ModelSpendResolution = { evidence: string } & (
  { status: "accepted"; amount: number } | { status: "rejected" }
);

type CallIdentity = Pick<ModelCallContext, "agentId" | "turnId" | "callId" | "provider" | "model" | "attempt" | "hop" | "maxTokens" | "thinking" | "trace">;
export interface ModelCallEvidence {
  attributes: ModelCallAttributes;
  request: TraceContent;
  response: TraceContent | null;
  failure: { code: string } | null;
  durationMs: number | null;
  finishedAt: number | null;
  checks: Record<string, ModelCallCheck>;
}
export type ModelCallAttributes = Record<string, string | number | boolean | null>;
export interface ModelCallStoreOptions extends DurableClockOptions {
  content?: { maxBytes: number };
  attributes?(identity: Readonly<CallIdentity>): ModelCallAttributes;
}
type QuotedStoredModelCall = RecordTimestamps & ModelCallEvidence & {
  context: CallIdentity;
  quote: ModelSpendQuote;
  denial?: never;
  record: ModelCallRecord | null;
  resolution: ModelSpendResolution | null;
} & (
  { status: "reserved" | "unknown"; chargedAmount: null }
  | { status: "accepted"; chargedAmount: number }
  | { status: "rejected" | "denied"; chargedAmount: 0 }
);

export type StoredModelCall = QuotedStoredModelCall | (RecordTimestamps & ModelCallEvidence & {
  context: CallIdentity;
  quote: null;
  denial: ModelSpendDenial;
  status: "denied";
  chargedAmount: 0;
  record: null;
  resolution: null;
});

export interface ModelSpendBudget {
  acceptedAmount: number;
  reservedAmount: number;
  unknownAmount: number;
  totalAmount: number;
}

export class ModelSpendError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_record" | "call_exists" | "call_missing" | "settlement_conflict",
    message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelSpendError";
  }
}

function amount(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError("Spending amounts must be nonnegative safe integers.");
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Spending identifiers must be nonempty strings.");
}

function synchronous<T>(value: T): T {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    if (types.isPromise(value)) void value.catch(() => {});
    throw new TypeError("Spending policy callbacks must be synchronous.");
  }
  return value;
}

function identity(context: ModelCallContext): CallIdentity {
  const { agentId, turnId, callId, provider, model, attempt, hop, maxTokens, thinking, trace } = context;
  for (const value of [agentId, turnId, callId, provider]) text(value);
  if (model !== undefined) text(model);
  for (const value of [attempt, hop, maxTokens]) amount(value);
  if (attempt === 0 || maxTokens === 0) throw new TypeError("A model call needs positive attempt and token limits.");
  if (thinking !== undefined) {
    amount(thinking.budgetTokens);
    if (thinking.enabled !== true) throw new TypeError("Unsupported thinking configuration.");
  }
  return { agentId, turnId, callId, provider, attempt, hop, maxTokens,
    ...(model === undefined ? {} : { model }),
    ...(trace === undefined ? {} : { trace: readTraceContext(trace) }),
    ...(thinking === undefined ? {} : { thinking: { enabled: true, budgetTokens: thinking.budgetTokens } }) };
}

function quote(value: ModelSpendQuote): ModelSpendQuote {
  amount(value.amount);
  let selected: Pick<ModelSpendQuote, "scopes" | "scope" | "limit">;
  if ("scopes" in value) {
    if ("scope" in value || "limit" in value || !Array.isArray(value.scopes) || !value.scopes.length) {
      throw new TypeError("A spending quote needs either one scope or a nonempty scope list.");
    }
    const seen = new Set<string>();
    selected = { scopes: value.scopes.map(({ scope, limit }) => {
      text(scope); amount(limit);
      if (seen.has(scope)) throw new TypeError("A spending quote cannot repeat a scope.");
      seen.add(scope); return { scope, limit };
    }) };
  } else {
    text(value.scope); amount(value.limit); selected = { scope: value.scope, limit: value.limit };
  }
  return JSON.parse(canonicalJson({ ...selected, amount: value.amount, pricing: value.pricing })) as ModelSpendQuote;
}

function scopes(value: ModelSpendQuote): readonly ModelSpendScope[] {
  if (value.scopes !== undefined) return value.scopes;
  return [{ scope: value.scope, limit: value.limit }];
}

function decision(value: ModelSpendDecision): ModelSpendDecision {
  if (!("denied" in value)) return quote(value);
  if (value.denied !== true || ["amount", "pricing", "scope", "limit"].some(key => key in value)) {
    throw new TypeError("An explicit spending denial cannot include a quote.");
  }
  text(value.reason); text(value.evidence);
  if (!Array.isArray(value.scopes) || !value.scopes.length) throw new TypeError("A spending denial needs a nonempty scope list.");
  const seen = new Set<string>();
  const selected = value.scopes.map(scope => {
    text(scope);
    if (seen.has(scope)) throw new TypeError("A spending denial cannot repeat a scope.");
    seen.add(scope); return scope;
  });
  return JSON.parse(canonicalJson({ denied: true, scopes: selected, reason: value.reason, evidence: value.evidence })) as ModelSpendDenial;
}

function record(value: Readonly<ModelCallRecord>, context: CallIdentity): ModelCallRecord {
  if (readModelCallAdmission(value)) throw new TypeError("An admission refusal cannot settle a reserved call.");
  if (value.callId !== context.callId || value.provider !== context.provider || value.attempt !== context.attempt || value.hop !== context.hop
    || !["not_started", "responded", "rejected", "unknown"].includes(value.status)
    || !["unrecorded", "recorded"].includes(value.accounting)) throw new TypeError("Model accounting must match its reserved call.");
  if (value.requestId !== undefined) text(value.requestId);
  if (canonicalJson(value.trace ?? null) !== canonicalJson(context.trace ?? null)) throw new TypeError("Model accounting changed the call trace.");
  let usage: TokenUsage | undefined;
  if (value.usage !== undefined) {
    if (value.status !== "responded") throw new TypeError("Only a provider response can supply token usage.");
    const { model, freshInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens } = value.usage;
    text(model);
    for (const tokens of [freshInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens]) amount(tokens);
    usage = { model, freshInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens };
  }
  const stop = readModelCallStop(value);
  const base = { callId: value.callId, provider: value.provider, attempt: value.attempt, hop: value.hop,
    accounting: "unrecorded" as const, ...(value.requestId === undefined ? {} : { requestId: value.requestId }), ...(usage ? { usage } : {}),
    ...(value.trace === undefined ? {} : { trace: readTraceContext(value.trace) }) };
  return value.status === "responded" ? { ...base, status: value.status, ...(stop ? { stop } : {}) } : { ...base, status: value.status };
}

function resolution(value: ModelSpendResolution): ModelSpendResolution {
  text(value.evidence);
  if (value.status === "accepted") { amount(value.amount); return { status: "accepted", amount: value.amount, evidence: value.evidence }; }
  if (value.status === "rejected") return { status: "rejected", evidence: value.evidence };
  throw new TypeError("Reconciliation needs a confirmed charge or confirmed rejection.");
}

function changed(result: { changes: number | bigint }): void {
  if (Number(result.changes) !== 1) throw new ModelSpendError("invalid_record", "The spending write did not persist exactly one call.");
}

const validAmounts = `typeof(reserved_amount) = 'integer' AND reserved_amount BETWEEN 0 AND 9007199254740991
  AND ((status IN ('reserved', 'unknown') AND charged_amount IS NULL)
    OR (status = 'accepted' AND typeof(charged_amount) = 'integer' AND charged_amount BETWEEN 0 AND 9007199254740991)
    OR (status IN ('rejected', 'denied') AND charged_amount = 0))`;

const notRecorded: TraceContent = { status: "unavailable", reason: "not_recorded" };

function content(value: unknown): TraceContent {
  const item = value as TraceContent | null;
  if (!item || typeof item !== "object") throw new TypeError("Invalid captured content.");
  if (item.status === "captured") {
    const captured = captureContent(() => item.value, { maxBytes: Number.MAX_SAFE_INTEGER });
    if (captured.status !== "captured" || captured.bytes !== item.bytes) throw new TypeError("Invalid captured content size.");
    return captured;
  }
  if (item.status === "omitted") {
    if (item.reason === "disabled") return { status: item.status, reason: item.reason };
    if (item.reason === "size_limit") {
      amount(item.bytes); amount(item.maxBytes);
      if (item.maxBytes > 0 && item.bytes > item.maxBytes) return { status: item.status, reason: item.reason, bytes: item.bytes, maxBytes: item.maxBytes };
    }
  }
  if (item.status === "unavailable" && (item.reason === "serialization_failed" || item.reason === "not_recorded")) return { status: item.status, reason: item.reason };
  throw new TypeError("Invalid content capture outcome.");
}

function check(value: ModelCallCheck): ModelCallCheck {
  text(value.name);
  if (!["accepted", "rejected", "unavailable"].includes(value.verdict) || !Array.isArray(value.issues)) throw new TypeError("Invalid model check.");
  if (value.issues.some(issue => typeof issue !== "string")) throw new TypeError("Model check issues must be strings.");
  return { name: value.name, verdict: value.verdict, issues: [...value.issues] };
}

function attributes(value: ModelCallAttributes): ModelCallAttributes {
  const selected = JSON.parse(canonicalJson(value));
  if (!selected || typeof selected !== "object" || Array.isArray(selected)
    || Object.values(selected).some(item => item !== null && !["string", "number", "boolean"].includes(typeof item))) {
    throw new TypeError("Call attributes must be a JSON object of scalar values.");
  }
  return selected;
}

function evidence(row: Record<string, unknown>): ModelCallEvidence {
  const request = row.request_json === undefined ? notRecorded : content(JSON.parse(String(row.request_json)));
  const response = row.response_json == null ? null : content(JSON.parse(String(row.response_json)));
  const failure = row.failure_code == null ? null : { code: String(row.failure_code) };
  if (failure) text(row.failure_code);
  const durationMs = row.duration_ms ?? null, finishedAt = row.finished_at ?? null;
  if (durationMs !== null && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) throw new TypeError("Invalid call duration.");
  if (finishedAt !== null) amount(finishedAt);
  if ((durationMs === null) !== (finishedAt === null) || (response !== null && failure !== null)) throw new TypeError("Inconsistent call completion.");
  const checks = row.checks_json === undefined ? {} : JSON.parse(String(row.checks_json));
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) throw new TypeError("Invalid call checks.");
  for (const [name, value] of Object.entries(checks)) {
    const checked = check(value as ModelCallCheck);
    if (name !== checked.name) throw new TypeError("Model check identity changed.");
  }
  return { request, response, failure, durationMs, finishedAt: finishedAt as number | null, checks,
    attributes: row.attributes_json === undefined ? {} : attributes(JSON.parse(String(row.attributes_json))) };
}

function storedRecord(row: Record<string, unknown>, version: 1): QuotedStoredModelCall;
function storedRecord(row: Record<string, unknown>, version: 3): StoredModelCall;
function storedRecord(row: Record<string, unknown>, version: 1 | 3): StoredModelCall {
  try {
    text(row.call_id);
    if (row.format_version !== version) throw new TypeError("Unsupported spending record.");
    const context = identity(JSON.parse(String(row.context_json))), offered = decision(JSON.parse(String(row.quote_json)));
    if (context.callId !== row.call_id) throw new TypeError("Spending identity changed.");
    if (offered.denied) {
      if (version !== 3 || row.status !== "denied" || row.reserved_amount !== 0 || row.charged_amount !== 0
        || row.record_json !== null || row.resolution_json !== null) throw new TypeError("Inconsistent spending denial.");
      return { context, quote: null, denial: offered, status: "denied", chargedAmount: 0, record: null, resolution: null, ...readTimestamps(row), ...evidence(row) };
    }
    if (offered.amount !== row.reserved_amount
      || (version === 1 && (offered.scopes !== undefined || offered.scope !== row.scope))) throw new TypeError("Spending identity changed.");
    const savedRecord = row.record_json === null ? null : record(JSON.parse(String(row.record_json)), context);
    const resolved = row.resolution_json === null ? null : resolution(JSON.parse(String(row.resolution_json)));
    const status = row.status, chargedAmount = row.charged_amount;
    if (chargedAmount !== null) amount(chargedAmount);
    const expectedStatus = resolved?.status ?? (savedRecord
      ? savedRecord.status === "responded" && savedRecord.usage ? "accepted" : savedRecord.status === "rejected" ? "rejected" : "unknown"
      : status === "denied" ? "denied" : "reserved");
    if (status !== expectedStatus || ((status === "reserved" || status === "unknown") ? chargedAmount !== null : chargedAmount === null)
      || ((status === "rejected" || status === "denied") && chargedAmount !== 0)
      || (resolved?.status === "accepted" && chargedAmount !== resolved.amount)) throw new TypeError("Inconsistent spending outcome.");
    return { context, quote: offered, status: expectedStatus, chargedAmount, record: savedRecord, resolution: resolved,
      ...(version === 1 ? { createdAt: null, updatedAt: null } : readTimestamps(row)), ...evidence(row) } as StoredModelCall;
  } catch (cause) {
    throw new ModelSpendError("invalid_record", "The stored spending record failed validation.", { cause });
  }
}

export class SqliteModelCallStore {
  private readonly now: () => number;
  private readonly capture?: { maxBytes: number };
  private readonly describe?: ModelCallStoreOptions["attributes"];
  constructor(private readonly database: SqliteDatabase, options: ModelCallStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.describe = options.attributes;
    if (options.content) {
      amount(options.content.maxBytes);
      if (!options.content.maxBytes) throw new TypeError("Content capture requires a positive byte limit.");
      this.capture = { ...options.content };
    }
  }

  initialize(): void {
    const db = this.database;
    db.exec("SAVEPOINT small_hour_spending_schema");
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'small_hour_model_spend'").get()) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_calls'").get()) throw new ModelSpendError("invalid_record", "Two model call stores exist; select one authority before setup.");
        db.exec("ALTER TABLE small_hour_model_spend RENAME TO model_calls");
        if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'small_hour_model_spend_scopes'").get()) {
          db.exec("ALTER TABLE small_hour_model_spend_scopes RENAME TO model_call_scopes; DROP INDEX IF EXISTS small_hour_model_spend_scopes_lookup");
        }
      }
      db.exec(`CREATE TABLE IF NOT EXISTS model_calls (
      call_id TEXT PRIMARY KEY NOT NULL,
      context_json TEXT NOT NULL,
      quote_json TEXT NOT NULL,
      reserved_amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      charged_amount INTEGER,
      record_json TEXT,
      resolution_json TEXT,
      format_version INTEGER NOT NULL,
      CHECK (${validAmounts})
      )`);
      const legacy = db.prepare("SELECT name FROM pragma_table_info('model_calls') WHERE name = 'scope'").get();
      if (!legacy && !db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_call_scopes'").get()
        && db.prepare("SELECT call_id FROM model_calls LIMIT 1").get()) {
        throw new ModelSpendError("invalid_record", "The spending scope index is missing.");
      }
      db.exec(`CREATE TABLE IF NOT EXISTS model_call_scopes (
        call_id TEXT NOT NULL REFERENCES model_calls(call_id) ON DELETE RESTRICT,
        scope TEXT NOT NULL, PRIMARY KEY (call_id, scope)
      ); CREATE INDEX IF NOT EXISTS model_call_scopes_lookup ON model_call_scopes (scope, call_id)`);
      initializeTimestamps(db, "model_call_scopes", []);
      if (legacy) {
        let after: string | null = null;
        for (;;) {
          const row = db.prepare(`SELECT * FROM model_calls ${after === null ? "" : "WHERE call_id > ?"} ORDER BY call_id LIMIT 1`)
            .get(...(after === null ? [] : [after])) as Record<string, unknown> | undefined;
          if (!row) break;
          const saved = storedRecord(row, 1);
          this.insertScopes(saved.context.callId, scopes(saved.quote).map(value => value.scope), null);
          changed(db.prepare("UPDATE model_calls SET format_version = 2 WHERE call_id = ?").run(saved.context.callId));
          after = saved.context.callId;
        }
        db.exec("DROP INDEX IF EXISTS small_hour_model_spend_scope; DROP INDEX IF EXISTS model_calls_scope; ALTER TABLE model_calls DROP COLUMN scope");
      }
      initializeTimestamps(db, "model_calls", [[2, 3]]);
      if (!db.prepare("SELECT name FROM pragma_table_info('model_calls') WHERE name = 'request_json'").get()) {
        db.exec(`ALTER TABLE model_calls ADD COLUMN request_json TEXT NOT NULL DEFAULT '{"status":"unavailable","reason":"not_recorded"}';
          ALTER TABLE model_calls ADD COLUMN response_json TEXT;
          ALTER TABLE model_calls ADD COLUMN failure_code TEXT;
          ALTER TABLE model_calls ADD COLUMN duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0);
          ALTER TABLE model_calls ADD COLUMN finished_at INTEGER CHECK (finished_at IS NULL OR (typeof(finished_at) = 'integer' AND finished_at BETWEEN 0 AND 9007199254740991));
          ALTER TABLE model_calls ADD COLUMN checks_json TEXT NOT NULL DEFAULT '{}';
          ALTER TABLE model_calls ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '{}';`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS model_calls_turn ON model_calls (json_extract(context_json, '$.agentId'), json_extract(context_json, '$.turnId'));
        CREATE INDEX IF NOT EXISTS model_calls_trace ON model_calls (json_extract(context_json, '$.trace.traceId'));`);
      db.exec("RELEASE SAVEPOINT small_hour_spending_schema");
    } catch (cause) {
      try { db.exec("ROLLBACK TO SAVEPOINT small_hour_spending_schema"); db.exec("RELEASE SAVEPOINT small_hour_spending_schema"); }
      catch (rollback) { throw new AggregateError([cause, rollback], "Spending schema setup could not be rolled back.", { cause }); }
      throw cause;
    }
  }

  hooks(policy: ModelSpendPolicy): ModelCallHooks {
    if (typeof policy.quote !== "function" || typeof policy.charge !== "function"
      || types.isAsyncFunction(policy.quote) || types.isAsyncFunction(policy.charge)) {
      throw new ModelSpendError("invalid_request", "Spending requires synchronous quote and charge functions.");
    }
    return {
      admit: (context, request) => {
        const call = identity(context);
        const captured = request === undefined ? notRecorded : captureContent(() => request, this.capture);
        return this.transaction(() => {
          if (this.inspect(call.callId)) throw new ModelSpendError("call_exists", "This call already has a spending decision.");
          const offered = decision(synchronous(policy.quote(context, request)));
          const details = this.describe ? attributes(synchronous(this.describe(structuredClone(call)))) : {};
          let admitted = !offered.denied;
          if (!offered.denied) {
            for (const { scope, limit } of scopes(offered)) {
              const total = this.inspectBudget(scope).totalAmount;
              if (total > limit || offered.amount > limit - total) admitted = false;
            }
          }
          const time = recordTime(this.now);
          changed(this.database.prepare(`INSERT INTO model_calls
            (call_id, context_json, quote_json, reserved_amount, status, charged_amount, format_version, created_at, updated_at, request_json, attributes_json)
            VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?)`)
            .run(call.callId, canonicalJson(call), canonicalJson(offered), offered.denied ? 0 : offered.amount,
              admitted ? "reserved" : "denied", admitted ? null : 0, time, time, canonicalJson(captured), canonicalJson(details)));
          this.insertScopes(call.callId, offered.denied ? offered.scopes : scopes(offered).map(value => value.scope), time);
          return admitted;
        });
      },
      record: (value, context, completion) => this.transaction(() => {
        const call = identity(context), saved = this.require(call.callId);
        if (canonicalJson(call) !== canonicalJson(saved.context)) throw new ModelSpendError("settlement_conflict", "Accounting changed the reserved call identity.");
        const checked = record(value, call), json = canonicalJson(checked);
        const response = completion?.response ? captureContent(() => completion.response, this.capture) : checked.status === "responded" ? notRecorded : null;
        const failure = completion?.errorCode ? { code: completion.errorCode } : null;
        const durationMs = completion?.durationMs ?? null;
        if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0)) throw new TypeError("Invalid call duration.");
        if (failure) text(failure.code);
        if ((completion?.response && checked.status !== "responded") || (failure && checked.status === "responded")) throw new TypeError("Completion contradicts the call outcome.");
        if (saved.record && canonicalJson(saved.record) === json && canonicalJson(saved.response) === canonicalJson(response)
          && canonicalJson(saved.failure) === canonicalJson(failure) && saved.durationMs === durationMs) return;
        if (saved.status !== "reserved") throw new ModelSpendError("settlement_conflict", "This call already has a different spending outcome.");
        let status: StoredModelCall["status"] = "unknown", charged: number | null = null;
        if (checked.status === "responded" && checked.usage) {
          charged = synchronous(policy.charge(checked.usage, saved.quote.pricing)); amount(charged); status = "accepted";
        } else if (checked.status === "rejected") { status = "rejected"; charged = 0; }
        const time = recordTime(this.now, saved.updatedAt);
        changed(this.database.prepare(`UPDATE model_calls SET status = ?, charged_amount = ?, record_json = ?, updated_at = ?,
          response_json = ?, failure_code = ?, duration_ms = ?, finished_at = ? WHERE call_id = ?`)
          .run(status, charged, json, time, response === null ? null : canonicalJson(response), failure?.code ?? null, durationMs,
            completion === undefined ? null : time, call.callId));
      }),
      check: (callId, result) => this.recordCheck(callId, result),
    };
  }

  recordCheck(callId: string, result: ModelCallCheck): void {
    const checked = check(result);
    this.transaction(() => {
      const saved = this.require(callId);
      if (saved.record?.status !== "responded") throw new ModelSpendError("settlement_conflict", "Validation requires a recorded provider response.");
      if (Object.hasOwn(saved.checks, checked.name)) {
        if (canonicalJson(saved.checks[checked.name]) === canonicalJson(checked)) return;
        throw new ModelSpendError("settlement_conflict", "A model check already has a different outcome.");
      }
      changed(this.database.prepare("UPDATE model_calls SET checks_json = ?, updated_at = ? WHERE call_id = ?")
        .run(canonicalJson({ ...saved.checks, [checked.name]: checked }), recordTime(this.now, saved.updatedAt), callId));
    });
  }

  inspect(callId: string): StoredModelCall | undefined {
    text(callId);
    const row = this.database.prepare("SELECT * FROM model_calls WHERE call_id = ?").get(callId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const saved = storedRecord(row, 3), selected = saved.quote === null ? saved.denial.scopes : scopes(saved.quote).map(value => value.scope);
    const indexed = this.database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN scope IN (${selected.map(() => "?").join(",")}) THEN 1 ELSE 0 END), 0) AS matched
      FROM model_call_scopes WHERE call_id = ?`).get(...selected, callId) as { total: number; matched: number };
    if (indexed.total !== selected.length || indexed.matched !== selected.length) {
      throw new ModelSpendError("invalid_record", "The spending scope index does not match its decision.");
    }
    return saved;
  }

  inspectBudget(scope: string): ModelSpendBudget {
    text(scope);
    const row = this.database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'accepted' THEN charged_amount ELSE 0 END), 0) AS accepted,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_amount ELSE 0 END), 0) AS reserved,
      COALESCE(SUM(CASE WHEN status = 'unknown' THEN reserved_amount ELSE 0 END), 0) AS unknown,
      COALESCE(SUM(CASE WHEN format_version = 3 AND (${validAmounts}) THEN 0 ELSE 1 END), 0) AS invalid
      FROM model_call_scopes AS membership LEFT JOIN model_calls AS spending
        ON spending.call_id = membership.call_id WHERE membership.scope = ?`).get(scope) as Record<string, unknown>;
    try {
      if (row.invalid !== 0) throw new TypeError("Unsupported spending totals.");
      amount(row.accepted); amount(row.reserved); amount(row.unknown);
      const totalAmount = row.accepted + row.reserved + row.unknown; amount(totalAmount);
      return { acceptedAmount: row.accepted, reservedAmount: row.reserved, unknownAmount: row.unknown, totalAmount };
    } catch (cause) {
      throw new ModelSpendError("invalid_record", "The stored budget failed validation.", { cause });
    }
  }

  reconcile(callId: string, outcome: ModelSpendResolution): StoredModelCall {
    const checked = resolution(outcome), json = canonicalJson(checked);
    return this.transaction(() => {
      const saved = this.require(callId);
      if (saved.resolution && canonicalJson(saved.resolution) === json) return saved;
      if (saved.status !== "reserved" && saved.status !== "unknown") throw new ModelSpendError("settlement_conflict", "Only unresolved spending can be reconciled.");
      changed(this.database.prepare("UPDATE model_calls SET status = ?, charged_amount = ?, resolution_json = ?, updated_at = ? WHERE call_id = ?")
        .run(checked.status, checked.status === "accepted" ? checked.amount : 0, json, recordTime(this.now, saved.updatedAt), callId));
      return this.require(callId);
    });
  }

  private require(callId: string): StoredModelCall {
    const saved = this.inspect(callId);
    if (!saved) throw new ModelSpendError("call_missing", "This model call has no spending reservation.");
    return saved;
  }

  private insertScopes(callId: string, selected: readonly string[], time: number | null): void {
    for (const scope of selected) {
      changed(this.database.prepare("INSERT INTO model_call_scopes (call_id, scope, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(callId, scope, time, time));
    }
  }

  private transaction<T>(operation: () => T): T {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(); db.exec("COMMIT"); return result;
    } catch (cause) {
      try { db.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([cause, rollbackError], "Spending failed and rollback could not be confirmed.", { cause }); }
      throw cause;
    }
  }
}
