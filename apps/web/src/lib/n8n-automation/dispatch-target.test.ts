import { afterEach, describe, expect, it } from "vitest";
import { resolveTelegramTarget, resolveWhatsAppTarget } from "./dispatch-target";

describe("resolveWhatsAppTarget -- pagar test override (insiden 2026-08-22)", () => {
  afterEach(() => {
    delete process.env.BABLAST_TEST_OVERRIDE_PHONE;
  });

  it("override TIDAK diset -> pakai recipient_reference asli (perilaku produksi normal)", () => {
    expect(resolveWhatsAppTarget("6287778404085")).toBe("6287778404085");
  });

  it("override diset -> SELALU pakai nomor override, recipient_reference asli diabaikan sepenuhnya", () => {
    process.env.BABLAST_TEST_OVERRIDE_PHONE = "6285287539900";
    expect(resolveWhatsAppTarget("6287778404085")).toBe("6285287539900");
  });

  it("override diset ke string kosong -> dianggap tidak aktif (fallback ke asli, bukan kirim ke nomor kosong)", () => {
    process.env.BABLAST_TEST_OVERRIDE_PHONE = "";
    expect(resolveWhatsAppTarget("6287778404085")).toBe("6287778404085");
  });
});

describe("resolveTelegramTarget -- pagar test override yang sama untuk Telegram", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_TEST_OVERRIDE_CHAT_ID;
  });

  it("override TIDAK diset -> pakai recipient_reference asli", () => {
    expect(resolveTelegramTarget("123456789")).toBe(123456789);
  });

  it("override diset -> SELALU pakai chat id override", () => {
    process.env.TELEGRAM_TEST_OVERRIDE_CHAT_ID = "999999999";
    expect(resolveTelegramTarget("123456789")).toBe(999999999);
  });
});
