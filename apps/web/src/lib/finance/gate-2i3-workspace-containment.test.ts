// =============================================================================
// Gate 2I.3 -- Containment/structural test lewat pembacaan source langsung,
// pola identik gate-2i2-workspace-containment.test.ts. Repo tidak punya
// harness render React (vitest.config.ts: environment "node", tanpa jsdom/
// @testing-library/react) -- component client interaktif (hooks) TIDAK BISA
// dipanggil sebagai pure function, jadi pembuktian pola disabled-with-reason
// (FIN-02-05/FIN-02-07), ConfirmDialog usage, non-optimistic update, dan
// larangan formula saldo alternatif dilakukan lewat pembacaan source, bukan
// DOM query -- keterbatasan tooling repo yang sudah ada sebelum gate ini.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSrc(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

const queriesSrc = readSrc("./queries.ts");
const actionsSrc = readSrc("./actions.ts");
const returnPanelsSrc = readSrc("../../components/finance/return-panels.tsx");
const refundPanelsSrc = readSrc("../../components/finance/refund-panels.tsx");
const actionQueueSrc = readSrc("../../components/finance/action-queue.tsx");
const returnListPage = readSrc("../../app/(dashboard)/dashboard/finance/returns/page.tsx");
const returnDetailPage = readSrc("../../app/(dashboard)/dashboard/finance/returns/[id]/page.tsx");
const creditListPage = readSrc("../../app/(dashboard)/dashboard/finance/credit/page.tsx");
const creditDetailPage = readSrc("../../app/(dashboard)/dashboard/finance/credit/[id]/page.tsx");

describe("FIN-02-05: VerifyReturnPanel disabled dengan alasan 'Hanya Owner' untuk actor tanpa return.verify", () => {
  it("return-panels.tsx merender 'Hanya Owner yang dapat menyetujui' saat !canVerify, bukan return null", () => {
    expect(returnPanelsSrc).toMatch(/if\s*\(\s*!canVerify\s*\)\s*\{/);
    expect(returnPanelsSrc).toContain("Hanya Owner yang dapat menyetujui");
    expect(returnPanelsSrc).not.toMatch(/if\s*\(\s*!canVerify\s*\)\s*\{\s*return null/);
  });
});

describe("FIN-02-07: ApproveRefundPanel disabled dengan alasan 'Hanya Owner' untuk actor tanpa refund.approve", () => {
  it("refund-panels.tsx merender 'Hanya Owner yang dapat menyetujui' saat !canApprove, bukan return null", () => {
    expect(refundPanelsSrc).toMatch(/if\s*\(\s*!canApprove\s*\)\s*\{/);
    expect(refundPanelsSrc).toContain("Hanya Owner yang dapat menyetujui");
    expect(refundPanelsSrc).not.toMatch(/if\s*\(\s*!canApprove\s*\)\s*\{\s*return null/);
  });

  it("refund-panels.tsx RequestRefundPanel juga menampilkan alasan 'Bukan kewenangan Anda' saat !canRequest (bukan disembunyikan)", () => {
    expect(refundPanelsSrc).toMatch(/if\s*\(\s*!canRequest\s*\)\s*\{/);
    expect(refundPanelsSrc).toContain("Bukan kewenangan Anda");
  });

  it("return-panels.tsx RequestReturnPanel juga menampilkan alasan 'Bukan kewenangan Anda' saat !canRequest", () => {
    expect(returnPanelsSrc).toMatch(/if\s*\(\s*!canRequest\s*\)\s*\{/);
    expect(returnPanelsSrc).toContain("Bukan kewenangan Anda");
  });
});

describe("§5/§10: ConfirmDialog dipakai untuk semua keputusan sensitif Gate 2I.3", () => {
  it("return-panels.tsx dan refund-panels.tsx mengimpor dan memakai ConfirmDialog untuk request maupun verify/approve", () => {
    for (const src of [returnPanelsSrc, refundPanelsSrc]) {
      expect(src).toContain('from "@/components/ui/confirm-dialog"');
      expect(src).toContain("<ConfirmDialog");
    }
  });

  it("dialog approve/reject retur & refund menyebut akibat bisnis (credit note / saldo customer credit) dalam description", () => {
    expect(returnPanelsSrc).toMatch(/credit note/i);
    expect(refundPanelsSrc).toMatch(/saldo customer credit/i);
  });
});

describe("§5: idempotency key digenerate sekali per dialog-terbuka (openDialog), bukan di submit", () => {
  it("RequestReturnPanel/RequestRefundPanel memanggil crypto.randomUUID() di dalam openDialog, bukan di submit", () => {
    for (const src of [returnPanelsSrc, refundPanelsSrc]) {
      const openDialogMatch = src.match(/function openDialog\(\)[\s\S]*?\n  \}/);
      expect(openDialogMatch).not.toBeNull();
      expect(openDialogMatch![0]).toContain("crypto.randomUUID()");
      const submitMatch = src.match(/function submit\(\)[\s\S]*?startTransition/);
      expect(submitMatch).not.toBeNull();
      expect(submitMatch![0]).not.toContain("crypto.randomUUID()");
    }
  });
});

describe("§10: Optimistic update tidak dipakai -- seluruh aksi menunggu server action selesai sebelum UI berubah", () => {
  it("return-panels.tsx dan refund-panels.tsx membungkus submit dengan startTransition(async..) dan await ...Action(", () => {
    for (const src of [returnPanelsSrc, refundPanelsSrc]) {
      expect(src).toMatch(/startTransition\(async \(\) => \{/);
      expect(src).toMatch(/await (requestReturn|verifyReturn|requestRefund|approveRefund)Action\(/);
    }
  });
});

describe("Closeout §3: saldo lazy-initialized tidak dirender/ditangani seolah saldo habis", () => {
  it("queries.ts menentukan isInitialized dari KEBERADAAN baris customer_credit_ledger (entry_type=credit_note_origin), bukan dari nilai ledgerBalance/availableBalance (tidak bisa dibedakan dari canonical zero)", () => {
    expect(queriesSrc).toContain('.eq("entry_type", "credit_note_origin")');
    expect(queriesSrc).toContain("initializedSet.has(row.id)");
    expect(queriesSrc).not.toMatch(/isInitialized:\s*\w+\.(ledgerBalance|availableBalance|ledger_balance|available_balance)/);
  });

  it("refund-panels.tsx RequestRefundPanel TIDAK menggunakan availableBalance<=0 secara langsung sebagai gate 'saldo habis' -- harus dikombinasikan dengan isInitialized (isExhausted)", () => {
    expect(refundPanelsSrc).toContain("isInitialized");
    expect(refundPanelsSrc).toMatch(/const isExhausted = isInitialized && availableBalance <= 0/);
    expect(refundPanelsSrc).not.toMatch(/if\s*\(\s*availableBalance\s*<=\s*0\s*\)/);
  });

  it("refund-panels.tsx memakai customerCreditAmount (nilai credit awal canonical) sebagai batas sementara saat belum diinisialisasi, bukan formula pengurangan baru", () => {
    expect(refundPanelsSrc).toContain("effectiveMax = isInitialized ? availableBalance : customerCreditAmount");
    expect(refundPanelsSrc).not.toMatch(/customerCreditAmount\s*-\s*(pendingReserved|availableBalance)/);
  });

  it("credit/page.tsx merender label eksplisit 'Belum diinisialisasi' (bukan Rp0) saat !isInitialized, dan tetap menampilkan Nilai Credit Awal terpisah", () => {
    expect(creditListPage).toContain("Belum diinisialisasi");
    expect(creditListPage).toContain("Nilai Credit Awal");
    expect(creditListPage).toContain("BalanceCell");
  });
});

describe("§3/§8 dan larangan gate: credit note tidak dapat dibuat manual dari UI, tidak ada direct table mutation", () => {
  it("actions.ts memanggil RPC canonical (request_return_atomic/verify_return_atomic/request_refund_atomic/approve_refund_atomic), tidak pernah .from(\"credit_notes\")/.from(\"returns\")/.from(\"refund_requests\")/.from(\"customer_credit_ledger\") untuk INSERT/UPDATE manual", () => {
    expect(actionsSrc).toContain('admin.rpc("request_return_atomic"');
    expect(actionsSrc).toContain('admin.rpc("verify_return_atomic"');
    expect(actionsSrc).toContain('admin.rpc("request_refund_atomic"');
    expect(actionsSrc).toContain('admin.rpc("approve_refund_atomic"');
    expect(actionsSrc).not.toMatch(/\.from\(\s*["'](credit_notes|returns|refund_requests|customer_credit_ledger)["']\s*\)\s*\.(insert|update|upsert|delete)/);
  });

  it("tidak ada tombol/label 'Buat Credit Note' atau 'Terbitkan Credit Note' manual di seluruh route/komponen Gate 2I.3", () => {
    for (const src of [returnPanelsSrc, refundPanelsSrc, returnListPage, returnDetailPage, creditListPage, creditDetailPage]) {
      expect(src).not.toMatch(/buat credit note|terbitkan credit note/i);
    }
  });

  it("queries.ts (read side) tidak pernah memakai admin/service-role client -- hanya actions.ts (write side) yang memakai getAdminClient", () => {
    expect(queriesSrc).not.toContain("getAdminClient");
    expect(actionsSrc).toContain("getAdminClient");
  });
});

describe("§8 kontrak: tidak ada formula saldo/nilai alternatif di UI -- outstanding/available_balance/credit note value SELALU dari query canonical", () => {
  it("getReturnDetail: totalPreview/appliedAmountPreview/customerCreditAmountPreview dihitung dari invoice_lines dengan formula IDENTIK migration (bukan formula baru), dan angka final approved SELALU dari credit_notes (bukan preview)", () => {
    expect(queriesSrc).toMatch(/requested_quantity \* \(lineTotal \/ qty\)/);
    expect(queriesSrc).toMatch(/appliedAmountPreview\s*=\s*Math\.min\(totalPreview, outstandingBalance\)/);
  });

  it("getCreditNoteList/getRefundDetail membaca ledger_balance/pending_reserved/available_balance LANGSUNG dari view customer_credit_balances, tidak menghitung ulang dengan pengurangan manual", () => {
    expect(queriesSrc).toContain('.from("customer_credit_balances")');
    expect(queriesSrc).not.toMatch(/availableBalance:\s*\w+\.ledgerBalance\s*-/);
    expect(queriesSrc).not.toMatch(/available_balance:\s*\w+\.ledger_balance\s*-/);
  });
});

describe("§8 UI/containment: route Gate 2I.3 tersedia, action queue memakai link detail yang valid", () => {
  it("layout.tsx finance menyertakan href aktif untuk tab Retur & Credit Note dan Customer Credit & Refund", () => {
    const layoutSrc = readSrc("../../app/(dashboard)/dashboard/finance/layout.tsx");
    expect(layoutSrc).toContain('{ label: "Retur & Credit Note", href: "/dashboard/finance/returns" }');
    expect(layoutSrc).toContain('{ label: "Customer Credit & Refund", href: "/dashboard/finance/credit" }');
    // Cancellation & Invoice Void TETAP non-aktif (2I.4, bukan scope gate ini).
    expect(layoutSrc).toContain('{ label: "Cancellation & Invoice Void" }');
  });

  it("action-queue.tsx mengarahkan return_pending/refund_pending ke route nyata (deriveDetailHref), TIDAK mengubah cancellation_pending/invoice_void_notice (masih disabled -- 2I.4)", () => {
    expect(actionQueueSrc).toContain('item.category === "return_pending"');
    expect(actionQueueSrc).toContain("/dashboard/finance/returns/");
    expect(actionQueueSrc).toContain('item.category === "refund_pending"');
    expect(actionQueueSrc).toContain("/dashboard/finance/credit/");
    expect(actionQueueSrc).toContain("function deriveDetailHref");
    // Fallback tetap DetailAffordance (disabled) untuk kategori lain (cancellation_pending/invoice_void_notice).
    expect(actionQueueSrc).toMatch(/return href \? <DetailLink href=\{href\} \/> : <DetailAffordance \/>/);
  });

  it("route list/detail Retur & Credit Note dan Customer Credit & Refund menggunakan guard hasFinanceWorkspaceAccess + redirect (bukan roles.includes mentah) dan menangani mode demo", () => {
    for (const src of [returnListPage, returnDetailPage, creditListPage, creditDetailPage]) {
      expect(src).toContain("hasFinanceWorkspaceAccess");
      expect(src).toContain('redirect("/dashboard")');
      expect(src).toContain("user.isDemo");
    }
  });
});

describe("§10 mobile: list Retur & Credit Note dan Customer Credit & Refund memiliki varian card mobile (tidak hanya DataTable desktop)", () => {
  it("returns/page.tsx dan credit/page.tsx merender <ul> card list terpisah dari <div hidden md:block> DataTable", () => {
    for (const src of [returnListPage, creditListPage]) {
      expect(src).toContain("md:hidden");
      expect(src).toContain("hidden");
      expect(src).toMatch(/<DataTable/);
    }
  });
});
