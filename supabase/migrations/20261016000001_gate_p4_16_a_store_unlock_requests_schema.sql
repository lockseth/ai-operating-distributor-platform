-- =============================================================================
-- Gate P4.16-A -- Lock Toko Tertunggak: skema store_unlock_requests +
-- fungsi live-check is_customer_order_locked().
--
-- Konteks (TRACKER.md "Ditunda" 2026-08-19, diklarifikasi penuh 2026-08-23,
-- rencana lengkap ~/.claude/plans/linear-strolling-teacup.md): toko dengan
-- tagihan tertunggak (invoice overdue >= H+3) dikunci dari order baru. Buka-
-- lock lewat pengajuan Sales + approval Owner (bukan otomatis). Approval
-- adalah izin SEKALI PAKAI untuk SATU order berikutnya -- begitu terpakai
-- (consumed_at diisi), toko otomatis ter-lock lagi selama invoice yang sama
-- masih overdue (TIDAK ADA reversal/reactivation, sales wajib ajukan ulang).
--
-- Desain kunci: TIDAK ADA kolom is_locked tersimpan di customers, TIDAK ADA
-- cron job. is_customer_order_locked() adalah LIVE COMPUTATION murni dari
-- invoices.due_date (public.invoice_receivable_balances, foundation
-- 20260826000001) + status store_unlock_requests -- "re-lock otomatis"
-- muncul dari logika ini sendiri, bukan mekanisme terpisah yang perlu
-- disinkronkan.
--
-- Pola tabel/trigger/RLS/REVOKE mengikuti PERSIS special_price_approval_
-- requests (20260923000001 gate 3E-D4-C1, LOCKED) -- satu-satunya beda
-- struktural: tidak ada "order induk" (special price terikat ke SATU sales
-- order), unlock request terikat ke CUSTOMER (bisa dipakai order manapun
-- berikutnya untuk toko itu) -- karena itu invariant requester TIDAK
-- mensyaratkan "sales pemilik order tertentu", cukup role sales aktif tenant
-- yang sama (kontrak Founder eksplisit tidak membatasi ke assigned_sales_id
-- customer -- sales manapun di tenant boleh mengajukan buka kunci toko).
--
-- Kolom consumed_at/consumed_by_order_id BARU (tidak ada padanan di special
-- price) -- ditulis oleh RPC order (Gate P4.16-C, migration terpisah) saat
-- APPROVED unlock request benar-benar dipakai oleh satu order. Trigger
-- invariant di bawah mengizinkan TEPAT SATU transisi tambahan di luar pola
-- special price: APPROVED(consumed_at IS NULL) -> APPROVED(consumed_at
-- diisi sekali) -- field lain immutable pada transisi ini juga.
-- =============================================================================

CREATE TABLE public.store_unlock_requests (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id               UUID          NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  status                    VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by              UUID          NOT NULL REFERENCES public.users (id),
  requested_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  reason                    TEXT,
  idempotency_key           TEXT,
  request_payload_hash      TEXT,
  decided_by                UUID          REFERENCES public.users (id),
  decided_at                TIMESTAMPTZ,
  decision_reason           TEXT,
  decision_idempotency_key  TEXT,
  decision_payload_hash     TEXT,
  consumed_at               TIMESTAMPTZ,
  consumed_by_order_id      UUID          REFERENCES public.sales_orders (id),
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sur_decision_consistency CHECK (
    (status = 'PENDING'  AND decided_by IS NULL     AND decided_at IS NULL)
    OR
    (status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT chk_sur_consumed_only_if_approved CHECK (
    consumed_at IS NULL OR status = 'APPROVED'
  ),
  CONSTRAINT chk_sur_consumed_pair CHECK (
    (consumed_at IS NULL AND consumed_by_order_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_by_order_id IS NOT NULL)
  ),
  UNIQUE (company_id, idempotency_key),
  UNIQUE (company_id, decision_idempotency_key)
);

-- Hanya satu request PENDING aktif per customer (race-safe, backstop kedua
-- setelah lock row FOR UPDATE di RPC submit -- pola identik uq_spar_one_
-- pending_per_order).
CREATE UNIQUE INDEX uq_sur_one_pending_per_customer
  ON public.store_unlock_requests (customer_id)
  WHERE status = 'PENDING';

CREATE INDEX idx_sur_company_id  ON public.store_unlock_requests (company_id);
CREATE INDEX idx_sur_customer_id ON public.store_unlock_requests (customer_id);
CREATE INDEX idx_sur_status      ON public.store_unlock_requests (company_id, status);

COMMENT ON TABLE public.store_unlock_requests IS
  'Gate P4.16-A: pengajuan buka-kunci toko tertunggak. Satu APPROVED row = satu izin SEKALI PAKAI (consumed_at diisi oleh RPC order saat benar-benar dipakai, Gate P4.16-C). Tulis hanya lewat RPC SECURITY DEFINER (Gate P4.16-B) -- INSERT/UPDATE/DELETE di-REVOKE dari authenticated/anon.';
COMMENT ON COLUMN public.store_unlock_requests.consumed_at IS
  'Diisi TEPAT SEKALI oleh create_sales_order_atomic/confirm_sales_order_atomic (Gate P4.16-C) saat exception ini dipakai order baru. Selama masih NULL pada row APPROVED, is_customer_order_locked() menganggap toko TIDAK locked (exception tersedia). Setelah diisi, toko otomatis ter-lock lagi bila invoice yang sama masih overdue -- TIDAK ADA jalur reversal.';

-- -----------------------------------------------------------------------------
-- Trigger invariant -- pola identik enforce_special_price_approval_request_
-- invariants (20260923000001), ditambah satu transisi baru khusus tabel ini:
-- APPROVED(consumed_at NULL) -> APPROVED(consumed_at diisi), field lain WAJIB
-- tidak berubah pada transisi itu.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_store_unlock_request_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = NEW.customer_id AND c.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'AODP_SUR_CUSTOMER_TENANT_MISMATCH: customer_id harus berada pada company yang sama'
        USING ERRCODE = '23514';
    END IF;

    -- Requester: role sales AKTIF tenant sama -- BUKAN "sales pemilik toko
    -- ini" (kontrak Founder: sales manapun di tenant boleh mengajukan buka
    -- kunci toko, tidak dibatasi assigned_sales_id).
    IF NOT EXISTS (
      SELECT 1
      FROM public.users u
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
      JOIN public.roles r ON r.id = ur.role_id
      WHERE u.id = NEW.requested_by
        AND u.company_id = NEW.company_id
        AND u.is_active = TRUE
        AND r.name = 'sales'
    ) THEN
      RAISE EXCEPTION 'AODP_SUR_REQUESTER_NOT_SALES: requested_by harus role sales aktif pada tenant yang sama'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'AODP_SUR_INITIAL_STATUS: pengajuan baru wajib berstatus PENDING'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'AODP_SUR_INITIAL_UNCONSUMED: pengajuan baru tidak boleh langsung berstatus consumed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Transisi A (decide, Gate P4.16-B): PENDING -> APPROVED/REJECTED.
    IF OLD.status = 'PENDING' THEN
      IF NEW.company_id            IS DISTINCT FROM OLD.company_id
         OR NEW.customer_id        IS DISTINCT FROM OLD.customer_id
         OR NEW.requested_by       IS DISTINCT FROM OLD.requested_by
         OR NEW.requested_at       IS DISTINCT FROM OLD.requested_at
         OR NEW.reason             IS DISTINCT FROM OLD.reason
         OR NEW.idempotency_key      IS DISTINCT FROM OLD.idempotency_key
         OR NEW.request_payload_hash IS DISTINCT FROM OLD.request_payload_hash
         OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'AODP_SUR_SNAPSHOT_IMMUTABLE: isi pengajuan tidak dapat diubah setelah dibuat'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.status NOT IN ('APPROVED','REJECTED') THEN
        RAISE EXCEPTION 'AODP_SUR_INVALID_TRANSITION: transisi status hanya PENDING->APPROVED atau PENDING->REJECTED'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_order_id IS NOT NULL THEN
        RAISE EXCEPTION 'AODP_SUR_DECIDE_CANNOT_CONSUME: keputusan tidak boleh langsung mengisi consumed_at'
          USING ERRCODE = '23514';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM public.users u
        JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE u.id = NEW.decided_by
          AND u.company_id = NEW.company_id
          AND u.is_active = TRUE
          AND r.name = 'owner'
      ) THEN
        RAISE EXCEPTION 'AODP_SUR_DECIDER_NOT_OWNER: decided_by harus user owner aktif pada tenant yang sama'
          USING ERRCODE = '23514';
      END IF;

    -- Transisi B (consume, Gate P4.16-C): APPROVED(consumed_at NULL) ->
    -- APPROVED(consumed_at diisi) -- SATU KALI, field lain immutable.
    ELSIF OLD.status = 'APPROVED' AND OLD.consumed_at IS NULL
          AND NEW.status = 'APPROVED' AND NEW.consumed_at IS NOT NULL THEN
      IF NEW.company_id            IS DISTINCT FROM OLD.company_id
         OR NEW.customer_id        IS DISTINCT FROM OLD.customer_id
         OR NEW.requested_by       IS DISTINCT FROM OLD.requested_by
         OR NEW.requested_at       IS DISTINCT FROM OLD.requested_at
         OR NEW.reason             IS DISTINCT FROM OLD.reason
         OR NEW.decided_by         IS DISTINCT FROM OLD.decided_by
         OR NEW.decided_at         IS DISTINCT FROM OLD.decided_at
         OR NEW.decision_reason    IS DISTINCT FROM OLD.decision_reason
         OR NEW.idempotency_key         IS DISTINCT FROM OLD.idempotency_key
         OR NEW.request_payload_hash    IS DISTINCT FROM OLD.request_payload_hash
         OR NEW.decision_idempotency_key IS DISTINCT FROM OLD.decision_idempotency_key
         OR NEW.decision_payload_hash    IS DISTINCT FROM OLD.decision_payload_hash
         OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'AODP_SUR_CONSUME_IMMUTABLE: konsumsi hanya boleh mengisi consumed_at/consumed_by_order_id'
          USING ERRCODE = '23514';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.sales_orders so
        WHERE so.id = NEW.consumed_by_order_id AND so.company_id = NEW.company_id
      ) THEN
        RAISE EXCEPTION 'AODP_SUR_CONSUMED_ORDER_TENANT_MISMATCH: consumed_by_order_id harus order pada tenant yang sama'
          USING ERRCODE = '23514';
      END IF;

    ELSE
      -- Semua transisi lain (termasuk apa pun terhadap row REJECTED, atau
      -- row APPROVED yang sudah consumed) diblokir total -- fail-closed,
      -- konsisten filosofi "keputusan final immutable" special price.
      RAISE EXCEPTION 'AODP_SUR_DECISION_IMMUTABLE: pengajuan yang sudah diputuskan/dikonsumsi tidak dapat diubah lagi'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_store_unlock_request_invariants() IS
  'Gate P4.16-A: INSERT -- tenant match, requester role sales aktif tenant sama, status awal PENDING, belum consumed. UPDATE -- HANYA dua transisi diizinkan: (A) PENDING->APPROVED/REJECTED oleh decider owner aktif tenant sama (snapshot immutable); (B) APPROVED(consumed_at NULL)->APPROVED(consumed_at diisi sekali) oleh RPC order (Gate P4.16-C), field lain immutable. Semua transisi lain diblokir fail-closed.';

DROP TRIGGER IF EXISTS trg_sur_enforce_invariants ON public.store_unlock_requests;
CREATE TRIGGER trg_sur_enforce_invariants
  BEFORE INSERT OR UPDATE ON public.store_unlock_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_store_unlock_request_invariants();

-- -----------------------------------------------------------------------------
-- RLS -- SELECT tenant-scoped (Owner: seluruh tenant; Sales: pengajuan
-- miliknya sendiri). Tidak ada policy INSERT/UPDATE/DELETE -- dikombinasikan
-- dengan REVOKE eksplisit di bawah (pola identik special_price_approval_
-- requests) -- satu-satunya jalur tulis adalah RPC SECURITY DEFINER
-- (Gate P4.16-B/P4.16-C).
-- -----------------------------------------------------------------------------

ALTER TABLE public.store_unlock_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sur_select" ON public.store_unlock_requests
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      EXISTS (
        SELECT 1
        FROM public.users u
        JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE u.id = auth.uid()
          AND u.company_id = public.get_user_company_id()
          AND u.is_active = TRUE
          AND r.name = 'owner'
      )
      OR requested_by = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.store_unlock_requests FROM authenticated, anon;
REVOKE TRUNCATE             ON TABLE public.store_unlock_requests FROM authenticated, anon;

-- -----------------------------------------------------------------------------
-- is_customer_order_locked() -- LIVE COMPUTATION, satu-satunya sumber
-- kebenaran "apakah toko ini terkunci sekarang". TRUE bila ADA invoice
-- outstanding/partially_paid dengan due_date <= H-3 DAN TIDAK ADA store_
-- unlock_requests APPROVED yang belum dikonsumsi untuk customer itu.
--
-- "Re-lock otomatis" (kontrak Founder eksplisit) muncul TANPA mekanisme
-- tambahan: begitu satu-satunya exception unconsumed terpakai (consumed_at
-- diisi oleh RPC order, Gate P4.16-C), NOT EXISTS di bawah kembali gagal,
-- fungsi ini kembali TRUE selama invoice yang sama masih overdue -- tidak
-- perlu cron/job terjadwal apa pun.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_customer_order_locked(
  p_company_id UUID,
  p_customer_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.invoices i
    JOIN public.invoice_receivable_balances b ON b.invoice_id = i.id
    WHERE i.company_id = p_company_id
      AND i.customer_id = p_customer_id
      AND i.due_date IS NOT NULL
      AND i.due_date <= (CURRENT_DATE - 3)
      AND b.financial_status IN ('outstanding', 'partially_paid')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.store_unlock_requests sur
    WHERE sur.company_id = p_company_id
      AND sur.customer_id = p_customer_id
      AND sur.status = 'APPROVED'
      AND sur.consumed_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.is_customer_order_locked(UUID, UUID) IS
  'Gate P4.16-A: TRUE bila customer ini punya invoice outstanding/partially_paid dengan due_date <= H-3 DAN tidak ada store_unlock_requests APPROVED yang belum dikonsumsi. Live computation murni -- tidak ada kolom/cron tersimpan. Dipanggil Gate P4.16-C (create_sales_order_atomic/confirm_sales_order_atomic/create_draft_sales_order_atomic/update_draft_sales_order_atomic) dan Gate P4.16-B (submit_store_unlock_request_atomic, guard not_locked).';

REVOKE ALL ON FUNCTION public.is_customer_order_locked(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_customer_order_locked(UUID, UUID) TO service_role, authenticated;
