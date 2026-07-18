import { describe, expect, it } from "vitest";
import { detectOrderSource } from "@/lib/sales-orders/order-source";
import type { MenuConversationState } from "../conversation";
import {
  buildTaggedOrderText,
  handleOrderIntakeSourceChoice,
  isPendingOrderIntakeText,
  startOrderIntakeFlow,
} from "./order-intake";

describe("Input Order WA/Telepon -- 15, 16 (remote order tidak pernah membuat Call/EC)", () => {
  it("startOrderIntakeFlow menanyakan sumber, belum menandai teks apa pun", () => {
    const result = startOrderIntakeFlow();
    expect(result.message).toContain("WhatsApp");
    expect(result.message).toContain("Telepon");
    expect(result.nextState.awaiting).toBe("order_intake_awaiting_text");
    expect(isPendingOrderIntakeText(result.nextState)).toBe(false);
  });

  it("pilih '1' -> WhatsApp, isPendingOrderIntakeText jadi true (siap menandai pesan order berikutnya)", () => {
    const { nextState: step1 } = startOrderIntakeFlow();
    const step2 = handleOrderIntakeSourceChoice("1", step1);
    expect(step2.nextState.draft.orderSource).toBe("CUSTOMER_WHATSAPP");
    expect(isPendingOrderIntakeText(step2.nextState)).toBe(true);
  });

  it("pilih '2' -> Telepon", () => {
    const { nextState: step1 } = startOrderIntakeFlow();
    const step2 = handleOrderIntakeSourceChoice("2", step1);
    expect(step2.nextState.draft.orderSource).toBe("CUSTOMER_PHONE");
  });

  it("pilihan tidak valid -> state tidak berubah, tidak pernah jadi 'pending text'", () => {
    const { nextState: step1 } = startOrderIntakeFlow();
    const step2 = handleOrderIntakeSourceChoice("3", step1);
    expect(step2.nextState).toEqual(step1);
    expect(isPendingOrderIntakeText(step2.nextState)).toBe(false);
  });

  it("15. buildTaggedOrderText(WhatsApp) -> detectOrderSource() (TERKUNCI) mengklasifikasikan CUSTOMER_WHATSAPP", () => {
    const { nextState: step1 } = startOrderIntakeFlow();
    const { nextState: pending } = handleOrderIntakeSourceChoice("1", step1);
    const tagged = buildTaggedOrderText(pending, "Toko Sari pesan 10 dus indomie goreng");
    expect(detectOrderSource(tagged)).toBe("CUSTOMER_WHATSAPP");
  });

  it("16. buildTaggedOrderText(Telepon) -> detectOrderSource() mengklasifikasikan CUSTOMER_PHONE", () => {
    const { nextState: step1 } = startOrderIntakeFlow();
    const { nextState: pending } = handleOrderIntakeSourceChoice("2", step1);
    const tagged = buildTaggedOrderText(pending, "Toko Sari pesan 10 dus indomie goreng");
    expect(detectOrderSource(tagged)).toBe("CUSTOMER_PHONE");
  });

  it("penanda tidak pernah bocor jadi REPEAT_ORDER atau FIELD_VISIT", () => {
    const { nextState: step1 } = startOrderIntakeFlow();
    const wa = handleOrderIntakeSourceChoice("1", step1).nextState;
    const phone = handleOrderIntakeSourceChoice("2", step1).nextState;
    expect(detectOrderSource(buildTaggedOrderText(wa, "pesan barang biasa"))).not.toBe("REPEAT_ORDER");
    expect(detectOrderSource(buildTaggedOrderText(wa, "pesan barang biasa"))).not.toBe("FIELD_VISIT");
    expect(detectOrderSource(buildTaggedOrderText(phone, "pesan barang biasa"))).not.toBe("REPEAT_ORDER");
    expect(detectOrderSource(buildTaggedOrderText(phone, "pesan barang biasa"))).not.toBe("FIELD_VISIT");
  });

  it("isPendingOrderIntakeText false untuk state di luar order_intake_awaiting_text", () => {
    const other: MenuConversationState = { awaiting: "main_menu", draft: { orderSource: "CUSTOMER_WHATSAPP" } };
    expect(isPendingOrderIntakeText(other)).toBe(false);
  });
});
