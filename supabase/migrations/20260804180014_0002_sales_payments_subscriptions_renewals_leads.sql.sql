/*
# DigiXO Desk — Sales, Payments, Subscriptions, Renewals, Leads

## Purpose
Transaction tables for the DigiXO workflow:
Enquiry -> Customer -> Sale -> Payment -> Activation -> Subscription -> Renewal.

## New Tables
1. `sales` — one customer purchasing one product plan (historical, snapshot-based)
   - sale_number is a human-friendly unique number (S-000001 format)
   - snapshots of product/plan names, prices, duration so historical sales
     never change when products are renamed or repriced
   - net_profit is computed by RPC, not stored, from:
     final_selling_price - cost_price_snapshot - payment_fee - refund_amount - replacement_cost
2. `payments` — full and partial payments against a sale
3. `subscriptions` — created only for recurring sales
4. `renewals` — renewal tracking with idempotency guard
5. `leads` — pre-sale enquiry tracking

## Security
- RLS enabled on every table.
- Active users can read/insert/update; hard deletes owner-only.
- Owner-only financial aggregates are enforced via RPC, not table SELECT policy.

## Notes
1. sale_number is auto-generated via a sequence + trigger.
2. A unique partial index on renewals prevents duplicate new sales per renewal.
3. All money is numeric(12,2); CHECK prevents negatives.
*/

-- =========================================================
-- sales
-- =========================================================

CREATE SEQUENCE IF NOT EXISTS public.sale_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_number text NOT NULL UNIQUE DEFAULT 'S-000000',
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_plan_id uuid REFERENCES public.product_plans(id) ON DELETE SET NULL,
  product_name_snapshot text NOT NULL,
  plan_name_snapshot text NOT NULL,
  purchase_type_snapshot text NOT NULL CHECK (purchase_type_snapshot IN ('one_time','recurring')),
  duration_days_snapshot integer,
  list_price_snapshot numeric(12,2),
  cost_price_snapshot numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost_price_snapshot >= 0),
  final_selling_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (final_selling_price >= 0),
  payment_fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (payment_fee >= 0),
  refund_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  replacement_cost numeric(12,2) NOT NULL DEFAULT 0 CHECK (replacement_cost >= 0),
  sale_date date NOT NULL DEFAULT CURRENT_DATE,
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','partial','paid','refunded','partially_refunded','cancelled')),
  fulfilment_status text NOT NULL DEFAULT 'payment_confirmation' CHECK (fulfilment_status IN ('payment_confirmation','activation_pending','processing','activated','replacement_required','completed','cancelled')),
  payment_method text,
  transaction_reference text,
  subscription_start_date date,
  renewal_date date,
  warranty_end_date date,
  note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_sales_customer ON public.sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_plan ON public.sales (product_plan_id);
CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON public.sales (sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_payment_status ON public.sales (payment_status);
CREATE INDEX IF NOT EXISTS idx_sales_fulfilment_status ON public.sales (fulfilment_status);
CREATE INDEX IF NOT EXISTS idx_sales_created_by ON public.sales (created_by);
CREATE INDEX IF NOT EXISTS idx_sales_renewal_date ON public.sales (renewal_date);
CREATE INDEX IF NOT EXISTS idx_sales_archived ON public.sales (archived_at);

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sales_select_active" ON public.sales;
CREATE POLICY "sales_select_active" ON public.sales
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "sales_insert_active" ON public.sales;
CREATE POLICY "sales_insert_active" ON public.sales
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "sales_update_active" ON public.sales;
CREATE POLICY "sales_update_active" ON public.sales
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "sales_delete_owner" ON public.sales;
CREATE POLICY "sales_delete_owner" ON public.sales
  FOR DELETE TO authenticated USING (public.is_owner());

-- sale_number auto-generation trigger
CREATE OR REPLACE FUNCTION public.assign_sale_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sale_number IS NULL OR NEW.sale_number = 'S-000000' THEN
    NEW.sale_number := 'S-' || lpad(nextval('public.sale_number_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_sale_number ON public.sales;
CREATE TRIGGER trg_sales_sale_number BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.assign_sale_number();

DROP TRIGGER IF EXISTS trg_sales_updated ON public.sales;
CREATE TRIGGER trg_sales_updated BEFORE UPDATE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- payments
-- =========================================================

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  payment_method text,
  transaction_reference text,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','bounced','reversed')),
  note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_payments_sale ON public.payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON public.payments (payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments (status);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_select_active" ON public.payments;
CREATE POLICY "payments_select_active" ON public.payments
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "payments_insert_active" ON public.payments;
CREATE POLICY "payments_insert_active" ON public.payments
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "payments_update_active" ON public.payments;
CREATE POLICY "payments_update_active" ON public.payments
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "payments_delete_owner" ON public.payments;
CREATE POLICY "payments_delete_owner" ON public.payments
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- subscriptions
-- =========================================================

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  original_sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  current_sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  product_plan_id uuid REFERENCES public.product_plans(id) ON DELETE SET NULL,
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','due','overdue','renewed','lapsed','cancelled')),
  next_renewal_date date,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_subs_customer ON public.subscriptions (customer_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON public.subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_subs_next_renewal ON public.subscriptions (next_renewal_date);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subs_select_active" ON public.subscriptions;
CREATE POLICY "subs_select_active" ON public.subscriptions
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "subs_insert_active" ON public.subscriptions;
CREATE POLICY "subs_insert_active" ON public.subscriptions
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "subs_update_active" ON public.subscriptions;
CREATE POLICY "subs_update_active" ON public.subscriptions
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "subs_delete_owner" ON public.subscriptions;
CREATE POLICY "subs_delete_owner" ON public.subscriptions
  FOR DELETE TO authenticated USING (public.is_owner());

DROP TRIGGER IF EXISTS trg_subs_updated ON public.subscriptions;
CREATE TRIGGER trg_subs_updated BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- renewals
-- =========================================================

CREATE TABLE IF NOT EXISTS public.renewals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reminded','interested','awaiting_payment','snoozed','renewed','no_response','not_renewing')),
  snoozed_until date,
  reminder_opened_at timestamptz,
  reminded_at timestamptz,
  renewed_at timestamptz,
  linked_new_sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_renewals_subscription ON public.renewals (subscription_id);
CREATE INDEX IF NOT EXISTS idx_renewals_customer ON public.renewals (customer_id);
CREATE INDEX IF NOT EXISTS idx_renewals_due_date ON public.renewals (due_date);
CREATE INDEX IF NOT EXISTS idx_renewals_status ON public.renewals (status);
CREATE INDEX IF NOT EXISTS idx_renewals_linked_sale ON public.renewals (linked_new_sale_id);

-- Idempotency: a renewal can only be linked to one new sale
CREATE UNIQUE INDEX IF NOT EXISTS idx_renewals_linked_sale_unique
  ON public.renewals (linked_new_sale_id)
  WHERE linked_new_sale_id IS NOT NULL;

ALTER TABLE public.renewals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "renewals_select_active" ON public.renewals;
CREATE POLICY "renewals_select_active" ON public.renewals
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "renewals_insert_active" ON public.renewals;
CREATE POLICY "renewals_insert_active" ON public.renewals
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "renewals_update_active" ON public.renewals;
CREATE POLICY "renewals_update_active" ON public.renewals
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "renewals_delete_owner" ON public.renewals;
CREATE POLICY "renewals_delete_owner" ON public.renewals
  FOR DELETE TO authenticated USING (public.is_owner());

DROP TRIGGER IF EXISTS trg_renewals_updated ON public.renewals;
CREATE TRIGGER trg_renewals_updated BEFORE UPDATE ON public.renewals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- leads
-- =========================================================

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  interested_product text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','follow_up','interested','awaiting_payment','won','lost','follow_up_later')),
  next_follow_up_at timestamptz,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_leads_customer ON public.leads (customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON public.leads (assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON public.leads (next_follow_up_at);

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leads_select_active" ON public.leads;
CREATE POLICY "leads_select_active" ON public.leads
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "leads_insert_active" ON public.leads;
CREATE POLICY "leads_insert_active" ON public.leads
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "leads_update_active" ON public.leads;
CREATE POLICY "leads_update_active" ON public.leads
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "leads_delete_owner" ON public.leads;
CREATE POLICY "leads_delete_owner" ON public.leads
  FOR DELETE TO authenticated USING (public.is_owner());

DROP TRIGGER IF EXISTS trg_leads_updated ON public.leads;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
