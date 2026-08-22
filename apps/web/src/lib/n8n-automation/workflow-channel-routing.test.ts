// =============================================================================
// Regression test -- n8n/FlowSales channel-routing hotfix (Gate 3A Domain 5).
//
// Memvalidasi SELURUH file n8n/*.json (bukan hanya master workflow) terhadap
// matriks channel kanonik:
//   - Sales & aktivitas operasional Sales  -> Telegram (telegram_chat_id)
//   - Owner summary / large-order / eskalasi serius -> WhatsApp
//   - Health/retry/dead-letter -> tetap operasional (no-op), TIDAK PERNAH
//     diarahkan ke Sales WhatsApp
// Tidak boleh ada sales_phone/nomor Sales masuk ke node WhatsApp mana pun.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const N8N_DIR = path.resolve(__dirname, "../../../../../n8n");

interface N8nNode {
  id: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}

interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
  active: boolean;
  [key: string]: unknown;
}

function listWorkflowFiles(): string[] {
  return readdirSync(N8N_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function loadWorkflow(file: string): N8nWorkflow {
  const raw = readFileSync(path.join(N8N_DIR, file), "utf-8");
  return JSON.parse(raw) as N8nWorkflow;
}

function stringifyNode(node: N8nNode): string {
  return JSON.stringify(node.parameters ?? {});
}

/** Semua node HTTP Request yang menembak endpoint provider WhatsApp. */
function whatsappSendNodes(wf: N8nWorkflow): N8nNode[] {
  return wf.nodes.filter(
    (n) => n.type === "n8n-nodes-base.httpRequest" && stringifyNode(n).includes("whatsapp-provider"),
  );
}

/** Semua node HTTP Request yang menembak Telegram Bot API. */
function telegramSendNodes(wf: N8nWorkflow): N8nNode[] {
  return wf.nodes.filter(
    (n) => n.type === "n8n-nodes-base.httpRequest" && stringifyNode(n).includes("api.telegram.org"),
  );
}

// Daftar file yang WAJIB ter-cover audit ini. Kalau ada file .json baru
// ditambahkan ke n8n/ tanpa memperbarui daftar ini, test GAGAL -- mencegah
// exclusion diam-diam dari audit channel-routing.
const EXPECTED_WORKFLOW_FILES = [
  "aodp-collection-plan-morning.json",
  "aodp-dead-letter-monitor.json",
  "aodp-health-check.json",
  "aodp-kpi-daily-summary.json",
  "aodp-morning-brief.json",
  "aodp-outbox-dispatcher.json",
  "aodp-retry-handler.json",
  "aodp-sales-report-afternoon.json",
  "flowsales-churn-risk-alert.json",
  "flowsales-daily-owner-summary.json",
  "flowsales-large-order-alert.json",
  "flowsales-master-workflow.json",
  "flowsales-repeat-order-reminder.json",
];

describe("n8n workflow audit coverage", () => {
  it("mencakup SELURUH file .json di folder n8n/ -- tidak ada yang diam-diam dikecualikan", () => {
    expect(listWorkflowFiles()).toEqual(EXPECTED_WORKFLOW_FILES);
  });
});

describe.each(EXPECTED_WORKFLOW_FILES)("%s -- struktur dasar", (file) => {
  it("JSON valid dan bisa di-load sebagai workflow n8n", () => {
    const wf = loadWorkflow(file);
    expect(Array.isArray(wf.nodes)).toBe(true);
    expect(wf.nodes.length).toBeGreaterThan(0);
    expect(typeof wf.connections).toBe("object");
  });

  it("active: false (tidak boleh auto-aktif tanpa deployment eksplisit)", () => {
    const wf = loadWorkflow(file);
    expect(wf.active).toBe(false);
  });

  it("setiap node id unik", () => {
    const wf = loadWorkflow(file);
    const ids = wf.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("setiap target koneksi merujuk node yang benar-benar ada (tidak ada typo nama node)", () => {
    const wf = loadWorkflow(file);
    const nodeNames = new Set(wf.nodes.map((n) => n.name));
    for (const [sourceName, def] of Object.entries(wf.connections)) {
      expect(nodeNames.has(sourceName)).toBe(true);
      for (const branch of def.main) {
        for (const target of branch) {
          expect(nodeNames.has(target.node)).toBe(true);
        }
      }
    }
  });

  it("tidak ada credential id/secret literal yang bukan placeholder kanonik", () => {
    const wf = loadWorkflow(file);
    const raw = JSON.stringify(wf);
    // Placeholder yang diizinkan: "whatsapp-api-cred" (template lama,
    // pengguna WAJIB isi credential asli di n8n Settings, bukan file ini)
    // dan "REPLACE_WITH_YOUR_CREDENTIAL_ID" (foundation AODP baru).
    for (const node of wf.nodes) {
      if (!node.credentials) continue;
      for (const cred of Object.values(node.credentials)) {
        expect(["whatsapp-api-cred", "REPLACE_WITH_YOUR_CREDENTIAL_ID"]).toContain(cred.id);
      }
    }
    // Token Telegram/HMAC/URL app SELALU lewat $env.*, tidak pernah literal.
    expect(raw).not.toMatch(/api\.telegram\.org\/bot[A-Za-z0-9_-]{20,}\//);
  });
});

describe("channel routing kanonik -- Sales tidak pernah masuk node WhatsApp", () => {
  it.each(EXPECTED_WORKFLOW_FILES)("%s: tidak ada node WhatsApp yang mereferensikan sales_phone", (file) => {
    const wf = loadWorkflow(file);
    for (const node of whatsappSendNodes(wf)) {
      expect(stringifyNode(node)).not.toMatch(/sales_phone/);
    }
  });

  it("flowsales-repeat-order-reminder.json: repeat_order_due dikirim ke Sales via Telegram, bukan WhatsApp", () => {
    const wf = loadWorkflow("flowsales-repeat-order-reminder.json");
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    const telegramNodes = telegramSendNodes(wf);
    expect(telegramNodes).toHaveLength(1);
    expect(stringifyNode(telegramNodes[0])).toMatch(/telegram_chat_id/);
  });

  it("flowsales-churn-risk-alert.json: notifikasi Sales operasional selalu Telegram", () => {
    const wf = loadWorkflow("flowsales-churn-risk-alert.json");
    const telegramNodes = telegramSendNodes(wf);
    expect(telegramNodes).toHaveLength(1);
    expect(stringifyNode(telegramNodes[0])).toMatch(/telegram_chat_id_sales/);
  });

  it("flowsales-churn-risk-alert.json: eskalasi WhatsApp ke Owner DIGATE oleh IF node (days_inactive > 45), bukan langsung", () => {
    const wf = loadWorkflow("flowsales-churn-risk-alert.json");
    const waNodes = whatsappSendNodes(wf);
    expect(waNodes).toHaveLength(1);
    const waNodeName = waNodes[0].name;

    const gate = wf.nodes.find((n) => n.type === "n8n-nodes-base.if" && n.name.includes("Eskalasi Serius"));
    expect(gate).toBeDefined();
    expect(JSON.stringify(gate!.parameters)).toMatch(/is_serious_escalation/);

    // Node WA-ke-Owner harus jadi target langsung dari cabang TRUE gate ini,
    // bukan node lain manapun (memastikan escalation benar-benar conditional).
    const gateConnections = wf.connections[gate!.name]?.main ?? [];
    const trueBranchTargets = gateConnections[0]?.map((c) => c.node) ?? [];
    expect(trueBranchTargets).toContain(waNodeName);

    // Pastikan format node menghitung ambang > 45 hari (sejalan dengan
    // lib/ai/features/churn-prediction.ts -- ambang HIGH churn risk).
    const formatNode = wf.nodes.find((n) => n.name === "Format Pesan Notifikasi");
    expect(formatNode).toBeDefined();
    expect(JSON.stringify(formatNode!.parameters)).toMatch(/> 45/);

    // whatsapp_to_owner TIDAK PERNAH fallback ke sales_phone.
    expect(JSON.stringify(formatNode!.parameters)).not.toMatch(/sales_phone/);
  });

  it("flowsales-master-workflow.json: routing per-channel (telegram vs whatsapp) via IF node, bukan satu kanal generik", () => {
    const wf = loadWorkflow("flowsales-master-workflow.json");
    const gate = wf.nodes.find((n) => n.name === "Channel Telegram?");
    expect(gate).toBeDefined();
    expect(gate!.type).toBe("n8n-nodes-base.if");

    const repeatOrderFormat = wf.nodes.find((n) => n.name === "Format: Repeat Order");
    expect(repeatOrderFormat).toBeDefined();
    expect(JSON.stringify(repeatOrderFormat!.parameters)).toMatch(/"value":\s*"telegram"/);
    expect(JSON.stringify(repeatOrderFormat!.parameters)).not.toMatch(/sales_phone/);

    const churnFormat = wf.nodes.find((n) => n.name === "Format: Churn Risk");
    expect(churnFormat).toBeDefined();
    expect(churnFormat!.type).toBe("n8n-nodes-base.code");
    const churnCode = JSON.stringify(churnFormat!.parameters);
    expect(churnCode).toMatch(/> 45/);
    // Properti akses ".sales_phone" (bukan sekadar kemunculan kata di komentar
    // penjelas) tidak boleh ada -- WhatsApp-owner item HANYA memakai
    // owner_phone/manager_phone sebagai recipient.
    expect(churnCode).not.toMatch(/\.sales_phone\b/);

    // Gabung Branch harus meneruskan SEMUA item (bukan hanya item pertama),
    // supaya item eskalasi owner churn_risk tidak hilang.
    const merge = wf.nodes.find((n) => n.name === "Gabung Branch");
    expect(merge).toBeDefined();
    const mergeCode = (merge!.parameters as { jsCode: string }).jsCode;
    // Ambil baris kode eksekusi (bukan komentar) -- pastikan return statement
    // benar-benar memakai $input.all(), bukan $input.first().
    const executableLines = mergeCode
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(executableLines).toMatch(/\$input\.all\(\)/);
    expect(executableLines).not.toMatch(/\$input\.first\(\)/);
  });

  it("flowsales-large-order-alert.json & flowsales-daily-owner-summary.json: sudah patuh (Owner/Manager saja), tidak diubah", () => {
    for (const file of ["flowsales-large-order-alert.json", "flowsales-daily-owner-summary.json"]) {
      const wf = loadWorkflow(file);
      const waNodes = whatsappSendNodes(wf);
      expect(waNodes.length).toBeGreaterThan(0);
      // Recipient WA di-set di node "Format Pesan ..." (Set node) sebelum
      // dikirim; node httpRequest sendiri hanya membaca $json.whatsapp_to.
      const formatNode = wf.nodes.find((n) => n.name.startsWith("Format Pesan"));
      expect(formatNode).toBeDefined();
      expect(stringifyNode(formatNode!)).toMatch(/owner_phone/);
      expect(telegramSendNodes(wf)).toHaveLength(0);
    }
  });
});

describe("health/retry/dead-letter -- tetap operasional, tidak diarahkan ke Sales WhatsApp", () => {
  it("aodp-outbox-dispatcher.json: masih memanggil /api/internal/automation/dispatch (retry/complete/fail tidak berubah)", () => {
    const wf = loadWorkflow("aodp-outbox-dispatcher.json");
    const raw = JSON.stringify(wf);
    expect(raw).toMatch(/\/api\/internal\/automation\/dispatch/);
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    expect(telegramSendNodes(wf)).toHaveLength(0);
  });

  it("aodp-retry-handler.json: masih gate di backlog.retry_due sebelum reprocess", () => {
    const wf = loadWorkflow("aodp-retry-handler.json");
    const gate = wf.nodes.find((n) => n.name === "Ada Retry Backlog?");
    expect(gate).toBeDefined();
    expect(JSON.stringify(gate!.parameters)).toMatch(/backlog\.retry_due/);
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    expect(telegramSendNodes(wf)).toHaveLength(0);
  });

  it("aodp-dead-letter-monitor.json: masih gate di backlog.dead_letter dan tidak auto-escalate ke channel apa pun", () => {
    const wf = loadWorkflow("aodp-dead-letter-monitor.json");
    const gate = wf.nodes.find((n) => n.name === "Ada Dead Letter?");
    expect(gate).toBeDefined();
    expect(JSON.stringify(gate!.parameters)).toMatch(/backlog\.dead_letter/);
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    expect(telegramSendNodes(wf)).toHaveLength(0);
  });

  it("aodp-health-check.json: tidak mengirim notifikasi ke channel apa pun (escalation channel sengaja belum diaktifkan)", () => {
    const wf = loadWorkflow("aodp-health-check.json");
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    expect(telegramSendNodes(wf)).toHaveLength(0);
  });
});

describe("morning-brief & kpi-daily-summary -- routing didelegasikan ke server, sudah kanonik", () => {
  it("aodp-morning-brief.json: n8n tidak mengirim pesan langsung (delegasi ke /api/internal/automation/morning-brief + /dispatch)", () => {
    const wf = loadWorkflow("aodp-morning-brief.json");
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    expect(telegramSendNodes(wf)).toHaveLength(0);
    expect(JSON.stringify(wf)).toMatch(/\/api\/internal\/automation\/morning-brief/);
  });

  it("aodp-kpi-daily-summary.json: WhatsApp Owner tetap dry-run only, tidak ada pengiriman nyata di n8n", () => {
    const wf = loadWorkflow("aodp-kpi-daily-summary.json");
    expect(whatsappSendNodes(wf)).toHaveLength(0);
    expect(telegramSendNodes(wf)).toHaveLength(0);
    expect(JSON.stringify(wf)).toMatch(/\/api\/internal\/automation\/kpi-daily-summary/);
  });
});
