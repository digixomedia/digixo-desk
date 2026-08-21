/*
# DigiXO Desk — Core Schema: Profiles, Customers, Catalog

## Purpose
Foundational tables: profiles, customers, categories, products, product_plans,
product_price_history. Includes helper functions for role checks and phone
normalisation. RLS enabled on every table.

## Notes
1. profiles created first; helper functions is_owner()/is_active_user() defined
   immediately after, before any policy that references them.
2. Money is numeric(12,2); CHECK constraints prevent negative values.
3. Timestamps are timestamptz (UTC); frontend converts to IST.
*/

-- =========================================================
-- profiles
-- =========================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'manager' CHECK (role IN ('owner','manager')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================
-- Helper functions (defined before any policy uses them)
-- =========================================================

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'owner'
      AND is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.normalize_phone(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(regexp_replace(COALESCE(raw, ''), '[^0-9]', '', 'g'), '^0+', '')
$$;

-- =========================================================
-- profiles RLS
-- =========================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles;
CREATE POLICY "profiles_select_all" ON public.profiles
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "profiles_insert_owner" ON public.profiles;
CREATE POLICY "profiles_insert_owner" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "profiles_update_owner_or_self" ON public.profiles;
CREATE POLICY "profiles_update_owner_or_self" ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_owner() OR auth.uid() = id)
  WITH CHECK (public.is_owner() OR auth.uid() = id);

DROP POLICY IF EXISTS "profiles_delete_owner" ON public.profiles;
CREATE POLICY "profiles_delete_owner" ON public.profiles
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- customers
-- =========================================================

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  phone_country_code text NOT NULL DEFAULT '91',
  phone_normalized text NOT NULL UNIQUE,
  phone_display text,
  email text,
  customer_type text NOT NULL DEFAULT 'retail' CHECK (customer_type IN ('retail','reseller','business')),
  acquisition_source text CHECK (acquisition_source IN ('WhatsApp','Telegram','Website','Referral','Reseller','Other')),
  marketing_allowed boolean NOT NULL DEFAULT true,
  do_not_message boolean NOT NULL DEFAULT false,
  tags text[] DEFAULT '{}',
  internal_note text,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers (phone_normalized);
CREATE INDEX IF NOT EXISTS idx_customers_name ON public.customers (name);
CREATE INDEX IF NOT EXISTS idx_customers_assigned ON public.customers (assigned_to);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON public.customers (created_at);
CREATE INDEX IF NOT EXISTS idx_customers_archived ON public.customers (archived_at);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_select_active" ON public.customers;
CREATE POLICY "customers_select_active" ON public.customers
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "customers_insert_active" ON public.customers;
CREATE POLICY "customers_insert_active" ON public.customers
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "customers_update_active" ON public.customers;
CREATE POLICY "customers_update_active" ON public.customers
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "customers_delete_owner" ON public.customers;
CREATE POLICY "customers_delete_owner" ON public.customers
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- categories
-- =========================================================

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  colour text NOT NULL DEFAULT '#6366f1',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_categories_name ON public.categories (name);

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "categories_select_active" ON public.categories;
CREATE POLICY "categories_select_active" ON public.categories
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "categories_insert_active" ON public.categories;
CREATE POLICY "categories_insert_active" ON public.categories
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "categories_update_active" ON public.categories;
CREATE POLICY "categories_update_active" ON public.categories
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "categories_delete_owner" ON public.categories;
CREATE POLICY "categories_delete_owner" ON public.categories
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- products
-- =========================================================

CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  description text,
  supplier_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_products_name ON public.products (name);
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products (category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON public.products (is_active);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "products_select_active" ON public.products;
CREATE POLICY "products_select_active" ON public.products
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "products_insert_active" ON public.products;
CREATE POLICY "products_insert_active" ON public.products
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "products_update_active" ON public.products;
CREATE POLICY "products_update_active" ON public.products
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "products_delete_owner" ON public.products;
CREATE POLICY "products_delete_owner" ON public.products
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- product_plans
-- =========================================================

CREATE TABLE IF NOT EXISTS public.product_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  plan_name text NOT NULL,
  purchase_type text NOT NULL DEFAULT 'one_time' CHECK (purchase_type IN ('one_time','recurring')),
  duration_days integer,
  warranty_days integer,
  default_cost_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (default_cost_price >= 0),
  default_selling_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (default_selling_price >= 0),
  optional_list_price numeric(12,2) CHECK (optional_list_price IS NULL OR optional_list_price >= 0),
  optional_stock_count integer CHECK (optional_stock_count IS NULL OR optional_stock_count >= 0),
  low_stock_threshold integer DEFAULT 5,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_plans_product ON public.product_plans (product_id);
CREATE INDEX IF NOT EXISTS idx_plans_active ON public.product_plans (is_active);

ALTER TABLE public.product_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plans_select_active" ON public.product_plans;
CREATE POLICY "plans_select_active" ON public.product_plans
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "plans_insert_active" ON public.product_plans;
CREATE POLICY "plans_insert_active" ON public.product_plans
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "plans_update_active" ON public.product_plans;
CREATE POLICY "plans_update_active" ON public.product_plans
  FOR UPDATE TO authenticated
  USING (public.is_active_user())
  WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "plans_delete_owner" ON public.product_plans;
CREATE POLICY "plans_delete_owner" ON public.product_plans
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- product_price_history
-- =========================================================

CREATE TABLE IF NOT EXISTS public.product_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_plan_id uuid NOT NULL REFERENCES public.product_plans(id) ON DELETE CASCADE,
  previous_cost_price numeric(12,2),
  new_cost_price numeric(12,2) NOT NULL,
  previous_selling_price numeric(12,2),
  new_selling_price numeric(12,2) NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_plan ON public.product_price_history (product_plan_id);
CREATE INDEX IF NOT EXISTS idx_price_history_effective ON public.product_price_history (effective_at);

ALTER TABLE public.product_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "price_history_select_active" ON public.product_price_history;
CREATE POLICY "price_history_select_active" ON public.product_price_history
  FOR SELECT TO authenticated USING (public.is_active_user());

DROP POLICY IF EXISTS "price_history_insert_active" ON public.product_price_history;
CREATE POLICY "price_history_insert_active" ON public.product_price_history
  FOR INSERT TO authenticated WITH CHECK (public.is_active_user());

DROP POLICY IF EXISTS "price_history_update_owner" ON public.product_price_history;
CREATE POLICY "price_history_update_owner" ON public.product_price_history
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "price_history_delete_owner" ON public.product_price_history;
CREATE POLICY "price_history_delete_owner" ON public.product_price_history
  FOR DELETE TO authenticated USING (public.is_owner());

-- =========================================================
-- updated_at triggers
-- =========================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated ON public.profiles;
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated ON public.customers;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_products_updated ON public.products;
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_plans_updated ON public.product_plans;
CREATE TRIGGER trg_plans_updated BEFORE UPDATE ON public.product_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
