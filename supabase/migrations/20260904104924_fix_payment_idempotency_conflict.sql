-- ON CONFLICT (idempotency_key) requires a matching non-partial unique index.
-- PostgreSQL's default NULLS DISTINCT behavior still permits legacy NULL keys.
DROP INDEX IF EXISTS public.payments_idempotency_key_uniq;

CREATE UNIQUE INDEX payments_idempotency_key_uniq
  ON public.payments (idempotency_key);
