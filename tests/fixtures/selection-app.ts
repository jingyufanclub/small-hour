import { EmptyMemorySource, SmallHourRuntime, StaticPersonaSource, type ModelProvider } from "../../src/index.js";
import { SqliteTaskRunner, type DeliverySink, type SqliteDatabase, type TaskWorkflow } from "../../src/durable/sqlite.js";

type SelectionInput = { ownerId: string; candidateIds: string[]; request: string };
function input(value: unknown): SelectionInput {
  const row = value as SelectionInput;
  if (!row || typeof row.ownerId !== "string" || !row.ownerId || typeof row.request !== "string"
    || !Array.isArray(row.candidateIds) || !row.candidateIds.length
    || row.candidateIds.some(id => typeof id !== "string" || !id)
    || new Set(row.candidateIds).size !== row.candidateIds.length) throw new Error("invalid selection input");
  return row;
}
function selection(value: unknown, candidates: string[]) {
  const row = value as { itemIds: string[] };
  if (!row || !Array.isArray(row.itemIds) || !row.itemIds.length || Object.keys(row).some(key => key !== "itemIds")
    || row.itemIds.some(id => !candidates.includes(id)) || new Set(row.itemIds).size !== row.itemIds.length) {
    throw new Error("selection must contain distinct offered items");
  }
  return { itemIds: row.itemIds };
}
function receipt(value: unknown) {
  const row = value as { outfitId: string; itemIds: string[] };
  if (!row || typeof row.outfitId !== "string" || !row.outfitId || !Array.isArray(row.itemIds)
    || !row.itemIds.length || row.itemIds.some(id => typeof id !== "string" || !id)) throw new Error("invalid outfit receipt");
  return row;
}

export function selectionApp(db: SqliteDatabase, provider: ModelProvider, sink: DeliverySink) {
  const allowed = (ownerId: string) => (db.prepare("SELECT allowed FROM owners WHERE id=?").get(ownerId) as { allowed: number })?.allowed === 1;
  const owned = (id: string, ownerId: string) => db.prepare("SELECT id,description FROM items WHERE id=? AND owner_id=?").get(id, ownerId);
  const runtime = new SmallHourRuntime({ provider,
    persona: new StaticPersonaSource("Select an outfit from the supplied items for the requested occasion."),
    memory: new EmptyMemorySource(), maxModelCalls: 1, retry: { attempts: 1, delayMs: () => 0 },
  });
  const create: TaskWorkflow<SqliteDatabase> = { kind: "select-outfit", version: "1",
    authorize(context) {
      const request = input(context.task.input);
      if (context.task.scope !== `owner:${request.ownerId}`) return { status: "rejected", reason: "owner_mismatch" };
      if (!allowed(request.ownerId)) return { status: "rejected", reason: "permission_revoked" };
      if (context.stepId !== "save") return { status: "allow" };
      const candidates = selection((context.results.select as { value: unknown }).value, request.candidateIds).itemIds;
      return candidates.every(id => owned(id, request.ownerId))
        ? { status: "allow" } : { status: "rejected", reason: "items_unavailable" };
    },
    steps: [
      { id: "select", kind: "model", prepare(context) {
        const request = input(context.task.input);
        const items = request.candidateIds.map(id => owned(id, request.ownerId));
        if (items.some(item => !item)) throw new Error("items_unavailable");
        return { runtime, input: { agentId: request.ownerId,
          input: JSON.stringify({ request: request.request, items }),
          structuredOutput: {
            schema: { type: "object", properties: { itemIds: { type: "array", items: { type: "string", enum: request.candidateIds } } },
              required: ["itemIds"], additionalProperties: false },
            parse: value => selection(value, request.candidateIds),
          },
        } };
      } },
      { id: "save", kind: "local", parseResult: receipt, execute(connection, context) {
        const request = input(context.task.input);
        const chosen = selection((context.results.select as { value: unknown }).value, request.candidateIds);
        const saved = { outfitId: context.task.id, itemIds: chosen.itemIds };
        connection.prepare("INSERT INTO outfits VALUES (?,?,?)").run(saved.outfitId, request.ownerId, JSON.stringify(saved.itemIds));
        runner.enqueue({ scope: context.task.scope, id: `${context.task.id}:delivery`, kind: "deliver-outfit", version: "1",
          input: { ownerId: request.ownerId, ...saved } }, { concurrencyScope: `inbox:${request.ownerId}`, dueAt: 100, maxAttempts: 3 });
        return saved;
      } },
    ],
  };
  const deliver: TaskWorkflow<SqliteDatabase> = { kind: "deliver-outfit", version: "1",
    authorize(context) {
      const product = context.task.input as { ownerId: string };
      if (context.task.scope !== `owner:${product.ownerId}`) return { status: "rejected", reason: "owner_mismatch" };
      return allowed(product.ownerId) ? { status: "allow" } : { status: "rejected", reason: "permission_revoked" };
    }, steps: [{ id: "deliver", kind: "delivery", sink }],
  };
  const runner = new SqliteTaskRunner(db, [create, deliver], { now: () => 100, leaseMs: 1000 });
  runner.initialize();
  return runner;
}
