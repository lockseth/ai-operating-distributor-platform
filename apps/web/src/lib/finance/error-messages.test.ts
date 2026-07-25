// =============================================================================
// Unit test -- Gate 2I.2 mapFinanceRpcError(). Membuktikan: (1) setiap kode
// error RPC Gate 2C/2D/2E yang benar-benar dipakai di actions.ts dipetakan
// ke pesan Indonesia; (2) kode mentah TIDAK PERNAH bocor ke pesan akhir
// (kontrak §5, CLAUDE.md "Jangan mengekspos logika internal di respons API
// publik"); (3) kode tak dikenal jatuh ke pesan default, bukan crash/undefined.
// =============================================================================

import { describe, it, expect } from "vitest";
import { FINANCE_ERROR_MESSAGES, mapFinanceRpcError } from "./error-messages";

describe("mapFinanceRpcError", () => {
  it("memetakan setiap kode terdaftar ke pesan manusiawi tanpa menyisakan kode mentah", () => {
    for (const [code, human] of Object.entries(FINANCE_ERROR_MESSAGES)) {
      const raw = `${code}: detail teknis dari database`;
      const mapped = mapFinanceRpcError(raw);
      expect(mapped).toBe(human);
      expect(mapped).not.toContain(code);
    }
  });

  it("kode error Gate 2C (collection/promise) dipetakan", () => {
    expect(mapFinanceRpcError("AMOUNT_EXCEEDS_OUTSTANDING: promise melebihi outstanding")).toMatch(/melebihi sisa piutang/i);
    expect(mapFinanceRpcError("ACTIVE_PROMISE_EXISTS: invoice sudah punya promise open")).toMatch(/sudah memiliki janji bayar aktif/i);
    expect(mapFinanceRpcError("PROMISE_NOT_YET_DUE: belum jatuh tempo")).toMatch(/belum melewati tanggal jatuh tempo/i);
  });

  it("kode error Gate 2D (payment) dipetakan, termasuk pesan 'muat ulang' untuk race condition (§7.2)", () => {
    expect(mapFinanceRpcError("ALLOCATION_EXCEEDS_OUTSTANDING: race condition")).toMatch(/muat ulang/i);
    expect(mapFinanceRpcError("ALLOCATION_TOTAL_MISMATCH: total tidak sama")).toMatch(/total alokasi harus sama/i);
    expect(mapFinanceRpcError("PROOF_REQUIRED: tidak ada proof")).toMatch(/bukti pembayaran wajib/i);
    expect(mapFinanceRpcError("DUPLICATE_TRANSFER_REFERENCE: sudah ada")).toMatch(/sudah pernah dicatat/i);
  });

  it("kode error Gate 2E (reconciliation) dipetakan", () => {
    expect(mapFinanceRpcError("PAYMENT_RECEIPT_NOT_FOUND: xyz")).toMatch(/tidak ditemukan/i);
    expect(mapFinanceRpcError("IDEMPOTENCY_KEY_PAYMENT_MISMATCH: xyz")).toMatch(/muat ulang/i);
  });

  it("FORBIDDEN dan TENANT_CONTEXT_MISMATCH (lintas domain) dipetakan generik", () => {
    expect(mapFinanceRpcError("FORBIDDEN: actor tidak memiliki permission payment.record")).toBe(
      "Anda tidak memiliki izin untuk melakukan aksi ini."
    );
    expect(mapFinanceRpcError("TENANT_CONTEXT_MISMATCH: invoice bukan milik company")).toBe(
      "Data tidak ditemukan pada perusahaan Anda."
    );
  });

  it("kode error Gate 2F (retur/credit note) dipetakan", () => {
    expect(mapFinanceRpcError("RETURN_ALREADY_RESOLVED: sudah approved")).toMatch(/sudah diputuskan sebelumnya/i);
    expect(mapFinanceRpcError("RETURN_QUANTITY_EXCEEDS_CREDITABLE: melebihi sisa")).toMatch(/muat ulang/i);
    expect(mapFinanceRpcError("REASON_CODE_REQUIRED: kosong")).toMatch(/alasan retur wajib diisi/i);
  });

  it("kode error Gate 2H (customer credit/refund) dipetakan", () => {
    expect(mapFinanceRpcError("REFUND_EXCEEDS_AVAILABLE_BALANCE: melebihi 500000")).toMatch(/muat ulang/i);
    expect(mapFinanceRpcError("CREDIT_NOTE_REVERSED: sudah direverse")).toMatch(/sudah direverse/i);
    expect(mapFinanceRpcError("REFUND_ALREADY_RESOLVED: sudah rejected")).toMatch(/sudah diputuskan sebelumnya/i);
  });

  it("kode tak dikenal jatuh ke pesan default, bukan crash atau pesan kosong", () => {
    expect(mapFinanceRpcError("SOME_UNKNOWN_FUTURE_CODE: detail")).toBe("Terjadi kesalahan saat memproses permintaan.");
    expect(mapFinanceRpcError("")).toBe("Terjadi kesalahan saat memproses permintaan.");
  });
});
