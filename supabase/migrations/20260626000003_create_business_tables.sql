-- =============================================================================
-- Migration: 003 — Business Tables
-- products, product_categories, customers, sales_orders, sales_order_items,
-- audit_logs, settings
-- =============================================================================

-- ---------------------------------------------------------------------------
-- product_categories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_categories (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  parent_id  UUID         REFERENCES public.product_categories (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name, parent_id)
);

CREATE INDEX idx_product_categories_company_id ON public.product_categories (company_id);

CREATE TRIGGER trg_product_categories_updated_at
  BEFORE UPDATE ON public.product_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.products (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sku            VARCHAR(100)  NOT NULL,
  name           VARCHAR(255)  NOT NULL,
  description    TEXT,
  category_id    UUID          REFERENCES public.product_categories (id) ON DELETE SET NULL,
  price          NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost           NUMERIC(15,2)           CHECK (cost >= 0),
  unit           VARCHAR(50)   NOT NULL DEFAULT 'pcs',
  stock_quantity INTEGER       NOT NULL DEFAULT 0,
  min_stock      INTEGER       NOT NULL DEFAULT 0,
  is_active      BOOLEAN       NOT NULL DEFAULT TRUE,
  custom_fields  JSONB         NOT NULL DEFAULT '{}',
  created_by     UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, sku)
);

CREATE INDEX idx_products_company_id  ON public.products (company_id);
CREATE INDEX idx_products_category_id ON public.products (category_id);
CREATE INDEX idx_products_is_active   ON public.products (company_id, is_active);
CREATE INDEX idx_products_custom_fields ON public.products USING GIN (custom_fields);

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.products.custom_fields IS 'Schema-flexible: tenant-specific extra fields';

-- ---------------------------------------------------------------------------
-- customers (resellers)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.customers (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  code              VARCHAR(50)   NOT NULL,
  name              VARCHAR(255)  NOT NULL,
  type              VARCHAR(50)   NOT NULL DEFAULT 'reseller'
                      CHECK (type IN ('reseller','direct','distributor','modern_trade')),
  phone             VARCHAR(50),
  email             VARCHAR(255),
  address           TEXT,
  area              VARCHAR(100),
  assigned_sales_id UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  last_order_at     TIMESTAMPTZ,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  custom_fields     JSONB         NOT NULL DEFAULT '{}',
  created_by        UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE INDEX idx_customers_company_id        ON public.customers (company_id);
CREATE INDEX idx_customers_assigned_sales_id ON public.customers (assigned_sales_id);
CREATE INDEX idx_customers_last_order_at     ON public.customers (company_id, last_order_at);
CREATE INDEX idx_customers_is_active         ON public.customers (company_id, is_active);
CREATE INDEX idx_customers_custom_fields     ON public.customers USING GIN (custom_fields);

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- sales_orders
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  order_number    VARCHAR(50)   NOT NULL,
  customer_id     UUID          NOT NULL REFERENCES public.customers (id),
  sales_id        UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  status          VARCHAR(50)   NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','confirmed','processing','delivering','delivered','invoiced','paid','cancelled')),
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  final_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  delivery_date   DATE,
  delivered_at    TIMESTAMPTZ,
  custom_fields   JSONB         NOT NULL DEFAULT '{}',
  created_by      UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, order_number)
);

CREATE INDEX idx_sales_orders_company_id   ON public.sales_orders (company_id);
CREATE INDEX idx_sales_orders_customer_id  ON public.sales_orders (customer_id);
CREATE INDEX idx_sales_orders_sales_id     ON public.sales_orders (sales_id);
CREATE INDEX idx_sales_orders_status       ON public.sales_orders (company_id, status);
CREATE INDEX idx_sales_orders_created_at   ON public.sales_orders (company_id, created_at DESC);

CREATE TRIGGER trg_sales_orders_updated_at
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-update customers.last_order_at on new confirmed/delivered order
CREATE OR REPLACE FUNCTION public.update_customer_last_order()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('confirmed', 'delivered', 'paid') THEN
    UPDATE public.customers
    SET last_order_at = NOW(), updated_at = NOW()
    WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_sales_orders_update_customer
  AFTER INSERT OR UPDATE OF status ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_customer_last_order();

-- ---------------------------------------------------------------------------
-- sales_order_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_order_items (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  product_id      UUID          NOT NULL REFERENCES public.products (id),
  quantity        INTEGER       NOT NULL CHECK (quantity > 0),
  unit_price      NUMERIC(15,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(15,2) NOT NULL CHECK (total_amount >= 0),
  notes           TEXT
);

CREATE INDEX idx_order_items_order_id   ON public.sales_order_items (order_id);
CREATE INDEX idx_order_items_product_id ON public.sales_order_items (product_id);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  user_id     UUID        REFERENCES public.users (id) ON DELETE SET NULL,
  action      VARCHAR(50) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id   UUID,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  VARCHAR(45),
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_company_id  ON public.audit_logs (company_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity      ON public.audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_user_id     ON public.audit_logs (user_id);

COMMENT ON TABLE public.audit_logs IS 'Immutable audit trail — no UPDATE or DELETE allowed via RLS';

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.settings (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID        NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  key        VARCHAR(100) NOT NULL,
  value      JSONB        NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, key)
);

CREATE INDEX idx_settings_company_id ON public.settings (company_id);

CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE  public.settings       IS 'Tenant-level key/value configuration store';
COMMENT ON COLUMN public.settings.value IS 'JSON value — can be string, number, boolean, or object';
