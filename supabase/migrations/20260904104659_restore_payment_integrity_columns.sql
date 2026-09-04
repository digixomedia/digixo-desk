-- Restore columns required by the payment RPCs and frontend. The API-foundation
-- rebuild removed idempotency_key, and amount_received was referenced without
-- ever being added to the sales table.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS amount_received numeric(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sales_amount_received_nonnegative'
      AND conrelid = 'public.sales'::regclass
  ) THEN
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_amount_received_nonnegative
      CHECK (amount_received >= 0);
  END IF;
END
$$;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uniq
  ON public.payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
