import { describe, expect, it } from "vitest";
import { decideAlertNotification, callTimingEntityKey, type BusinessGuardRiskLevel } from "./alert-state";

describe("decideAlertNotification", () => {
  it("1. entitas baru, observasi pertama HIGH, previous=null -> notify=true", () => {
    const result = decideAlertNotification("HIGH", null);
    expect(result.shouldNotify).toBe(true);
    expect(result.nextLastNotifiedRiskLevel).toBe("HIGH");
  });

  it("2. entitas baru, observasi pertama MEDIUM, notifiableLevels=[HIGH] -> notify=false, next=null", () => {
    const result = decideAlertNotification("MEDIUM", null, ["HIGH"]);
    expect(result.shouldNotify).toBe(false);
    expect(result.nextLastNotifiedRiskLevel).toBeNull();
  });

  it("3. entitas baru, observasi pertama MEDIUM, notifiableLevels=[HIGH,MEDIUM] (unremitted) -> notify=true, next=MEDIUM", () => {
    const result = decideAlertNotification("MEDIUM", null, ["HIGH", "MEDIUM"]);
    expect(result.shouldNotify).toBe(true);
    expect(result.nextLastNotifiedRiskLevel).toBe("MEDIUM");
  });

  it("4. masih HIGH: previous.lastNotifiedRiskLevel=HIGH, current=HIGH -> notify=false", () => {
    const result = decideAlertNotification("HIGH", { lastNotifiedRiskLevel: "HIGH" });
    expect(result.shouldNotify).toBe(false);
    expect(result.nextLastNotifiedRiskLevel).toBe("HIGH");
  });

  it("5. turun: previous=HIGH, current=NONE -> notify=false, next=null (reset)", () => {
    const result = decideAlertNotification("NONE", { lastNotifiedRiskLevel: "HIGH" });
    expect(result.shouldNotify).toBe(false);
    expect(result.nextLastNotifiedRiskLevel).toBeNull();
  });

  it("6. HIGH->NONE->HIGH langkah 3: previous=null (hasil reset langkah 5), current=HIGH -> notify=true", () => {
    const result = decideAlertNotification("HIGH", { lastNotifiedRiskLevel: null });
    expect(result.shouldNotify).toBe(true);
    expect(result.nextLastNotifiedRiskLevel).toBe("HIGH");
  });

  it("7. HIGH->MEDIUM->HIGH (unremitted) langkah 2: previous=HIGH, current=MEDIUM -> notify=true, next=MEDIUM", () => {
    const result = decideAlertNotification("MEDIUM", { lastNotifiedRiskLevel: "HIGH" }, ["HIGH", "MEDIUM"]);
    expect(result.shouldNotify).toBe(true);
    expect(result.nextLastNotifiedRiskLevel).toBe("MEDIUM");
  });

  it("8. HIGH->MEDIUM->HIGH langkah 3: previous=MEDIUM, current=HIGH -> notify=true", () => {
    const result = decideAlertNotification("HIGH", { lastNotifiedRiskLevel: "MEDIUM" }, ["HIGH", "MEDIUM"]);
    expect(result.shouldNotify).toBe(true);
    expect(result.nextLastNotifiedRiskLevel).toBe("HIGH");
  });

  it("9. masih MEDIUM (unremitted): previous=MEDIUM, current=MEDIUM -> notify=false", () => {
    const result = decideAlertNotification("MEDIUM", { lastNotifiedRiskLevel: "MEDIUM" }, ["HIGH", "MEDIUM"]);
    expect(result.shouldNotify).toBe(false);
    expect(result.nextLastNotifiedRiskLevel).toBe("MEDIUM");
  });

  it("10. tidak pernah HIGH: previous=null, current=LOW -> notify=false", () => {
    const result = decideAlertNotification("LOW", null);
    expect(result.shouldNotify).toBe(false);
    expect(result.nextLastNotifiedRiskLevel).toBeNull();
  });

  it("11. fitur HIGH-only, turun ke LOW (bukan NONE): previous=HIGH, current=LOW -> notify=false, next=null (reset)", () => {
    const result = decideAlertNotification("LOW", { lastNotifiedRiskLevel: "HIGH" });
    expect(result.shouldNotify).toBe(false);
    expect(result.nextLastNotifiedRiskLevel).toBeNull();
  });

  it("12. determinisme: input sama dua kali -> output sama", () => {
    const a = decideAlertNotification("HIGH", { lastNotifiedRiskLevel: "MEDIUM" }, ["HIGH", "MEDIUM"]);
    const b = decideAlertNotification("HIGH", { lastNotifiedRiskLevel: "MEDIUM" }, ["HIGH", "MEDIUM"]);
    expect(a).toEqual(b);
  });

  it("13. sekuens realistis HIGH+MEDIUM: HIGH->HIGH->MEDIUM->MEDIUM->HIGH -> [notify, diam, notify, diam, notify]", () => {
    const levels: BusinessGuardRiskLevel[] = ["HIGH", "HIGH", "MEDIUM", "MEDIUM", "HIGH"];
    const notifiableLevels = ["HIGH", "MEDIUM"] as const;
    let previous: { lastNotifiedRiskLevel: BusinessGuardRiskLevel | null } | null = null;
    const notifications: boolean[] = [];

    for (const level of levels) {
      const decision = decideAlertNotification(level, previous, notifiableLevels);
      notifications.push(decision.shouldNotify);
      previous = { lastNotifiedRiskLevel: decision.nextLastNotifiedRiskLevel };
    }

    expect(notifications).toEqual([true, false, true, false, true]);
  });
});

describe("callTimingEntityKey", () => {
  it("menggabungkan salespersonId dan callDate dengan titik dua", () => {
    expect(callTimingEntityKey("sales-1", "2026-08-23")).toBe("sales-1:2026-08-23");
  });

  it("dua salesperson beda hari menghasilkan key beda", () => {
    expect(callTimingEntityKey("sales-1", "2026-08-23")).not.toBe(callTimingEntityKey("sales-2", "2026-08-23"));
    expect(callTimingEntityKey("sales-1", "2026-08-23")).not.toBe(callTimingEntityKey("sales-1", "2026-08-24"));
  });
});
