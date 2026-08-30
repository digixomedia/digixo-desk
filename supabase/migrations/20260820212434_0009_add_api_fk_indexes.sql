/* Add indexes for foreign keys on api_keys table to improve query performance. */

CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON public.api_keys (created_by);
CREATE INDEX IF NOT EXISTS idx_api_keys_rotated_from ON public.api_keys (rotated_from) WHERE rotated_from IS NOT NULL;
