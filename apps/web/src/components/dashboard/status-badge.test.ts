// =============================================================================
// Unit test -- Gate 2I.1 GAP G7: StatusBadge extended untuk domain finance.
//
// Membuktikan dua hal: (1) perilaku default (domain="sales_order") PERSIS
// sama dengan sebelum extension -- caller existing (owner/page.tsx, dst)
// tidak berubah; (2) status code yang SAMA ("requested") menghasilkan label
// BERBEDA antar domain finance (return vs refund/cancellation) sesuai
// kontrak §5.5/§5.6/§5.7 -- bukan satu map gabungan yang bisa tabrakan.
//
// Tidak ada infrastruktur render React (vitest environment: node, tidak ada
// jsdom/@testing-library) -- diuji lewat pemanggilan langsung fungsi
// StatusBadge sebagai pure function yang mengembalikan React element, lalu
// diperiksa props-nya (bukan DOM), pola yang sama dipakai lint config
// existing (include hanya *.test.ts, bukan *.test.tsx).
// =============================================================================

import { describe, it, expect } from "vitest";
import { StatusBadge } from "./status-badge";

function renderProps(el: ReturnType<typeof StatusBadge>) {
  return el.props as { className: string; children: string };
}

describe("StatusBadge — domain default sales_order tidak berubah", () => {
  it("status 'paid' tanpa domain eksplisit tetap 'Lunas' (perilaku lama)", () => {
    const el = StatusBadge({ status: "paid" });
    expect(renderProps(el).children).toBe("Lunas");
  });

  it("status tidak dikenal fallback ke label mentah + style netral", () => {
    const el = StatusBadge({ status: "misteri" });
    const props = renderProps(el);
    expect(props.children).toBe("misteri");
    expect(props.className).toContain("bg-gray-100");
  });
});

describe("StatusBadge — domain finance (Gate 2I.1)", () => {
  it("invoice: outstanding/partially_paid/paid punya label kontrak §6", () => {
    expect(renderProps(StatusBadge({ status: "outstanding", domain: "invoice" })).children).toBe("Belum Dibayar");
    expect(renderProps(StatusBadge({ status: "partially_paid", domain: "invoice" })).children).toBe("Dibayar Sebagian");
    expect(renderProps(StatusBadge({ status: "paid", domain: "invoice" })).children).toBe("Lunas");
  });

  it("promise: status label sesuai §5.2", () => {
    expect(renderProps(StatusBadge({ status: "open", domain: "promise" })).children).toBe("Aktif");
    expect(renderProps(StatusBadge({ status: "broken", domain: "promise" })).children).toBe("Wanprestasi");
  });

  it("payment_reconciliation: classification exception + pseudo-status pending_verification", () => {
    expect(renderProps(StatusBadge({ status: "overpaid", domain: "payment_reconciliation" })).children).toBe("Kelebihan Bayar");
    expect(renderProps(StatusBadge({ status: "pending_verification", domain: "payment_reconciliation" })).children).toBe(
      "Menunggu Rekonsiliasi"
    );
  });

  it("status code 'requested' TIDAK tabrakan antar domain -- return vs refund/cancellation beda label (kontrak §5.5 vs §5.6/§5.7)", () => {
    expect(renderProps(StatusBadge({ status: "requested", domain: "return" })).children).toBe("Menunggu Verifikasi");
    expect(renderProps(StatusBadge({ status: "requested", domain: "refund" })).children).toBe("Menunggu Persetujuan");
    expect(renderProps(StatusBadge({ status: "requested", domain: "cancellation" })).children).toBe("Menunggu Persetujuan");
  });

  it("invoice_void: voided vs reversed", () => {
    expect(renderProps(StatusBadge({ status: "voided", domain: "invoice_void" })).children).toBe("Invoice Void");
    expect(renderProps(StatusBadge({ status: "reversed", domain: "invoice_void" })).children).toBe("Credit Note Direverse");
  });
});
