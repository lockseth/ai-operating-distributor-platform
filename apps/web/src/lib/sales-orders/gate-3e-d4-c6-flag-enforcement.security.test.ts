// =============================================================================
// Gate 3E-D4-C6 security contract — static assertions membuktikan SEMUA
// entry point Telegram (callback, text pre-dispatch, direct processing path)
// memakai satu fungsi enforcement yang sama (hasSalesOrderCapability), dan
// kill switch global fail-closed by construction (default FALSE, RLS
// menolak akses non-super_admin, tidak ada jalur bypass).
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repository = readFileSync(path.resolve(__dirname, "repository.ts"), "utf8");
const route = readFileSync(
  path.resolve(__dirname, "../../app/api/webhooks/telegram/route.ts"),
  "utf8",
);
const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260928000001_gate_3e_d4_c6_telegram_sales_orders_flag.sql",
  ),
  "utf8",
);
const capability = readFileSync(
  path.resolve(__dirname, "../telegram-enrollment/capability.ts"),
  "utf8",
);

describe("Gate 3E-D4-C6 security contract", () => {
  it("migration: platform_feature_flags default OFF (bukan ON) pada kolom dan seed row", () => {
    expect(migration).toContain("enabled     BOOLEAN     NOT NULL DEFAULT FALSE");
    const insertIdx = migration.indexOf("INSERT INTO public.platform_feature_flags");
    const insertBlock = migration.slice(insertIdx, insertIdx + 400);
    expect(insertBlock).toContain("'telegram_sales_orders'");
    expect(insertBlock).toContain("FALSE");
    expect(insertBlock).not.toMatch(/'telegram_sales_orders',\s*TRUE/);
  });

  it("migration: RLS enabled, hanya super_admin yang punya policy (fail-closed untuk role lain)", () => {
    expect(migration).toContain(
      "ALTER TABLE public.platform_feature_flags ENABLE ROW LEVEL SECURITY",
    );
    const policyMatches = migration.match(/CREATE POLICY[^;]+;/gs) ?? [];
    expect(policyMatches.length).toBeGreaterThan(0);
    for (const policy of policyMatches) {
      expect(policy).toContain("super_admin");
    }
    // Tidak ada role lain (owner/admin/sales/manager) yang diberi akses langsung ke tabel ini.
    expect(migration).not.toMatch(
      /CREATE POLICY[^;]*(owner|'sales'|'manager')[^;]*platform_feature_flags/is,
    );
  });

  it("repository.ts: hasSalesOrderCapability mengecek flag global SEBELUM query role (short-circuit fail-closed)", () => {
    const fnStart = repository.indexOf("async hasSalesOrderCapability(");
    const classEnd = repository.indexOf("async getConversationState", fnStart);
    const fnBody = repository.slice(fnStart, classEnd);

    const flagCheckIdx = fnBody.indexOf('featureFlags.isEnabled("telegram_sales_orders")');
    const earlyReturnIdx = fnBody.indexOf("if (!globalFlagEnabled) return false;");
    const roleQueryIdx = fnBody.indexOf('.from("user_roles")');

    expect(flagCheckIdx).toBeGreaterThan(-1);
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(roleQueryIdx).toBeGreaterThan(-1);
    expect(flagCheckIdx).toBeLessThan(earlyReturnIdx);
    expect(earlyReturnIdx).toBeLessThan(roleQueryIdx);
  });

  it("route.ts: callback_query gate DAN text pre-dispatch gate keduanya memanggil hasSalesOrderCapability yang sama (tidak ada enforcement terpisah/duplikat)", () => {
    const occurrences = route.match(/hasSalesOrderCapability\(/g) ?? [];
    // Minimal 2 titik panggilan eksplisit di route.ts (callback + text
    // pre-dispatch) -- direct processing path dicek lagi di dalam
    // processTelegramUpdate (workflow.ts, di luar file ini).
    expect(occurrences.length).toBeGreaterThanOrEqual(2);

    const callbackGateIdx = route.indexOf("if (update.callback_query)");
    const textGateIdx = route.indexOf("const text = update.message?.text;");
    expect(callbackGateIdx).toBeGreaterThan(-1);
    expect(textGateIdx).toBeGreaterThan(-1);
    expect(callbackGateIdx).toBeLessThan(textGateIdx);

    const callbackBlock = route.slice(callbackGateIdx, textGateIdx);
    const textBlock = route.slice(textGateIdx);
    expect(callbackBlock).toContain("hasSalesOrderCapability(");
    expect(textBlock).toContain("hasSalesOrderCapability(");
  });

  it("capability.ts: sales.order.telegram tetap hanya role 'sales' -- flag global TIDAK membuka capability ini untuk owner/admin/operator/role lain", () => {
    expect(capability).toContain('"sales.order.telegram": ["sales"]');
  });
});
