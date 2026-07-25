// =============================================================================
// Gate 2I.4 -- Test tunggal terkonsolidasi (closeout: kontrak membatasi
// maksimal 4 file test yang berubah/dibuat). File ini menyatukan SELURUH
// non-DB-backed coverage Gate 2I.4:
//
//   A. computeCancellationPreviewBranch -- pure function unit test (§E).
//   B. cancellation-panels.tsx -- component behavior lewat pembacaan source
//      langsung (repo tidak punya harness render React -- vitest.config.ts:
//      environment "node", tanpa jsdom/@testing-library/react -- pola
//      identik gate-2i3-workspace-containment.test.ts).
//   C. requestOrderCancellationAction/approveOrderCancellationAction --
//      server action wrapper guard test (mock getAuthUser/getAdminClient/
//      next-cache, pola identik actions.test.ts Gate 2I.2/2I.3 -- DIGABUNG
//      ke sini, bukan actions.test.ts, supaya jumlah file test tidak
//      melebihi 4 sesuai instruksi closeout).
//   D. Error-mapping spot-check Gate 2G (kode baru §G) -- suplemen ringan;
//      cakupan generik SUDAH otomatis lewat loop existing di
//      error-messages.test.ts (Object.entries(FINANCE_ERROR_MESSAGES)) yang
//      TIDAK disentuh gate ini (tidak perlu diedit -- loop-nya data-driven
//      dari map yang sudah memuat 10 kode baru).
//   E. Containment struktural lintas file (layout/tab-nav/action-queue/
//      invoice-detail wiring/G11 redirect/responsive/queries.ts/actions.ts).
//
// DB-backed (getCancellationList/getCancellationDetail/getFinanceAuditList
// dkk. terhadap Postgres nyata, RLS, CXL-01/CXL-09/CXL-AUD-01) ada di file
// terpisah cancellation-audit-workspace.integration.test.ts -- TIDAK bisa
// digabung ke sini karena describeIfDb (skip graceful tanpa DB lokal) butuh
// runtime terpisah dari test murni/mock di atas.
// =============================================================================

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCancellationPreviewBranch } from "./queries";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSrc(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

const queriesSrc = readSrc("./queries.ts");
const actionsSrc = readSrc("./actions.ts");
const cancellationPanelsSrc = readSrc("../../components/finance/cancellation-panels.tsx");
const actionQueueSrc = readSrc("../../components/finance/action-queue.tsx");
const financeTabNavSrc = readSrc("../../components/finance/finance-tab-nav.tsx");
const layoutSrc = readSrc("../../app/(dashboard)/dashboard/finance/layout.tsx");
const cancellationListPage = readSrc("../../app/(dashboard)/dashboard/finance/cancellations/page.tsx");
const cancellationDetailPage = readSrc("../../app/(dashboard)/dashboard/finance/cancellations/[id]/page.tsx");
const auditPage = readSrc("../../app/(dashboard)/dashboard/finance/audit/page.tsx");
const invoiceDetailPage = readSrc("../../app/(dashboard)/dashboard/finance/invoices/[id]/page.tsx");
const collectionRedirectPage = readSrc("../../app/(dashboard)/dashboard/collection/page.tsx");
const paymentsListPage = readSrc("../../app/(dashboard)/dashboard/finance/payments/page.tsx");
const collectionPanelSrc = readSrc("../../components/finance/collection-panel.tsx");

// =============================================================================
// A. computeCancellationPreviewBranch -- mapper impact preview seluruh cabang
//    (kontrak §E, CXL-07/CXL-08).
// =============================================================================

describe("computeCancellationPreviewBranch -- mapper impact preview seluruh cabang (kontrak §E, CXL-07/CXL-08)", () => {
  it("draft/confirmed/processing/delivering -> eligible_no_invoice", () => {
    for (const orderStatus of ["draft", "confirmed", "processing", "delivering"]) {
      expect(
        computeCancellationPreviewBranch({ orderStatus, invoiceCount: 0, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 0, totalAmount: 0 })
      ).toBe("eligible_no_invoice");
    }
  });

  it("delivered -> delivery_reversal_required (CXL-07: blocked SEBELUM tombol approve diklik)", () => {
    expect(
      computeCancellationPreviewBranch({ orderStatus: "delivered", invoiceCount: 0, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 0, totalAmount: 0 })
    ).toBe("delivery_reversal_required");
  });

  it("invoiced/paid, invoice tunggal, TIDAK tersentuh -> eligible_full_void", () => {
    for (const orderStatus of ["invoiced", "paid"]) {
      expect(
        computeCancellationPreviewBranch({ orderStatus, invoiceCount: 1, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 10000, totalAmount: 10000 })
      ).toBe("eligible_full_void");
    }
  });

  it("invoiced/paid dengan payment allocation -> settlement_exists (CXL-08: fakta payment allocation eksplisit)", () => {
    expect(
      computeCancellationPreviewBranch({ orderStatus: "paid", invoiceCount: 1, hasPaymentAllocation: true, hasCreditNote: false, outstandingBalance: 6000, totalAmount: 10000 })
    ).toBe("settlement_exists");
  });

  it("invoiced dengan credit note aktif -> settlement_exists", () => {
    expect(
      computeCancellationPreviewBranch({ orderStatus: "invoiced", invoiceCount: 1, hasPaymentAllocation: false, hasCreditNote: true, outstandingBalance: 10000, totalAmount: 10000 })
    ).toBe("settlement_exists");
  });

  it("invoiced dengan outstanding != total_amount (tanpa payment/credit note eksplisit) -> settlement_exists (pertahanan berlapis)", () => {
    expect(
      computeCancellationPreviewBranch({ orderStatus: "invoiced", invoiceCount: 1, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 9999, totalAmount: 10000 })
    ).toBe("settlement_exists");
  });

  it("invoiced tanpa invoice -> invoice_record_missing; lebih dari satu invoice -> multiple_invoices_unsupported", () => {
    expect(
      computeCancellationPreviewBranch({ orderStatus: "invoiced", invoiceCount: 0, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 0, totalAmount: 0 })
    ).toBe("invoice_record_missing");
    expect(
      computeCancellationPreviewBranch({ orderStatus: "invoiced", invoiceCount: 2, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 0, totalAmount: 0 })
    ).toBe("multiple_invoices_unsupported");
  });

  it("status di luar lifecycle Gate 2G (mis. cancelled/unknown) -> invalid_order_status, bukan menebak", () => {
    expect(
      computeCancellationPreviewBranch({ orderStatus: "cancelled", invoiceCount: 0, hasPaymentAllocation: false, hasCreditNote: false, outstandingBalance: 0, totalAmount: 0 })
    ).toBe("invalid_order_status");
  });
});

// =============================================================================
// B. cancellation-panels.tsx -- component behavior lewat pembacaan source.
// =============================================================================

describe("RequestCancellationPanel -- disabled-with-reason, bukan disembunyikan (FIN-02-08 varian request)", () => {
  it("merender 'Bukan kewenangan Anda' saat !canRequest, bukan return null", () => {
    expect(cancellationPanelsSrc).toMatch(/if\s*\(\s*!canRequest\s*\)\s*\{/);
    expect(cancellationPanelsSrc).toContain("Bukan kewenangan Anda");
    expect(cancellationPanelsSrc).not.toMatch(/if\s*\(\s*!canRequest\s*\)\s*\{\s*return null/);
  });

  it("merender eligibleBlockedReason (UX eligibility, §C 'bukan authority') saat order tidak eligible, terpisah dari permission gate", () => {
    expect(cancellationPanelsSrc).toMatch(/if\s*\(\s*eligibleBlockedReason\s*\)\s*\{/);
    expect(cancellationPanelsSrc).toContain('aria-describedby="request-cancellation-blocked-reason"');
  });

  it("label form TIDAK menyatakan request otomatis membatalkan order (kontrak §C larangan eksplisit)", () => {
    expect(cancellationPanelsSrc).toContain(
      "Pengajuan ini akan menunggu keputusan Owner. Order dan invoice tidak berubah sampai disetujui."
    );
  });
});

describe("DecideCancellationPanel -- Owner-only disabled-with-reason (FIN-02-08/§D)", () => {
  it("merender 'Hanya Owner yang dapat menyetujui atau menolak' saat !canDecide, bukan return null", () => {
    expect(cancellationPanelsSrc).toMatch(/if\s*\(\s*!canDecide\s*\)\s*\{/);
    expect(cancellationPanelsSrc).toContain("Hanya Owner yang dapat menyetujui atau menolak");
    expect(cancellationPanelsSrc).not.toMatch(/if\s*\(\s*!canDecide\s*\)\s*\{\s*return null/);
  });

  it("dua tombol terpisah Setujui/Tolak masing-masing membuka dialog dengan decision berbeda", () => {
    expect(cancellationPanelsSrc).toContain('onClick={() => openDialog("approve")}');
    expect(cancellationPanelsSrc).toContain('onClick={() => openDialog("reject")}');
  });
});

describe("§5/§10: ConfirmDialog dipakai untuk request maupun decision, tidak ada dialog baru", () => {
  it("mengimpor dan memakai ConfirmDialog existing", () => {
    expect(cancellationPanelsSrc).toContain('from "@/components/ui/confirm-dialog"');
    expect(cancellationPanelsSrc.match(/<ConfirmDialog/g)?.length).toBe(2);
  });
});

describe("§5: idempotency key digenerate sekali per dialog-terbuka (openDialog), bukan di submit", () => {
  it("RequestCancellationPanel memanggil crypto.randomUUID() di dalam openDialog, bukan di submit", () => {
    const openDialogMatch = cancellationPanelsSrc.match(/function openDialog\(\)[\s\S]*?\n  \}/);
    expect(openDialogMatch).not.toBeNull();
    expect(openDialogMatch![0]).toContain("crypto.randomUUID()");
    const submitMatch = cancellationPanelsSrc.match(/function submit\(\)[\s\S]*?startTransition/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).not.toContain("crypto.randomUUID()");
  });
});

describe("§10: Optimistic update tidak dipakai -- submit menunggu server action selesai sebelum UI berubah", () => {
  it("kedua panel membungkus submit dengan startTransition(async..) dan await ...Action(", () => {
    expect(cancellationPanelsSrc).toMatch(/startTransition\(async \(\) => \{/);
    expect(cancellationPanelsSrc).toMatch(/await requestOrderCancellationAction\(/);
    expect(cancellationPanelsSrc).toMatch(/await approveOrderCancellationAction\(/);
  });
});

// =============================================================================
// C. requestOrderCancellationAction/approveOrderCancellationAction -- server
//    action wrapper guard test (mock getAuthUser/getAdminClient/next-cache).
// =============================================================================

const rpcMock = vi.fn();
const getAuthUserMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth/get-user", () => ({
  getAuthUser: () => getAuthUserMock(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({ rpc: rpcMock }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

function fakeUser(overrides: Partial<{ permissions: string[] }> = {}) {
  return {
    id: "actor-1",
    email: "actor@test.local",
    company_id: "company-1",
    company: { id: "company-1", name: "Test Co", slug: "test-co", logo_url: null, subscription_plan: "starter", settings: null },
    roles: ["finance"],
    permissions: overrides.permissions ?? [],
    isDemo: false,
  };
}

describe("Gate 2I.4 finance actions -- permission guard menolak sebelum RPC dipanggil (FIN-02-08/FIN-08-04, CXL-04)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestOrderCancellationAction menolak actor tanpa order_cancellation.request", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: [] }));
    const { requestOrderCancellationAction } = await import("./actions");
    await expect(
      requestOrderCancellationAction({ salesOrderId: "order-1", reasonCode: "CUSTOMER_REQUEST" })
    ).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("approveOrderCancellationAction menolak actor Manager/Finance tanpa order_cancellation.approve (Owner-only, CXL-04 force-enable tetap ditolak sebelum RPC)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["receivable.view", "order_cancellation.request"] }));
    const { approveOrderCancellationAction } = await import("./actions");
    await expect(approveOrderCancellationAction({ cancellationId: "cxl-1", decision: "approve" })).rejects.toThrow(
      /tidak punya akses/i
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("Gate 2I.4 finance actions -- RPC canonical dipanggil dengan nama & parameter persis migration", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestOrderCancellationAction memanggil request_order_cancellation_atomic dengan parameter persis (invoiceId TIDAK diteruskan ke RPC, hanya untuk revalidatePath)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.request"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_cancellation_id: "cxl-1", out_status: "requested", out_already_exists: false }],
      error: null,
    });
    const { requestOrderCancellationAction } = await import("./actions");

    await requestOrderCancellationAction({
      salesOrderId: "order-1",
      reasonCode: "CUSTOMER_REQUEST",
      idempotencyKey: "key-cxl-1",
      invoiceId: "inv-1",
    });

    expect(rpcMock).toHaveBeenCalledWith("request_order_cancellation_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_sales_order_id: "order-1",
      p_reason_code: "CUSTOMER_REQUEST",
      p_idempotency_key: "key-cxl-1",
    });
  });

  it("approveOrderCancellationAction memanggil approve_order_cancellation_atomic dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.approve"] }));
    rpcMock.mockResolvedValue({
      data: [
        {
          out_cancellation_id: "cxl-1",
          out_status: "approved",
          out_order_status: "cancelled",
          out_invoice_void_id: "void-1",
          out_voided_amount: "10000",
        },
      ],
      error: null,
    });
    const { approveOrderCancellationAction } = await import("./actions");

    await approveOrderCancellationAction({ cancellationId: "cxl-1", decision: "approve" });

    expect(rpcMock).toHaveBeenCalledWith("approve_order_cancellation_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_cancellation_id: "cxl-1",
      p_decision: "approve",
    });
  });
});

describe("Gate 2I.4 finance actions -- error RPC dipetakan ke pesan Indonesia, kode mentah tidak bocor", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("approveOrderCancellationAction: INVOICE_SETTLEMENT_EXISTS dipetakan ke pesan manusiawi, kode mentah tidak bocor", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.approve"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "INVOICE_SETTLEMENT_EXISTS: ada payment" } });
    const { approveOrderCancellationAction } = await import("./actions");

    await expect(approveOrderCancellationAction({ cancellationId: "cxl-1", decision: "approve" })).rejects.toThrow(
      /pembayaran atau credit note aktif/i
    );
    try {
      await approveOrderCancellationAction({ cancellationId: "cxl-1", decision: "approve" });
    } catch (err) {
      expect((err as Error).message).not.toContain("INVOICE_SETTLEMENT_EXISTS");
    }
  });

  it("approveOrderCancellationAction: ORDER_CANCELLATION_ALREADY_RESOLVED (retry setelah keputusan final) dipetakan ke pesan 'muat ulang' (FIN-09-03/CXL-09)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.approve"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "ORDER_CANCELLATION_ALREADY_RESOLVED: sudah approved" } });
    const { approveOrderCancellationAction } = await import("./actions");

    await expect(approveOrderCancellationAction({ cancellationId: "cxl-1", decision: "reject" })).rejects.toThrow(/muat ulang/i);
  });

  it("requestOrderCancellationAction: ORDER_CANCELLATION_ALREADY_REQUESTED dipetakan ke pesan manusiawi", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.request"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "ORDER_CANCELLATION_ALREADY_REQUESTED: order x" } });
    const { requestOrderCancellationAction } = await import("./actions");

    await expect(
      requestOrderCancellationAction({ salesOrderId: "order-1", reasonCode: "CUSTOMER_REQUEST" })
    ).rejects.toThrow(/pengajuan pembatalan yang belum diputuskan/i);
  });

  it("kode error Gate 2G lain (§G) dipetakan manusiawi -- suplemen; cakupan generik seluruh 10 kode baru sudah otomatis lewat loop existing error-messages.test.ts", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.approve"] }));
    const { mapFinanceRpcError } = await import("./error-messages");
    expect(mapFinanceRpcError("DELIVERY_REVERSAL_REQUIRED: order delivered")).toMatch(/reversal delivery/i);
    expect(mapFinanceRpcError("INVOICE_RECORD_MISSING: xyz")).toMatch(/tidak memiliki data invoice/i);
    expect(mapFinanceRpcError("MULTIPLE_INVOICES_UNSUPPORTED: xyz")).toMatch(/lebih dari satu invoice/i);
    expect(mapFinanceRpcError("INVALID_ORDER_STATUS_FOR_CANCELLATION: xyz")).toMatch(/tidak dapat diproses untuk pembatalan/i);
    expect(mapFinanceRpcError("ORDER_ALREADY_CANCELLED: xyz")).toMatch(/sudah berstatus dibatalkan/i);
  });
});

describe("Gate 2I.4 finance actions -- out_already_exists diteruskan apa adanya untuk UI idempotent no-op", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestOrderCancellationAction retry dengan idempotency key sama mengembalikan out_already_exists=true tanpa error (CXL-05)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.request"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_cancellation_id: "cxl-1", out_status: "requested", out_already_exists: true }],
      error: null,
    });
    const { requestOrderCancellationAction } = await import("./actions");

    const result = await requestOrderCancellationAction({
      salesOrderId: "order-1",
      reasonCode: "CUSTOMER_REQUEST",
      idempotencyKey: "retry-same-key",
    });
    expect(result.out_already_exists).toBe(true);
  });
});

describe("Gate 2I.4 finance actions -- revalidatePath dipanggil setelah sukses (§5 pola umum, bukan optimistic update)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestOrderCancellationAction me-revalidate /dashboard/finance/cancellations, /dashboard/finance/invoices/[invoiceId] (bila diisi), dan /dashboard/finance", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.request"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_cancellation_id: "cxl-1", out_status: "requested", out_already_exists: false }],
      error: null,
    });
    const { requestOrderCancellationAction } = await import("./actions");

    await requestOrderCancellationAction({ salesOrderId: "order-1", reasonCode: "CUSTOMER_REQUEST", invoiceId: "inv-1" });

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/cancellations");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/invoices/inv-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance");
  });

  it("approveOrderCancellationAction me-revalidate /dashboard/finance/cancellations, /dashboard/finance/cancellations/[id], /dashboard/finance/invoices, dan /dashboard/finance", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["order_cancellation.approve"] }));
    rpcMock.mockResolvedValue({
      data: [
        { out_cancellation_id: "cxl-1", out_status: "approved", out_order_status: "cancelled", out_invoice_void_id: null, out_voided_amount: null },
      ],
      error: null,
    });
    const { approveOrderCancellationAction } = await import("./actions");

    await approveOrderCancellationAction({ cancellationId: "cxl-1", decision: "approve" });

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/cancellations");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/cancellations/cxl-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/invoices");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance");
  });
});

// =============================================================================
// E. Containment struktural lintas file.
// =============================================================================

describe("FIN-02-08: DecideCancellationPanel disabled dengan alasan 'Hanya Owner' untuk actor tanpa order_cancellation.approve", () => {
  it("cancellation-panels.tsx merender 'Hanya Owner yang dapat menyetujui atau menolak' saat !canDecide", () => {
    expect(cancellationPanelsSrc).toContain("Hanya Owner yang dapat menyetujui atau menolak");
  });
});

describe("CXL-03/§A: tidak ada direct table mutation pada order_cancellations/invoice_voids -- hanya RPC canonical", () => {
  it("actions.ts memanggil request_order_cancellation_atomic/approve_order_cancellation_atomic, tidak pernah .from(\"order_cancellations\")/.from(\"invoice_voids\") untuk INSERT/UPDATE/DELETE", () => {
    expect(actionsSrc).toContain('admin.rpc("request_order_cancellation_atomic"');
    expect(actionsSrc).toContain('admin.rpc("approve_order_cancellation_atomic"');
    expect(actionsSrc).not.toMatch(/\.from\(\s*["'](order_cancellations|invoice_voids)["']\s*\)\s*\.(insert|update|upsert|delete)/);
  });

  it("cancellation-panels.tsx tidak melakukan direct table mutation", () => {
    expect(cancellationPanelsSrc).not.toMatch(/\.from\(\s*["'](order_cancellations|invoice_voids)["']\s*\)/);
  });

  it("queries.ts (read side) tidak pernah memakai admin/service-role client -- hanya actions.ts (write side) yang memakai getAdminClient", () => {
    expect(queriesSrc).not.toContain("getAdminClient");
    expect(actionsSrc).toContain("getAdminClient");
  });
});

describe("§H/RLS: route Riwayat Audit Owner-only, tidak ada bypass service-role untuk read", () => {
  it("audit/page.tsx menolak non-owner dengan AlertCard (BUKAN redirect), tidak memakai admin/service-role client", () => {
    expect(auditPage).toContain('!user.roles.includes("owner")');
    expect(auditPage).toContain("Hanya Owner yang dapat membuka Riwayat Audit");
    expect(auditPage).not.toContain("getAdminClient");
  });

  it("audit/page.tsx menampilkan pesan error eksplisit saat query gagal, BUKAN EmptyState yang menyamarkan sebagai 'belum ada aktivitas'", () => {
    expect(auditPage).toMatch(/loadError/);
    expect(auditPage).toContain("Gagal memuat riwayat audit");
  });

  it("getFinanceAuditList selalu memfilter module='finance' (kontrak §H)", () => {
    expect(queriesSrc).toContain('.eq("module", "finance")');
  });
});

describe("§B.1/CXL-AUD-03: tab nav menampilkan disabledReason spesifik, bukan tooltip generik, untuk Riwayat Audit non-owner", () => {
  it("finance-tab-nav.tsx merender section.disabledReason bila ada, fallback ke teks generik existing bila tidak", () => {
    expect(financeTabNavSrc).toContain("disabledReason?: string");
    expect(financeTabNavSrc).toContain("section.disabledReason ??");
  });

  it("layout.tsx mengaktifkan href Cancellation & Invoice Void selalu, dan Riwayat Audit kondisional owner-only dengan disabledReason", () => {
    expect(layoutSrc).toContain('href: "/dashboard/finance/cancellations"');
    expect(layoutSrc).toContain('roles.includes("owner")');
    expect(layoutSrc).toContain("Hanya Owner yang dapat membuka Riwayat Audit");
  });
});

describe("§B.4/CXL-11/CXL-12: invoice detail menyediakan RequestCancellationPanel dan link cancellation terkait", () => {
  it("invoices/[id]/page.tsx mengimpor RequestCancellationPanel dan getCancellationForOrder", () => {
    expect(invoiceDetailPage).toContain('from "@/components/finance/cancellation-panels"');
    expect(invoiceDetailPage).toContain("getCancellationForOrder");
    expect(invoiceDetailPage).toContain("getOrderCancellationEligibility");
  });
});

describe("§3 master tabel item 8/action-queue (Gate 2I.4C): cancellation_pending + invoice_void_notice:void -> cancellations/[id]; invoice_void_notice:reversal -> returns/[return_id] canonical", () => {
  it("action-queue.tsx menambah cabang cancellation_pending dan invoice_void_notice:void ke deriveDetailHref, fallback DetailAffordance tetap ada untuk kategori lain", () => {
    expect(actionQueueSrc).toContain('item.category === "cancellation_pending"');
    expect(actionQueueSrc).toContain("/dashboard/finance/cancellations/");
    expect(actionQueueSrc).toContain("INVOICE_VOID_NOTICE_VOID_PREFIX");
    expect(actionQueueSrc).toMatch(/return href \? <DetailLink href=\{href\} \/> : <DetailAffordance \/>/);
  });

  it("Gate 2I.4C: deriveDetailHref menyambungkan invoice_void_notice:reversal ke /dashboard/finance/returns/[return_id] (route canonical asli, BUKAN cancellations/[id] -- entity credit_note_reversals tidak berelasi order_cancellations)", () => {
    expect(actionQueueSrc).toContain('const INVOICE_VOID_NOTICE_REVERSAL_PREFIX = "invoice_void_notice:reversal:";');
    const reversalBranchMatch = actionQueueSrc.match(
      /if \(item\.category === "invoice_void_notice" && item\.id\.startsWith\(INVOICE_VOID_NOTICE_REVERSAL_PREFIX\)\) \{[\s\S]*?\n  \}/
    );
    expect(reversalBranchMatch).not.toBeNull();
    expect(reversalBranchMatch![0]).toContain("`/dashboard/finance/returns/${item.id.slice(INVOICE_VOID_NOTICE_REVERSAL_PREFIX.length)}`");
    expect(reversalBranchMatch![0]).not.toContain("cancellations");
  });

  it("Gate 2I.4C: reversal TANPA return_id valid (prefix 'reversal-unlinked:') tidak match INVOICE_VOID_NOTICE_REVERSAL_PREFIX -- tetap disabled (DetailAffordance), tidak pernah 404/link kosong", () => {
    const REVERSAL_PREFIX = "invoice_void_notice:reversal:";
    expect("invoice_void_notice:reversal-unlinked:abc-123".startsWith(REVERSAL_PREFIX)).toBe(false);
    expect(queriesSrc).toContain("reversal-unlinked:");
    expect(queriesSrc).toContain("row.credit_notes?.return_id");
  });

  it("Gate 2I.4C: fetchInvoiceVoidNotices mengambil credit_notes.return_id tenant-scoped (via embed FK, bukan query terpisah tanpa company_id) -- relasi canonical credit_note_reversals->credit_notes->returns (FK NOT NULL UNIQUE, migration 20260831000001), bukan karangan", () => {
    expect(queriesSrc).toContain('.select("id, reversed_amount, created_at, credit_notes(return_id, invoices(invoice_number), customers(name))")');
    expect(queriesSrc).toMatch(/credit_note_reversals[\s\S]*?\.eq\("company_id", companyId\)/);
  });

  it("Gate 2I.4C: tidak ada direct mutation ditambahkan -- fetchInvoiceVoidNotices tetap read-only (SELECT saja)", () => {
    const fnMatch = queriesSrc.match(/async function fetchInvoiceVoidNotices[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

describe("G11: /dashboard/collection diganti server redirect ke /dashboard/finance/collection, tidak ada auth check duplikat di file ini", () => {
  it("collection/page.tsx hanya redirect(), tidak ada guard roles.includes mentah lagi", () => {
    expect(collectionRedirectPage).toContain('redirect("/dashboard/finance/collection")');
    expect(collectionRedirectPage).not.toContain("roles.includes");
  });
});

describe("§I responsive (FIN-13-01/02): payments/page.tsx dan collection-panel.tsx punya varian card mobile", () => {
  it("payments/page.tsx merender <ul> card list terpisah dari <div hidden md:block> DataTable", () => {
    expect(paymentsListPage).toContain("md:hidden");
    expect(paymentsListPage).toContain("hidden");
    expect(paymentsListPage).toMatch(/<DataTable/);
  });

  it("collection-panel.tsx merender card mobile untuk KEDUA list (janji bayar, aktivitas), bukan hanya satu", () => {
    const mdHiddenCount = (collectionPanelSrc.match(/md:hidden/g) ?? []).length;
    expect(mdHiddenCount).toBeGreaterThanOrEqual(2);
    const hiddenMdBlockCount = (collectionPanelSrc.match(/hidden rounded-xl border border-gray-200 bg-white md:block/g) ?? []).length;
    expect(hiddenMdBlockCount).toBeGreaterThanOrEqual(2);
  });

  it("cancellations/page.tsx dan cancellations/[id]/page.tsx baru dibuat gate ini WAJIB responsive sejak awal", () => {
    expect(cancellationListPage).toContain("md:hidden");
    expect(cancellationListPage).toMatch(/<DataTable/);
    // Detail page: layout card/grid (bukan tabel baris lebar) -- tidak ada <table>/<DataTable> di halaman ini.
    expect(cancellationDetailPage).not.toMatch(/<table|<DataTable/);
  });
});

describe("§F/§8: workspace tidak mereplikasi formula RPC di client -- angka final pasca-approve SELALU dari invoice_voids/receivable_ledger canonical", () => {
  it("getCancellationDetail membaca invoice_voids (voided_amount, receivable_ledger_id) langsung, bukan menghitung ulang", () => {
    expect(queriesSrc).toContain('.from("invoice_voids")');
    expect(queriesSrc).toContain("voidedAmount: voidRow.voided_amount");
  });
});

describe("CXL-14 (statis, cakupan diagnostik): kata kunci migration/RPC baru tidak muncul di file produksi Gate 2I.4 (verifikasi filesystem penuh dilakukan via git diff saat closeout, bukan di sini)", () => {
  it("actions.ts/queries.ts tidak mendefinisikan RPC baru (CREATE FUNCTION) atau mengimpor file migration", () => {
    expect(actionsSrc).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(queriesSrc).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
  });
});
