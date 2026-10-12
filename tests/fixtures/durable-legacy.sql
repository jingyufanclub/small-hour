CREATE TABLE effects (value TEXT NOT NULL);
INSERT INTO effects (value) VALUES ('saved');
INSERT INTO effects (value) VALUES ('task');
CREATE TABLE small_hour_deliveries (
      scope TEXT NOT NULL, id TEXT NOT NULL, attempts_json TEXT NOT NULL, format_version INTEGER NOT NULL,
      PRIMARY KEY (scope, id)
    );
INSERT INTO small_hour_deliveries (scope, id, attempts_json, format_version) VALUES ('app', 'delivery-task', '[{"id":"d32c6da1-a734-4e50-a157-e9d65f0e8729","outcome":{"receipt":{"evidence":"receipt","id":"remote-7"},"status":"accepted"}}]', 1);
CREATE TABLE small_hour_model_spend (
      call_id TEXT PRIMARY KEY NOT NULL,
      context_json TEXT NOT NULL,
      quote_json TEXT NOT NULL,
      reserved_amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      charged_amount INTEGER,
      record_json TEXT,
      resolution_json TEXT,
      format_version INTEGER NOT NULL,
      CHECK (typeof(reserved_amount) = 'integer' AND reserved_amount BETWEEN 0 AND 9007199254740991
  AND ((status IN ('reserved', 'unknown') AND charged_amount IS NULL)
    OR (status = 'accepted' AND typeof(charged_amount) = 'integer' AND charged_amount BETWEEN 0 AND 9007199254740991)
    OR (status IN ('rejected', 'denied') AND charged_amount = 0)))
      );
INSERT INTO small_hour_model_spend (call_id, context_json, quote_json, reserved_amount, status, charged_amount, record_json, resolution_json, format_version) VALUES ('call', '{"agentId":"app","attempt":1,"callId":"call","hop":0,"maxTokens":100,"model":"fixture","provider":"fixture","turnId":"turn"}', '{"amount":10,"pricing":null,"scopes":[{"limit":20,"scope":"account"},{"limit":20,"scope":"service"}]}', 10, 'unknown', NULL, '{"accounting":"unrecorded","attempt":1,"callId":"call","hop":0,"provider":"fixture","status":"unknown"}', NULL, 2);
CREATE TABLE small_hour_model_spend_scopes (
        call_id TEXT NOT NULL REFERENCES small_hour_model_spend(call_id) ON DELETE RESTRICT,
        scope TEXT NOT NULL, PRIMARY KEY (call_id, scope)
      );
INSERT INTO small_hour_model_spend_scopes (call_id, scope) VALUES ('call', 'account');
INSERT INTO small_hour_model_spend_scopes (call_id, scope) VALUES ('call', 'service');
CREATE TABLE small_hour_model_steps (
      scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
      input_json TEXT NOT NULL, turn_json TEXT NOT NULL, attempt_id TEXT NOT NULL,
      status TEXT NOT NULL, report_json TEXT NOT NULL, result_json TEXT, error_code TEXT,
      format_version INTEGER NOT NULL, PRIMARY KEY (scope, id)
    );
INSERT INTO small_hour_model_steps (scope, id, kind, version, input_json, turn_json, attempt_id, status, report_json, result_json, error_code, format_version) VALUES ('app', 'model', 'compose', '1', '{"item":"item-7"}', '{"agentId":"app","allowedTools":[],"input":"Use item-7."}', 'ed6f575f-0eb5-4b1d-be32-746fcf161101', 'completed', '{"agentId":"app","hops":1,"modelCalls":[{"accounting":"unrecorded","attempt":1,"callId":"51670871-4367-4e0f-b992-31b5c659ab55","hop":1,"provider":"fixture","status":"responded","stop":{"reason":"end_turn"}}],"toolCalls":[],"turnId":"ed6f575f-0eb5-4b1d-be32-746fcf161101","usage":[]}', '{"accepted":true,"agentId":"app","finishReason":"end_turn","hops":1,"issues":[],"modelCalls":[{"accounting":"unrecorded","attempt":1,"callId":"51670871-4367-4e0f-b992-31b5c659ab55","hop":1,"provider":"fixture","status":"responded","stop":{"reason":"end_turn"}}],"output":"item-7","status":"reply","toolCalls":[],"turnId":"ed6f575f-0eb5-4b1d-be32-746fcf161101","usage":[]}', NULL, 1);
INSERT INTO small_hour_model_steps (scope, id, kind, version, input_json, turn_json, attempt_id, status, report_json, result_json, error_code, format_version) VALUES ('app', 'recover', 'compose', '1', '{"item":"item-7"}', '{"recovery":{"maxAttempts":3,"maxModelCalls":3,"sideEffectFree":true},"turn":{"agentId":"app","allowedTools":[],"input":"Use item-7."},"turnId":"94c92991-3711-4745-9622-3445794569e0"}', '94c92991-3711-4745-9622-3445794569e0', 'failed', '{"attempts":[],"report":{"agentId":"app","hops":1,"modelCalls":[{"accounting":"unrecorded","attempt":1,"callId":"3d6495ff-4435-450a-99ec-b2097489f177","hop":1,"provider":"fixture","status":"responded","stop":{"reason":"max_tokens"}}],"toolCalls":[],"turnId":"94c92991-3711-4745-9622-3445794569e0","usage":[]}}', NULL, 'incomplete_stop', 2);
CREATE TABLE small_hour_operation_receipts (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      version TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      format_version INTEGER NOT NULL,
      PRIMARY KEY (scope, id)
    );
INSERT INTO small_hour_operation_receipts (scope, id, kind, version, input_json, result_json, format_version) VALUES ('app', 'local', 'compose', '1', '{"item":"item-7"}', '"saved"', 1);
INSERT INTO small_hour_operation_receipts (scope, id, kind, version, input_json, result_json, format_version) VALUES ('["small-hour-task","app","completed-task"]', 'save', 'compose', '1', '{"input":{"item":"item-7"},"steps":[{"id":"save","kind":"local"}]}', '"task"', 1);
CREATE TABLE small_hour_tasks (
      scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
      input_json TEXT NOT NULL, plan_json TEXT NOT NULL, schedule_json TEXT NOT NULL,
      concurrency_scope TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL,
      status TEXT NOT NULL, token TEXT, lease_until INTEGER, reason TEXT, cancellation_reason TEXT,
      resolution_json TEXT, format_version INTEGER NOT NULL, PRIMARY KEY (scope, id)
    );
INSERT INTO small_hour_tasks (scope, id, kind, version, input_json, plan_json, schedule_json, concurrency_scope, due_at, attempts, status, token, lease_until, reason, cancellation_reason, resolution_json, format_version) VALUES ('app', 'completed-task', 'compose', '1', '{"item":"item-7"}', '[{"id":"save","kind":"local"}]', '{"concurrencyScope":"app","dueAt":100,"maxAttempts":4}', 'app', 100, 1, 'completed', NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO small_hour_tasks (scope, id, kind, version, input_json, plan_json, schedule_json, concurrency_scope, due_at, attempts, status, token, lease_until, reason, cancellation_reason, resolution_json, format_version) VALUES ('app', 'delivery-task', 'deliver', '1', '{"item":"item-7"}', '[{"id":"send","idempotency":"key","kind":"delivery","reconciliation":false}]', '{"concurrencyScope":"app","dueAt":100,"maxAttempts":4}', 'app', 100, 1, 'completed', NULL, NULL, NULL, NULL, NULL, 1);
INSERT INTO small_hour_tasks (scope, id, kind, version, input_json, plan_json, schedule_json, concurrency_scope, due_at, attempts, status, token, lease_until, reason, cancellation_reason, resolution_json, format_version) VALUES ('app', 'queued-task', 'compose', '1', '{"item":"item-7"}', '[{"id":"save","kind":"local"}]', '{"concurrencyScope":"app","dueAt":100,"maxAttempts":4}', 'app', 100, 0, 'queued', NULL, NULL, NULL, NULL, NULL, 1);
CREATE INDEX small_hour_model_spend_scopes_lookup ON small_hour_model_spend_scopes (scope, call_id);
CREATE INDEX small_hour_tasks_due ON small_hour_tasks (kind, version, status, due_at);
CREATE INDEX small_hour_tasks_scope ON small_hour_tasks (concurrency_scope, status);
