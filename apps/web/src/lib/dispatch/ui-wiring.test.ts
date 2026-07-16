// =============================================================================
// AI Dispatch Planner — Minimal UI + Wiring Gate: proportional tests.
//
// Codebase ini tidak punya infra React component-rendering test sama sekali
// (vitest.config.ts: environment "node", tidak ada @testing-library/react/
// jsdom, dan tidak satu pun actions.ts di seluruh repo yang di-unit-test
// langsung -- hanya workflow.ts). Menambah infra rendering baru untuk satu
// gate UI minimal tidak proporsional. Test di sini memverifikasi kontrak
// wiring lewat pembacaan source (architecture fitness function) + data
// murni (STATUS_CONFIG), konsisten dengan pola pengujian yang sudah ada.
//
// Behavior planDispatch() sendiri TIDAK diuji ulang di sini -- tetap
// tercakup penuh oleh workflow.test.ts (9 skenario, tidak diubah oleh gate
// ini).
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { STATUS_CONFIG } from "@/components/dispatch/dispatch-status-badge";
import type { PlanningStatus } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const actionsSource = readFileSync(path.resolve(__dirname, "actions.ts"), "utf-8");
const errorBoundarySource = readFileSync(
  path.resolve(__dirname, "../../app/(dashboard)/dashboard/dispatch/error.tsx"),
  "utf-8"
);
const pageSource = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/dashboard/dispatch/page.tsx"), "utf-8");

describe("AI Dispatch Planner — UI wiring", () => {
  it("1+6. actions.ts memanggil workflow (runDispatchPlanning), TIDAK memanggil planDispatch()/service.ts langsung", () => {
    expect(actionsSource).toContain('from "./workflow"');
    expect(actionsSource).toContain("runDispatchPlanning");
    expect(actionsSource).not.toContain('from "./service"');
    expect(actionsSource).not.toContain("planDispatch(");
  });

  it("2. Server action tidak menerima company_id/companyId dari caller — hanya salesOrderId/planId + payload", () => {
    // Signature createDispatchPlanAction(salesOrderId: string), overrideDispatchPlanAction(planId, input),
    // markReadyForDeliveryAction(planId) -- company_id hanya boleh muncul sebagai HASIL getAuthUser(), bukan parameter.
    const exportedFunctionSignatures = actionsSource.match(/export async function \w+\([^)]*\)/g) ?? [];
    expect(exportedFunctionSignatures.length).toBeGreaterThan(0);
    for (const sig of exportedFunctionSignatures) {
      expect(sig.toLowerCase()).not.toMatch(/company_?id\s*:/);
    }
    // Tenant SELALU dari sesi server-side.
    expect(actionsSource).toContain("getAuthUser()");
    expect(actionsSource).toContain("user.company_id");
  });

  it("3. Terminologi UI status memakai 'Salesman', tidak pernah 'Driver'/'Pengirim'", () => {
    const labels = Object.values(STATUS_CONFIG as Record<PlanningStatus, { label: string }>).map((c) => c.label);
    for (const label of labels) {
      expect(label).not.toMatch(/driver|pengirim/i);
    }
    // Seluruh PlanningStatus (10 nilai) wajib punya label -- tidak ada status yang jatuh ke fallback generik.
    const allStatuses: PlanningStatus[] = [
      "document_ready", "waiting_planning", "planned", "scheduled", "ready_for_delivery",
      "waiting_stock", "customer_requested_delay", "manual_hold", "route_conflict", "cancelled",
    ];
    for (const status of allStatuses) {
      expect((STATUS_CONFIG as Record<string, unknown>)[status]).toBeDefined();
    }
  });

  it("4. Halaman menampilkan salesman assignee (assigned_actor), bukan field 'driver'", () => {
    expect(pageSource).toContain("assigned_actor");
    expect(pageSource.toLowerCase()).not.toMatch(/\bdriver\b/);
  });

  it("5. Empty state ditampilkan saat tidak ada plan maupun order kandidat", () => {
    expect(pageSource).toContain("EmptyState");
    expect(pageSource).toContain("plans.length === 0 && candidateOrders.length === 0");
  });

  it("7. Error boundary tidak membocorkan detail internal (tidak me-render error.message/stack)", () => {
    expect(errorBoundarySource).toContain("export default function");
    // Boleh log ke console (observability developer), TAPI tidak boleh dirender ke JSX/UI.
    expect(errorBoundarySource).not.toMatch(/\{error\.message\}/);
    expect(errorBoundarySource).not.toMatch(/\{error\.stack\}/);
    expect(errorBoundarySource).not.toMatch(/\{error\.digest\}/);
  });

  it("8. dispatch_plans query di halaman selalu di-scope company_id (RLS-consistent, tidak trust input client)", () => {
    expect(pageSource).toContain('.eq("company_id", companyId)');
    expect(pageSource).toContain("getAuthUser()");
  });
});

// =============================================================================
// Human Review & Operational Control Gate — pelengkap structural. Bukti
// keamanan mutation yang sebenarnya ada di human-review.test.ts (behavioral).
// =============================================================================

const detailPageSource = readFileSync(
  path.resolve(__dirname, "../../app/(dashboard)/dashboard/dispatch/[id]/page.tsx"),
  "utf-8"
);
const assignFormSource = readFileSync(
  path.resolve(__dirname, "../../components/dispatch/assign-salesman-form.tsx"),
  "utf-8"
);
const acceptButtonSource = readFileSync(
  path.resolve(__dirname, "../../components/dispatch/accept-plan-button.tsx"),
  "utf-8"
);
const holdFormSource = readFileSync(path.resolve(__dirname, "../../components/dispatch/hold-plan-form.tsx"), "utf-8");

describe("AI Dispatch Planner — Human Review & Operational Control", () => {
  it("11. Setiap mutation action baru memeriksa permission (fail-closed) sebelum memakai admin client", () => {
    const newActionSignatures = ["assignSalesmanAction", "acceptDispatchPlanAction"];
    for (const fnName of newActionSignatures) {
      const start = actionsSource.indexOf(`export async function ${fnName}`);
      expect(start).toBeGreaterThan(-1);
      const body = actionsSource.slice(start, start + 700);
      const authIdx = body.indexOf("getAuthUser()");
      const permIdx = body.indexOf("hasPermission(");
      const adminIdx = body.indexOf("getAdminClient()");
      expect(authIdx).toBeGreaterThan(-1);
      expect(permIdx).toBeGreaterThan(-1);
      expect(adminIdx).toBeGreaterThan(-1);
      // Urutan wajib: auth session -> permission check -> baru admin client.
      expect(authIdx).toBeLessThan(permIdx);
      expect(permIdx).toBeLessThan(adminIdx);
    }
  });

  it("12. Seluruh UI baru (review page + form) memakai 'Salesman', tidak pernah 'Driver'/'Pengirim'", () => {
    for (const src of [detailPageSource, assignFormSource, acceptButtonSource, holdFormSource]) {
      expect(src.toLowerCase()).not.toMatch(/\bdriver\b/);
      expect(src.toLowerCase()).not.toMatch(/\bpengirim\b/);
    }
    expect(detailPageSource).toContain("Salesman");
    expect(assignFormSource).toContain("Salesman");
  });

  it("13. Error dari mutation baru tidak pernah forward raw exception/error.message ke client", () => {
    // assignSalesmanAction & acceptDispatchPlanAction hanya mengembalikan
    // string terkontrol dari outcome union (invalid_input/invalid_actor/
    // not_acceptable/plan_not_found) -- tidak ada `catch` yang meneruskan
    // error.message mentah ke DispatchActionResult.
    expect(actionsSource).not.toMatch(/error:\s*error\.message/);
    expect(actionsSource).not.toMatch(/error:\s*err\.message/);
    expect(actionsSource).not.toMatch(/catch\s*\(\s*error\s*\)/);
  });

  it("Review page menampilkan riwayat event (dispatch_plan_events) dan indikator human-modified (is_override)", () => {
    expect(detailPageSource).toContain("dispatch_plan_events");
    expect(detailPageSource).toContain("is_override");
    expect(detailPageSource).toContain(".eq(\"company_id\", user.company_id)");
  });

  it("Halaman/action tidak mengarang PlanningStatus baru (mis. 'rejected') di luar enum existing", () => {
    for (const src of [actionsSource, detailPageSource]) {
      expect(src).not.toMatch(/"rejected"/);
      expect(src).not.toMatch(/'rejected'/);
    }
  });

  it("assignSalesmanAction dan acceptDispatchPlanAction memanggil workflow (bukan query dispatch_plans langsung untuk mutasi)", () => {
    expect(actionsSource).toContain("assignSalesman(");
    expect(actionsSource).toContain("acceptDispatchPlan(");
  });
});
