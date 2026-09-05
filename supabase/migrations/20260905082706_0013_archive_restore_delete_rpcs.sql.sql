/*
# Archive, Restore, and Hard-Delete RPCs

## Overview
Adds reusable server-side functions to archive (soft-delete), restore, and hard-delete records.
Also adds `archived_at` columns to tables that lack it (renewals, expenses).

## New Functions

1. `archive_record(p_table text, p_record_id uuid)`
   — Sets `archived_at = now()` on the specified table for the given record ID.
   — Owner-only. Validates table name against an allowlist.

2. `restore_record(p_table text, p_record_id uuid)`
   — Clears `archived_at` back to NULL. Owner-only.

3. `hard_delete_record(p_table text, p_record_id uuid)`
   — Permanently deletes a record. Owner-only.
   — For tables with financial dependencies (sales, customers, products), checks that no dependent records exist first.
   — For independent records (categories, product_plans, expenses, renewals), deletes directly.

## Schema Changes
- Adds `archived_at timestamptz` to `renewals` and `expenses` tables.

## Security
- All functions SECURITY DEFINER, search_path = public.
- Owner-only via `is_owner()` check.
- Table name validated against an allowlist to prevent SQL injection.
*/

-- Add archived_at to tables that lack it
ALTER TABLE public.renewals ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Create indexes for archived_at on new columns
CREATE INDEX IF NOT EXISTS idx_renewals_archived ON public.renewals (archived_at);
CREATE INDEX IF NOT EXISTS idx_expenses_archived ON public.expenses (archived_at);

-- =========================================================
-- archive_record
-- =========================================================
CREATE OR REPLACE FUNCTION public.archive_record(
  p_table text,
  p_record_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can archive records';
  END IF;

  SELECT p_table IN (
    'customers', 'categories', 'products', 'product_plans',
    'sales', 'renewals', 'expenses'
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Archiving is not supported for table: %', p_table;
  END IF;

  EXECUTE format('UPDATE public.%I SET archived_at = now(), updated_at = now() WHERE id = $1', p_table)
    USING p_record_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.archive_record(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_record(text, uuid) TO authenticated;

-- =========================================================
-- restore_record
-- =========================================================
CREATE OR REPLACE FUNCTION public.restore_record(
  p_table text,
  p_record_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can restore records';
  END IF;

  SELECT p_table IN (
    'customers', 'categories', 'products', 'product_plans',
    'sales', 'renewals', 'expenses'
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Restoring is not supported for table: %', p_table;
  END IF;

  EXECUTE format('UPDATE public.%I SET archived_at = NULL, updated_at = now() WHERE id = $1', p_table)
    USING p_record_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.restore_record(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_record(text, uuid) TO authenticated;

-- =========================================================
-- hard_delete_record
-- =========================================================
CREATE OR REPLACE FUNCTION public.hard_delete_record(
  p_table text,
  p_record_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can permanently delete records';
  END IF;

  -- For tables with financial dependencies, check for child records
  IF p_table = 'customers' THEN
    SELECT count(*) INTO v_count FROM public.sales WHERE customer_id = p_record_id;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete customer with % existing sale(s). Archive instead.', v_count;
    END IF;
    DELETE FROM public.customers WHERE id = p_record_id;

  ELSIF p_table = 'products' THEN
    SELECT count(*) INTO v_count FROM public.sales WHERE product_id = p_record_id;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete product with % existing sale(s). Archive instead.', v_count;
    END IF;
    DELETE FROM public.product_plans WHERE product_id = p_record_id;
    DELETE FROM public.products WHERE id = p_record_id;

  ELSIF p_table = 'product_plans' THEN
    SELECT count(*) INTO v_count FROM public.sales WHERE product_plan_id = p_record_id;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete plan with % existing sale(s). Archive instead.', v_count;
    END IF;
    DELETE FROM public.product_plans WHERE id = p_record_id;

  ELSIF p_table = 'categories' THEN
    SELECT count(*) INTO v_count FROM public.products WHERE category_id = p_record_id;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete category with % existing product(s). Archive instead.', v_count;
    END IF;
    DELETE FROM public.categories WHERE id = p_record_id;

  ELSIF p_table = 'sales' THEN
    SELECT count(*) INTO v_count FROM public.payments WHERE sale_id = p_record_id;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Cannot delete sale with % payment record(s). Archive instead.', v_count;
    END IF;
    DELETE FROM public.renewals WHERE sale_id = p_record_id;
    DELETE FROM public.subscriptions WHERE current_sale_id = p_record_id;
    DELETE FROM public.sales WHERE id = p_record_id;

  ELSIF p_table = 'renewals' THEN
    DELETE FROM public.renewals WHERE id = p_record_id;

  ELSIF p_table = 'expenses' THEN
    DELETE FROM public.expenses WHERE id = p_record_id;

  ELSE
    RAISE EXCEPTION 'Hard delete is not supported for table: %', p_table;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hard_delete_record(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hard_delete_record(text, uuid) TO authenticated;
