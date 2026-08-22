import { describe, expect, it } from "vitest";
import { InMemorySalesmanDirectory } from "./salesman-directory";

const COMPANY = "company-1";

describe("listEligibleWhatsAppRecipients -- Gate P4.15 (Morning Brief pindah ke WhatsApp)", () => {
  it("salesman aktif + punya nomor -> masuk, nomor dinormalisasi ke format 62xxx", async () => {
    const dir = new InMemorySalesmanDirectory();
    dir.seedSalesman({ userId: "u1", companyId: COMPANY, fullName: "Budi", phone: "087778404085" });

    const result = await dir.listEligibleWhatsAppRecipients(COMPANY);
    expect(result).toEqual([
      { userId: "u1", fullName: "Budi", phone: "6287778404085", coverageAreas: [] },
    ]);
  });

  it("salesman tanpa nomor -> tidak muncul di hasil", async () => {
    const dir = new InMemorySalesmanDirectory();
    dir.seedSalesman({ userId: "u1", companyId: COMPANY, fullName: "Budi", phone: null });

    const result = await dir.listEligibleWhatsAppRecipients(COMPANY);
    expect(result).toHaveLength(0);
  });

  it("salesman nonaktif -> tidak muncul walau punya nomor", async () => {
    const dir = new InMemorySalesmanDirectory();
    dir.seedSalesman({ userId: "u1", companyId: COMPANY, fullName: "Budi", phone: "087778404085", isActive: false });

    const result = await dir.listEligibleWhatsAppRecipients(COMPANY);
    expect(result).toHaveLength(0);
  });

  it("salesman company lain -> tidak ikut ke hasil tenant ini", async () => {
    const dir = new InMemorySalesmanDirectory();
    dir.seedSalesman({ userId: "u1", companyId: "company-lain", fullName: "Budi", phone: "087778404085" });

    const result = await dir.listEligibleWhatsAppRecipients(COMPANY);
    expect(result).toHaveLength(0);
  });

  it("Morning Brief (Telegram, eligible-recipient lama) TIDAK terpengaruh -- tetap dipakai 3 laporan Owner lain", async () => {
    const dir = new InMemorySalesmanDirectory();
    dir.seedSalesman({
      userId: "u1",
      companyId: COMPANY,
      fullName: "Budi",
      phone: "087778404085",
      telegramChatId: "123456",
    });

    const telegramResult = await dir.listEligibleMorningBriefRecipients(COMPANY);
    expect(telegramResult).toEqual([
      { userId: "u1", fullName: "Budi", telegramChatId: "123456", coverageAreas: [] },
    ]);
  });
});
