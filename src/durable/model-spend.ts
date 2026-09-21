import { types } from "node:util";
import { readModelCallStop } from "../model-call-record.js";
import type { ModelCallContext, ModelCallHooks, ModelCallRecord, TokenUsage } from "../types.js";
import { canonicalJson } from "./json.js";
import type { SqliteDatabase } from "./sqlite.js";

export interface ModelSpendQuote {
  scope: string;
  limit: number;
  amount: number;
  pricing: unknown;
}

export interface ModelSpendPolicy {
  quote(context: ModelCallContext): ModelSpendQuote;
  charge(usage: Readonly<TokenUsage>, pricing: unknown): number;
}

export type ModelSpendResolution = { evidence: string } & (
  { status: "accepted"; amount: number } | { status: "rejected" }
);

type CallIdentity = Pick<ModelCallContext, "agentId" | "turnId" | "callId" | "provider" | "model" | "attempt" | "hop" | "maxTokens" | "thinking">;
export type ModelSpendRecord = {
  context: CallIdentity;
  quote: ModelSpendQuote;
  record: ModelCallRecord | null;
  resolution: ModelSpendResolution | null;
} & (
  { status: "reserved" | "unknown"; chargedAmount: null }
  | { status: "accepted"; chargedAmount: number }
  | { status: "rejected" | "denied"; chargedAmount: 0 }
);

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
  const { agentId, turnId, callId, provider, model, attempt, hop, maxTokens, thinking } = context;
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
    ...(thinking === undefined ? {} : { thinking: { enabled: true, budgetTokens: thinking.budgetTokens } }) };
}

function quote(value: ModelSpendQuote): ModelSpendQuote {
  text(value.scope); amount(value.limit); amount(value.amount);
  return JSON.parse(canonicalJson({ scope: value.scope, limit: value.limit, amount: value.amount, pricing: value.pricing })) as ModelSpendQuote;
}

function record(value: Readonly<ModelCallRecord>, context: CallIdentity): ModelCallRecord {
  if (value.callId !== context.callId || value.provider !== context.provider || value.attempt !== context.attempt || value.hop !== context.hop
    || !["not_started", "responded", "rejected", "unknown"].includes(value.status)
    || !["unrecorded", "recorded"].includes(value.accounting)) throw new TypeError("Model accounting must match its reserved call.");
  if (value.requestId !== undefined) text(value.requestId);
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
    accounting: "unrecorded" as const, ...(value.requestId === undefined ? {} : { requestId: value.requestId }), ...(usage ? { usage } : {}) };
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

export class SqliteModelSpendStore {
  constructor(private readonly database: SqliteDatabase) {}

  initialize(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS small_hour_model_spend (
      call_id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      context_json TEXT NOT NULL,
      quote_json TEXT NOT NULL,
      reserved_amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      charged_amount INTEGER,
      record_json TEXT,
      resolution_json TEXT,
      format_version INTEGER NOT NULL,
      CHECK (${validAmounts})
    ); CREATE INDEX IF NOT EXISTS small_hour_model_spend_scope ON small_hour_model_spend (scope)`);
  }

  hooks(policy: ModelSpendPolicy): ModelCallHooks {
    if (typeof policy.quote !== "function" || typeof policy.charge !== "function"
      || types.isAsyncFunction(policy.quote) || types.isAsyncFunction(policy.charge)) {
      throw new ModelSpendError("invalid_request", "Spending requires synchronous quote and charge functions.");
    }
    return {
      admit: context => {
        const call = identity(context);
        return this.transaction(() => {
          if (this.inspect(call.callId)) throw new ModelSpendError("call_exists", "This call already has a spending decision.");
          const offered = quote(synchronous(policy.quote(context)));
          const total = this.inspectBudget(offered.scope).totalAmount;
          const admitted = total <= offered.limit && offered.amount <= offered.limit - total;
          changed(this.database.prepare(`INSERT INTO small_hour_model_spend
            (call_id, scope, context_json, quote_json, reserved_amount, status, charged_amount, format_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
            .run(call.callId, offered.scope, canonicalJson(call), canonicalJson(offered), offered.amount,
              admitted ? "reserved" : "denied", admitted ? null : 0));
          return admitted;
        });
      },
      record: (value, context) => this.transaction(() => {
        const call = identity(context), saved = this.require(call.callId);
        if (canonicalJson(call) !== canonicalJson(saved.context)) throw new ModelSpendError("settlement_conflict", "Accounting changed the reserved call identity.");
        const checked = record(value, call), json = canonicalJson(checked);
        if (saved.record && canonicalJson(saved.record) === json) return;
        if (saved.status !== "reserved") throw new ModelSpendError("settlement_conflict", "This call already has a different spending outcome.");
        let status: ModelSpendRecord["status"] = "unknown", charged: number | null = null;
        if (checked.status === "responded" && checked.usage) {
          charged = synchronous(policy.charge(checked.usage, saved.quote.pricing)); amount(charged); status = "accepted";
        } else if (checked.status === "rejected") { status = "rejected"; charged = 0; }
        changed(this.database.prepare("UPDATE small_hour_model_spend SET status = ?, charged_amount = ?, record_json = ? WHERE call_id = ?")
          .run(status, charged, json, call.callId));
      }),
    };
  }

  inspect(callId: string): ModelSpendRecord | undefined {
    text(callId);
    const row = this.database.prepare("SELECT * FROM small_hour_model_spend WHERE call_id = ?").get(callId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    try {
      if (row.format_version !== 1 || row.call_id !== callId) throw new TypeError("Unsupported spending record.");
      const context = identity(JSON.parse(String(row.context_json))), offered = quote(JSON.parse(String(row.quote_json)));
      if (context.callId !== callId || offered.scope !== row.scope || offered.amount !== row.reserved_amount) throw new TypeError("Spending identity changed.");
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
      return { context, quote: offered, status: expectedStatus, chargedAmount, record: savedRecord, resolution: resolved } as ModelSpendRecord;
    } catch (cause) {
      throw new ModelSpendError("invalid_record", "The stored spending record failed validation.", { cause });
    }
  }

  inspectBudget(scope: string): ModelSpendBudget {
    text(scope);
    const row = this.database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'accepted' THEN charged_amount ELSE 0 END), 0) AS accepted,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_amount ELSE 0 END), 0) AS reserved,
      COALESCE(SUM(CASE WHEN status = 'unknown' THEN reserved_amount ELSE 0 END), 0) AS unknown,
      COALESCE(SUM(CASE WHEN format_version = 1 AND (${validAmounts}) THEN 0 ELSE 1 END), 0) AS invalid
      FROM small_hour_model_spend WHERE scope = ?`).get(scope) as Record<string, unknown>;
    try {
      if (row.invalid !== 0) throw new TypeError("Unsupported spending totals.");
      amount(row.accepted); amount(row.reserved); amount(row.unknown);
      const totalAmount = row.accepted + row.reserved + row.unknown; amount(totalAmount);
      return { acceptedAmount: row.accepted, reservedAmount: row.reserved, unknownAmount: row.unknown, totalAmount };
    } catch (cause) {
      throw new ModelSpendError("invalid_record", "The stored budget failed validation.", { cause });
    }
  }

  reconcile(callId: string, outcome: ModelSpendResolution): ModelSpendRecord {
    const checked = resolution(outcome), json = canonicalJson(checked);
    return this.transaction(() => {
      const saved = this.require(callId);
      if (saved.resolution && canonicalJson(saved.resolution) === json) return saved;
      if (saved.status !== "reserved" && saved.status !== "unknown") throw new ModelSpendError("settlement_conflict", "Only unresolved spending can be reconciled.");
      changed(this.database.prepare("UPDATE small_hour_model_spend SET status = ?, charged_amount = ?, resolution_json = ? WHERE call_id = ?")
        .run(checked.status, checked.status === "accepted" ? checked.amount : 0, json, callId));
      return this.require(callId);
    });
  }

  private require(callId: string): ModelSpendRecord {
    const saved = this.inspect(callId);
    if (!saved) throw new ModelSpendError("call_missing", "This model call has no spending reservation.");
    return saved;
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
