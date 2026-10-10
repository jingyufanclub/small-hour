import { types } from "node:util";
import { readModelCallStop } from "../model-call-record.js";
import type { ModelCallContext, ModelCallHooks, ModelCallRecord, TokenUsage } from "../types.js";
import { canonicalJson } from "./json.js";
import type { SqliteDatabase } from "./sqlite.js";

export interface ModelSpendScope {
  scope: string;
  limit: number;
}

export type ModelSpendQuote = {
  amount: number;
  pricing: unknown;
} & (ModelSpendScope & { scopes?: never } | { scopes: readonly ModelSpendScope[]; scope?: never; limit?: never });

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

function storedRecord(row: Record<string, unknown>, version: 1 | 2): ModelSpendRecord {
  try {
    text(row.call_id);
    if (row.format_version !== version) throw new TypeError("Unsupported spending record.");
    const context = identity(JSON.parse(String(row.context_json))), offered = quote(JSON.parse(String(row.quote_json)));
    if (context.callId !== row.call_id || offered.amount !== row.reserved_amount
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
    return { context, quote: offered, status: expectedStatus, chargedAmount, record: savedRecord, resolution: resolved } as ModelSpendRecord;
  } catch (cause) {
    throw new ModelSpendError("invalid_record", "The stored spending record failed validation.", { cause });
  }
}

export class SqliteModelSpendStore {
  constructor(private readonly database: SqliteDatabase) {}

  initialize(): void {
    this.transaction(() => {
      const db = this.database;
      db.exec(`CREATE TABLE IF NOT EXISTS small_hour_model_spend (
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
      const legacy = db.prepare("SELECT name FROM pragma_table_info('small_hour_model_spend') WHERE name = 'scope'").get();
      if (!legacy && !db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'small_hour_model_spend_scopes'").get()
        && db.prepare("SELECT call_id FROM small_hour_model_spend LIMIT 1").get()) {
        throw new ModelSpendError("invalid_record", "The spending scope index is missing.");
      }
      db.exec(`CREATE TABLE IF NOT EXISTS small_hour_model_spend_scopes (
        call_id TEXT NOT NULL REFERENCES small_hour_model_spend(call_id) ON DELETE RESTRICT,
        scope TEXT NOT NULL, PRIMARY KEY (call_id, scope)
      ); CREATE INDEX IF NOT EXISTS small_hour_model_spend_scopes_lookup ON small_hour_model_spend_scopes (scope, call_id)`);
      if (legacy) {
        let after: string | null = null;
        for (;;) {
          const row = db.prepare(`SELECT * FROM small_hour_model_spend ${after === null ? "" : "WHERE call_id > ?"} ORDER BY call_id LIMIT 1`)
            .get(...(after === null ? [] : [after])) as Record<string, unknown> | undefined;
          if (!row) break;
          const saved = storedRecord(row, 1);
          this.insertScopes(saved.context.callId, saved.quote);
          changed(db.prepare("UPDATE small_hour_model_spend SET format_version = 2 WHERE call_id = ?").run(saved.context.callId));
          after = saved.context.callId;
        }
        db.exec("DROP INDEX IF EXISTS small_hour_model_spend_scope; ALTER TABLE small_hour_model_spend DROP COLUMN scope");
      }
    });
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
          let admitted = true;
          for (const { scope, limit } of scopes(offered)) {
            const total = this.inspectBudget(scope).totalAmount;
            if (total > limit || offered.amount > limit - total) admitted = false;
          }
          changed(this.database.prepare(`INSERT INTO small_hour_model_spend
            (call_id, context_json, quote_json, reserved_amount, status, charged_amount, format_version)
            VALUES (?, ?, ?, ?, ?, ?, 2)`)
            .run(call.callId, canonicalJson(call), canonicalJson(offered), offered.amount,
              admitted ? "reserved" : "denied", admitted ? null : 0));
          this.insertScopes(call.callId, offered);
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
    const saved = storedRecord(row, 2), selected = scopes(saved.quote);
    const indexed = this.database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN scope IN (${selected.map(() => "?").join(",")}) THEN 1 ELSE 0 END), 0) AS matched
      FROM small_hour_model_spend_scopes WHERE call_id = ?`).get(...selected.map(value => value.scope), callId) as { total: number; matched: number };
    if (indexed.total !== selected.length || indexed.matched !== selected.length) {
      throw new ModelSpendError("invalid_record", "The spending scope index does not match its quote.");
    }
    return saved;
  }

  inspectBudget(scope: string): ModelSpendBudget {
    text(scope);
    const row = this.database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'accepted' THEN charged_amount ELSE 0 END), 0) AS accepted,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_amount ELSE 0 END), 0) AS reserved,
      COALESCE(SUM(CASE WHEN status = 'unknown' THEN reserved_amount ELSE 0 END), 0) AS unknown,
      COALESCE(SUM(CASE WHEN format_version = 2 AND (${validAmounts}) THEN 0 ELSE 1 END), 0) AS invalid
      FROM small_hour_model_spend_scopes AS membership LEFT JOIN small_hour_model_spend AS spending
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

  private insertScopes(callId: string, offered: ModelSpendQuote): void {
    for (const { scope } of scopes(offered)) {
      changed(this.database.prepare("INSERT INTO small_hour_model_spend_scopes (call_id, scope) VALUES (?, ?)").run(callId, scope));
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
