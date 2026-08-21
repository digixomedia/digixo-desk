-- Add index for idempotency table FK
CREATE INDEX IF NOT EXISTS idx_api_idempotency_api_key_id
  ON internal.api_idempotency_records (api_key_id)
  WHERE api_key_id IS NOT NULL;
