-- =============================================================================
-- Gate P4.06 extension -- invoice picker di Klaim Pembayaran (insight
-- Pak Waluyo, 2026-08-19).
--
-- Masalah: sales/driver lapor "terima Rp X dari Toko Y" tanpa bilang invoice
-- mana -- Owner/Finance harus menebak alokasinya sendiri saat approve
-- (payment-claim-review-panel.tsx).
--
-- Fix (ADDITIVE, tidak mengubah prinsip anti-kecurangan Gate P4.06 sama
-- sekali -- lihat migration 20261010000001 header):
--   payment_claims.claimed_invoice_ids UUID[] -- referensi/informasi
--   TAMBAHAN dari sales tentang invoice mana yang dia maksud. TIDAK mengunci
--   alokasi ledger -- itu tetap 100% wewenang Owner/Finance saat approve
--   (p_allocations di approve_payment_claim_atomic TIDAK BERUBAH sama
--   sekali). Kolom ini murni membantu Finance tidak menebak-nebak, dipakai
--   sebagai pre-fill di UI approval (lihat payment-claim-review-panel.tsx).
--
--   Sama seperti kolom klaim inti lainnya, claimed_invoice_ids TERKUNCI
--   sejak submit (masuk guard_payment_claim_review_transition yang sudah
--   ada) -- sales tidak bisa mengubah "cerita" invoice mana yang dia maksud
--   setelah klaim dikirim, prinsip yang sama dengan nominal/metode.
--
-- Parameter baru p_claimed_invoice_ids DEFAULT NULL ditambahkan di AKHIR
-- daftar parameter submit_payment_claim_atomic. CATATAN (dikoreksi setelah
-- dicoba di lokal): Postgres TIDAK menganggap ini "replace" walau parameter
-- baru berdefault -- identitas function ditentukan murni dari tipe
-- argumen, jadi menambah parameter selalu membuat overload BARU di
-- samping yang lama, bukan mengganti. Makanya section 3 di bawah
-- eksplisit DROP dulu signature 9-parameter yang lama sebelum CREATE
-- signature 10-parameter yang baru -- kalau tidak, akan ada 2 function
-- bernama sama nyangkut sekaligus (bikin PostgREST/psql bingung pilih
-- yang mana). Pemanggil existing (apps/web) tetap tidak perlu ubah kode
-- karena parameter baru berdefault NULL.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Kolom baru + komentar.
-- ---------------------------------------------------------------------------

ALTER TABLE public.payment_claims
  ADD COLUMN IF NOT EXISTS claimed_invoice_ids UUID[];

COMMENT ON COLUMN public.payment_claims.claimed_invoice_ids IS
  'Referensi OPSIONAL invoice yang menurut sales/driver terkait klaim ini -- murni informasi, TIDAK mengunci alokasi ledger (itu tetap wewenang Owner/Finance di approve_payment_claim_atomic). NULL/kosong = sales tidak menandai invoice spesifik ("titip uang") -- lihat lib/finance/allocation.ts untuk fallback alokasi FIFO by due_date di UI approval.';

-- ---------------------------------------------------------------------------
-- 2. Perluas immutability guard -- claimed_invoice_ids ikut terkunci sejak
--    submit, prinsip sama dengan kolom klaim inti lainnya.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_payment_claim_review_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.transfer_reference IS DISTINCT FROM OLD.transfer_reference
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.claimed_invoice_ids IS DISTINCT FROM OLD.claimed_invoice_ids
     OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_CORE_IMMUTABLE: kolom klaim inti (customer/metode/nominal/pelapor/referensi invoice) tidak dapat diubah setelah dibuat, klaim %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_ALREADY_DECIDED: klaim % sudah diputuskan (%), tidak dapat diubah lagi', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_INVALID_TRANSITION: status tujuan harus APPROVED atau REJECTED, dapat %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. submit_payment_claim_atomic -- tambah p_claimed_invoice_ids DEFAULT
--    NULL. Validasi: setiap invoice yang ditandai wajib milik customer yang
--    sama dengan klaim (pola sama ALLOCATION_CUSTOMER_MISMATCH di approve).
--    DROP signature lama dulu (9 parameter) -- tambah parameter mengubah
--    identitas function di Postgres, CREATE OR REPLACE TIDAK mengganti
--    signature lama, cuma menambah overload baru di sampingnya.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.submit_payment_claim_atomic(UUID, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.submit_payment_claim_atomic(
  p_company_id          UUID,
  p_actor_id            UUID,
  p_customer_id         UUID,
  p_method              TEXT,
  p_amount              NUMERIC,
  p_transfer_reference  TEXT DEFAULT NULL,
  p_note                TEXT DEFAULT NULL,
  p_proofs              JSONB DEFAULT '[]'::jsonb,
  p_idempotency_key     TEXT DEFAULT NULL,
  p_claimed_invoice_ids UUID[] DEFAULT NULL
) RETURNS TABLE(
  out_claim_id       UUID,
  out_already_exists BOOLEAN,
  out_status         TEXT
) AS $$
DECLARE
  v_transfer_reference TEXT;
  v_note               TEXT;
  v_proofs             JSONB;
  v_request_payload    JSONB;
  v_existing            public.payment_claims%ROWTYPE;
  v_actor_allowed       BOOLEAN;
  v_customer_company_id UUID;
  v_claim_id            UUID;
  v_proof_elem          JSONB;
  v_proof_count         INTEGER;
BEGIN
  IF p_method NOT IN ('cash', 'bank_transfer') THEN
    RAISE EXCEPTION 'INVALID_METHOD: %', p_method USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: % harus lebih dari 0', p_amount USING ERRCODE = 'check_violation';
  END IF;

  v_proofs := COALESCE(p_proofs, '[]'::jsonb);
  IF jsonb_typeof(v_proofs) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PROOFS: p_proofs harus berupa array (boleh kosong)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_proofs) elem
    WHERE elem->>'proof_type' IS NULL OR length(trim(elem->>'proof_type')) = 0
       OR elem->>'object_reference' IS NULL OR length(trim(elem->>'object_reference')) = 0
  ) THEN
    RAISE EXCEPTION 'INVALID_PROOF: setiap proof yang dilampirkan wajib memiliki proof_type dan object_reference' USING ERRCODE = 'check_violation';
  END IF;

  v_transfer_reference := NULLIF(trim(COALESCE(p_transfer_reference, '')), '');
  v_note := NULLIF(trim(COALESCE(p_note, '')), '');

  -- Setiap invoice yang ditandai sales wajib milik customer YANG SAMA
  -- dengan klaim -- mencegah referensi "tersesat" ke customer lain.
  -- NOT EXISTS menangkap dua kasus sekaligus: invoice_id tidak ditemukan
  -- SAMA SEKALI, atau ditemukan tapi customer/company_id-nya beda.
  IF p_claimed_invoice_ids IS NOT NULL AND array_length(p_claimed_invoice_ids, 1) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(p_claimed_invoice_ids) AS inv_id
      WHERE NOT EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.id = inv_id AND i.customer_id = p_customer_id AND i.company_id = p_company_id
      )
    ) THEN
      RAISE EXCEPTION 'CLAIMED_INVOICE_CUSTOMER_MISMATCH: salah satu invoice yang ditandai bukan milik customer % pada company %', p_customer_id, p_company_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  v_request_payload := jsonb_build_object(
    'customerId', p_customer_id,
    'method', p_method,
    'amount', p_amount,
    'transferReference', v_transfer_reference,
    'note', v_note,
    'proofs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'proofType', elem->>'proof_type',
        'objectReference', elem->>'object_reference',
        'metadata', COALESCE(elem->'metadata', '{}'::jsonb)
      ) ORDER BY elem->>'object_reference')
      FROM jsonb_array_elements(v_proofs) elem
    ), '[]'::jsonb),
    'claimedInvoiceIds', COALESCE(to_jsonb(p_claimed_invoice_ids), '[]'::jsonb)
  );

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payment_claims
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: idempotency_key % sudah dipakai dengan payload berbeda', p_idempotency_key
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN QUERY SELECT v_existing.id, TRUE, v_existing.status;
      RETURN;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'payment.claim'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.claim pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT company_id INTO v_customer_company_id FROM public.customers WHERE id = p_customer_id;
  IF v_customer_company_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: customer % bukan milik company %', p_customer_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.payment_claims (
    company_id, customer_id, method, amount, transfer_reference, note,
    claimed_by, request_payload, idempotency_key, claimed_invoice_ids
  ) VALUES (
    p_company_id, p_customer_id, p_method, p_amount, v_transfer_reference, v_note,
    p_actor_id, v_request_payload, p_idempotency_key,
    CASE WHEN p_claimed_invoice_ids IS NOT NULL AND array_length(p_claimed_invoice_ids, 1) > 0 THEN p_claimed_invoice_ids ELSE NULL END
  ) RETURNING id INTO v_claim_id;

  FOR v_proof_elem IN SELECT * FROM jsonb_array_elements(v_proofs) LOOP
    INSERT INTO public.payment_claim_proofs (payment_claim_id, company_id, proof_type, object_reference, metadata, uploaded_by)
    VALUES (v_claim_id, p_company_id, v_proof_elem->>'proof_type', v_proof_elem->>'object_reference', COALESCE(v_proof_elem->'metadata', '{}'::jsonb), p_actor_id);
  END LOOP;

  SELECT COUNT(*) INTO v_proof_count FROM public.payment_claim_proofs WHERE payment_claim_id = v_claim_id;
  IF v_proof_count <> jsonb_array_length(v_proofs) THEN
    RAISE EXCEPTION 'PROOF_MATERIALIZATION_INCOMPLETE: payment_claim % mengharapkan % proof, hanya % ter-insert', v_claim_id, jsonb_array_length(v_proofs), v_proof_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'payment.claim_submitted', 'payment_claims', v_claim_id,
    jsonb_build_object(
      'customer_id', p_customer_id, 'method', p_method, 'amount', p_amount,
      'transfer_reference', v_transfer_reference, 'proof_count', v_proof_count,
      'idempotency_key', p_idempotency_key, 'claimed_invoice_ids', to_jsonb(p_claimed_invoice_ids)
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_claim_id, FALSE, 'PENDING'::TEXT;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.submit_payment_claim_atomic IS
  'Gate P4.06 (extended 2026-08-19): sales/driver melaporkan pembayaran yang diterima -- status PENDING, TIDAK menyentuh receivable_ledger/payment_receipts sama sekali. Proof OPSIONAL. p_claimed_invoice_ids OPSIONAL -- referensi invoice yang dimaksud sales, murni informasi (bukan alokasi ledger), dipakai sebagai pre-fill UI approval. Permission payment.claim (sales/driver). Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.submit_payment_claim_atomic(UUID, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, JSONB, TEXT, UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_payment_claim_atomic(UUID, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, JSONB, TEXT, UUID[])
  TO service_role;
