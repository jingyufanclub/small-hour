import { createHash } from "node:crypto";
import { canonicalJson } from "./json.js";
import type { OperationRequest, SqliteDatabase } from "./sqlite.js";

export interface DeliveryReceipt { id: string; evidence: unknown }
export type DeliveryOutcome =
  | { status: "accepted"; receipt: DeliveryReceipt }
  | { status: "confirmed"; receipt: DeliveryReceipt; confirmation: { level: "destination" | "device" | "user"; evidence: unknown } }
  | { status: "deferred"; reason: string; dueAt: number; evidence: unknown }
  | { status: "rejected"; reason: string; evidence: unknown }
  | { status: "uncertain"; reason: string; evidence?: unknown };
export interface DeliveryContext {
  idempotencyKey: string;
  signal?: AbortSignal;
  assertActive(): void;
}
export interface DeliverySink {
  idempotency: "key" | "none";
  send(product: OperationRequest, context: DeliveryContext): Promise<DeliveryOutcome>;
  reconcile?(product: OperationRequest, context: DeliveryContext): Promise<DeliveryOutcome>;
}
export interface DeliveryAttempt { id: string; outcome: DeliveryOutcome }
export type DeliveryState = { attempts: DeliveryAttempt[] } & (DeliveryOutcome | { status: "queued" });
export class DeliveryError extends Error {
  constructor(readonly code: "invalid_delivery" | "invalid_outcome" | "evidence_conflict", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "DeliveryError";
  }
}
type Key = Pick<OperationRequest, "scope" | "id">;
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Expected a nonempty string");
}
function fields(value: object, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("Unexpected delivery evidence field");
}
function evidence(value: unknown): void {
  if (value == null) throw new TypeError("A definite outcome requires evidence");
}
export function acceptedDelivery(outcome: { status: string }): outcome is Extract<DeliveryOutcome, { status: "accepted" | "confirmed" }> {
  return outcome.status === "accepted" || outcome.status === "confirmed";
}
function confirmationRank(outcome: DeliveryOutcome): number {
  return outcome.status === "confirmed" ? ["destination", "device", "user"].indexOf(outcome.confirmation.level) + 1 : 0;
}
export function conflictingDeliveryReceipts(attempts: readonly DeliveryAttempt[]): boolean {
  return new Set(attempts.map(attempt => attempt.outcome).filter(acceptedDelivery).map(outcome => outcome.receipt.id)).size > 1;
}
function checkedOutcome(value: DeliveryOutcome): DeliveryOutcome {
  try {
    const outcome = JSON.parse(canonicalJson(value)) as DeliveryOutcome;
    if (acceptedDelivery(outcome)) {
      fields(outcome, outcome.status === "confirmed" ? ["status", "receipt", "confirmation"] : ["status", "receipt"]);
      fields(outcome.receipt, ["id", "evidence"]);
      nonempty(outcome.receipt.id); evidence(outcome.receipt.evidence);
      if (outcome.status === "confirmed") {
        fields(outcome.confirmation, ["level", "evidence"]);
        if (!["destination", "device", "user"].includes(outcome.confirmation.level)) throw new TypeError("Unknown confirmation level");
        evidence(outcome.confirmation.evidence);
      }
    } else {
      fields(outcome, outcome.status === "deferred" ? ["status", "reason", "dueAt", "evidence"] : ["status", "reason", "evidence"]);
      nonempty(outcome.reason);
      if (!["deferred", "rejected", "uncertain"].includes(outcome.status)) throw new TypeError("Unknown delivery outcome");
      if (outcome.status !== "uncertain") evidence(outcome.evidence);
      if (outcome.status === "deferred" && (!Number.isSafeInteger(outcome.dueAt) || outcome.dueAt < 0)) throw new TypeError("Invalid delivery due time");
    }
    return outcome;
  } catch (cause) { throw new DeliveryError("invalid_outcome", "Delivery evidence failed validation.", { cause }); }
}
export function deliveryKey(product: Key): string {
  return createHash("sha256").update(canonicalJson(["small-hour-delivery", product.scope, product.id])).digest("hex");
}

export class DeliveryLedger {
  constructor(private readonly database: SqliteDatabase) {}
  initialize(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS small_hour_deliveries (
      scope TEXT NOT NULL, id TEXT NOT NULL, attempts_json TEXT NOT NULL, format_version INTEGER NOT NULL,
      PRIMARY KEY (scope, id)
    )`);
  }
  inspect(key: Key): DeliveryState {
    const row = this.database.prepare("SELECT attempts_json, format_version FROM small_hour_deliveries WHERE scope = ? AND id = ?")
      .get(key.scope, key.id) as { attempts_json: string; format_version: number } | undefined;
    if (!row) return { status: "queued", attempts: [] };
    try {
      if (row.format_version !== 1) throw new TypeError("Unsupported delivery format");
      const attempts = JSON.parse(row.attempts_json) as DeliveryAttempt[], ids = new Set<string>();
      if (!Array.isArray(attempts) || !attempts.length) throw new TypeError("Missing delivery attempts");
      for (const attempt of attempts) {
        fields(attempt, ["id", "outcome"]); nonempty(attempt.id); if (ids.has(attempt.id)) throw new TypeError("Repeated delivery attempt"); ids.add(attempt.id);
        checkedOutcome(attempt.outcome);
      }
      if (canonicalJson(attempts) !== row.attempts_json) throw new TypeError("Invalid delivery encoding");
      const receipts = attempts.map(attempt => attempt.outcome).filter(acceptedDelivery);
      if (conflictingDeliveryReceipts(attempts)) {
        return { status: "uncertain", reason: "conflicting_receipts", attempts };
      }
      const strongest = receipts.reduce<(typeof receipts)[number] | undefined>((best, outcome) => !best || confirmationRank(outcome) > confirmationRank(best) ? outcome : best, undefined);
      const outcome = strongest
        ?? attempts.find(attempt => attempt.outcome.status === "uncertain")?.outcome ?? attempts.at(-1)!.outcome;
      return { ...outcome, attempts };
    } catch (cause) { throw new DeliveryError("invalid_delivery", "Stored delivery evidence failed validation.", { cause }); }
  }
  start(key: Key, attemptId: string): void {
    const state = this.inspect(key);
    if (state.attempts.some(attempt => attempt.id === attemptId)) throw new DeliveryError("evidence_conflict", "This attempt has already started.");
    this.write(key, [...state.attempts, { id: attemptId, outcome: { status: "uncertain", reason: "send_started" } }]);
  }
  record(key: Key, attemptId: string, value: DeliveryOutcome): void {
    const outcome = checkedOutcome(value), state = this.inspect(key);
    const attempt = state.attempts.find(attempt => attempt.id === attemptId);
    if (!attempt) throw new DeliveryError("evidence_conflict", "The delivery attempt is unavailable.");
    const previous = attempt.outcome;
    if (acceptedDelivery(previous)) {
      if (!acceptedDelivery(outcome)) return;
      if (previous.receipt.id !== outcome.receipt.id) throw new DeliveryError("evidence_conflict", "A receipt cannot be replaced with a different remote identity.");
      if (confirmationRank(outcome) <= confirmationRank(previous)) return;
      outcome.receipt = previous.receipt;
    }
    attempt.outcome = outcome; this.write(key, state.attempts);
  }
  private write(key: Key, attempts: DeliveryAttempt[]): void {
    const result = this.database.prepare(`INSERT INTO small_hour_deliveries (scope, id, attempts_json, format_version) VALUES (?, ?, ?, 1)
      ON CONFLICT (scope, id) DO UPDATE SET attempts_json = excluded.attempts_json`)
      .run(key.scope, key.id, canonicalJson(attempts));
    if (Number(result.changes) !== 1) throw new DeliveryError("invalid_delivery", "Delivery evidence did not commit one row.");
  }
}
