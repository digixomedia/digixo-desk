/*
# DigiXO Desk — Expenses, Support, Templates, Activity Logs

## Purpose
Owner-only expenses, support/warranty cases, WhatsApp message templates, and
immutable activity logs.

## New Tables
1. `expenses` — Owner-only financial expense records
2. `support_cases` — warranty/support tracking linked to customer + sale
3. `message_templates` — reusable WhatsApp/message templates with variables
4. `activity_logs` — immutable audit trail of important actions

## Security
- expenses: SELECT owner-only; INSERT/UPDATE/DELETE owner-only.
- support_cases: active users can read/insert/update; delete owner-only.
- message_templates: active users can read; insert/update owner-only; delete owner-only.
- activity_logs: active users can read; INSERT via SECURITY DEFINER function
  (so any active user can log); UPDATE/DELETE owner-only.

## Notes
1. Activity logs are written via a SECURITY DEFINER RPC `log_activity()` so that
   the insert always succeeds regardless of the caller's direct table privileges.
2. All money is numeric(12,2).
*/

-- =========================================================
-- expenses
-- =========================================================

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  category text NOT NULL,
  description text,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  payment_method text,
  reference text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON public.expenses (expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON public.expenses (category);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expenses_select_owner" ON public.expenses;
CREATE POLICY "expenses_select_owner" ON public.expenses
  FOR SELECT TO authenticated USING (public.is_owner());

DROP POLICY IF EXISTS "expenses_insert_owner" ON public.expenses;
CREATE POLICY "expenses_insert_owner" ON public.expenses
  FOR INSERT TO authenticated WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "expenses_update_owner" ON public.expenses;
CREATE POLICY "expenses_update_owner" ON public.expenses
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "expenses_delete_owner" ON public.expenses;
CREATE POLICY "expenses_delete_owner" ON public.expenses
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- support_cases
-- =========================================================

CREATE TABLE IF NOT EXISTS public.support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  issue text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  replacement_cost numeric(12,2) NOT NULL DEFAULT 0 CHECK (replacement_cost >= 0),
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_support_customer ON public.support_cases (customer_id);
CREATE INDEX IF NOT EXISTS idx_support_sale ON public.support_cases (sale_id);
CREATE INDEX IF NOT EXISTS idx_support_status ON public.support_cases (status);

ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_select_active" ON public.support_cases;
CREATE POLICY "support_select_active" ON public.support_cases
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "support_insert_active" ON public.support_cases;
CREATE POLICY "support_insert_active" ON public.support_cases
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "support_update_active" ON public.support_cases;
CREATE POLICY "support_update_active" ON public.support_cases
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "support_delete_owner" ON public.support_cases;
CREATE POLICY "support_delete_owner" ON public.support_cases
  FOR DELETE TO authenticated USING (public.is_owner());

DROP TRIGGER IF EXISTS trg_support_updated ON public.support_cases;
CREATE TRIGGER trg_support_updated BEFORE UPDATE ON public.support_cases
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- message_templates
-- =========================================================

CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type text NOT NULL DEFAULT 'general',
  name text NOT NULL,
  content text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_templates_type ON public.message_templates (template_type);
CREATE INDEX IF NOT EXISTS idx_templates_active ON public.message_templates (is_active);

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "templates_select_active" ON public.message_templates;
CREATE POLICY "templates_select_active" ON public.message_templates
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "templates_insert_owner" ON public.message_templates;
CREATE POLICY "templates_insert_owner" ON public.message_templates
  FOR INSERT TO authenticated WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "templates_update_owner" ON public.message_templates;
CREATE POLICY "templates_update_owner" ON public.message_templates
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "templates_delete_owner" ON public.message_templates;
CREATE POLICY "templates_delete_owner" ON public.message_templates
  FOR DELETE TO authenticated USING (public.is_owner());

DROP TRIGGER IF EXISTS trg_templates_updated ON public.message_templates;
CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- activity_logs
-- =========================================================

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  description text,
  entity_type text,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_user ON public.activity_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_logs_entity ON public.activity_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON public.activity_logs (created_at);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "logs_select_active" ON public.activity_logs;
CREATE POLICY "logs_select_active" ON public.activity_logs
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "logs_insert_active" ON public.activity_logs;
CREATE POLICY "logs_insert_active" ON public.activity_logs
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "logs_update_owner" ON public.activity_logs;
CREATE POLICY "logs_update_owner" ON public.activity_logs
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "logs_delete_owner" ON public.activity_logs;
CREATE POLICY "logs_delete_owner" ON public.activity_logs
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- log_activity() — SECURITY DEFINER helper
-- =========================================================

CREATE OR REPLACE FUNCTION public.log_activity(
  p_action text,
  p_description text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_before_data jsonb DEFAULT NULL,
  p_after_data jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log_id uuid;
BEGIN
  INSERT INTO public.activity_logs (user_id, action, description, entity_type, entity_id, before_data, after_data)
  VALUES (auth.uid(), p_action, p_description, p_entity_type, p_entity_id, p_before_data, p_after_data)
  RETURNING id INTO v_log_id;
  RETURN v_log_id;
END;
$$;
