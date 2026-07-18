// =============================================================================
// Repository import batch -- Supabase (produksi) + InMemory (test), mengikuti
// pola dual-repository yang dipakai konsisten di seluruh modul lain sesi ini.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LookupCustomer, ImportLookup } from "./dedupe";
import type {
  ColumnMapping, ImportBatch, ImportBatchRow, ImportBatchStatus, ImportType,
  ProposedAction, ReconciliationSummary, RollbackBlocker, RowFieldError, RowValidationStatus,
} from "./types";

export interface CreateBatchInput {
  companyId: string;
  importType: ImportType;
  sourceSystem: string;
  originalFilename: string;
  fileHash: string;
  createdBy: string;
}

export interface StagingRowInput {
  rowNumber: number;
  rawData: Record<string, string>;
  normalizedData: Record<string, unknown>;
  validationStatus: RowValidationStatus;
  errors: RowFieldError[];
  warnings: RowFieldError[];
  detectedExistingId: string | null;
  proposedAction: ProposedAction;
  rowHash: string;
}

export interface ValidationSummary {
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  duplicateRows: number;
  reconciliation: ReconciliationSummary | Record<string, never>;
  readyToCommit: boolean;
}

export type CommitOutcome = "committed" | "already_committed" | "forbidden" | "not_found" | "invalid_status" | "failed";
export type RollbackOutcome = "rolled_back" | "already_rolled_back" | "blocked" | "forbidden" | "not_found" | "invalid_status" | "invalid_input";

export interface ImportRepository extends ImportLookup {
  createBatch(input: CreateBatchInput): Promise<{ batchId: string }>;
  saveMapping(companyId: string, batchId: string, mappings: ColumnMapping[]): Promise<void>;
  replaceStagingRows(companyId: string, batchId: string, rows: StagingRowInput[]): Promise<void>;
  applyValidationSummary(companyId: string, batchId: string, summary: ValidationSummary): Promise<void>;
  getBatch(companyId: string, batchId: string): Promise<ImportBatch | null>;
  listBatches(companyId: string): Promise<ImportBatch[]>;
  getBatchRows(companyId: string, batchId: string): Promise<ImportBatchRow[]>;
  findCommittedBatchByHash(companyId: string, importType: ImportType, fileHash: string): Promise<ImportBatch | null>;
  commitBatch(companyId: string, batchId: string, actorId: string): Promise<{ outcome: CommitOutcome; detail?: string | null }>;
  rollbackBatch(companyId: string, batchId: string, actorId: string, reason: string): Promise<{ outcome: RollbackOutcome; blockers?: RollbackBlocker[] }>;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

interface BatchRow {
  id: string; company_id: string; import_type: ImportType; source_system: string;
  original_filename: string; file_hash: string; status: ImportBatchStatus;
  column_mappings: ColumnMapping[]; total_rows: number; valid_rows: number; warning_rows: number;
  error_rows: number; duplicate_rows: number; reconciliation: unknown; commit_result: unknown;
  failure_reason: string | null; rollback_reason: string | null; created_by: string; created_at: string;
  mapped_at: string | null; validated_at: string | null; committed_at: string | null; rolled_back_at: string | null;
}

function mapBatchRow(r: BatchRow): ImportBatch {
  return {
    id: r.id, companyId: r.company_id, importType: r.import_type, sourceSystem: r.source_system,
    originalFilename: r.original_filename, fileHash: r.file_hash, status: r.status,
    columnMappings: r.column_mappings ?? [], totalRows: r.total_rows, validRows: r.valid_rows,
    warningRows: r.warning_rows, errorRows: r.error_rows, duplicateRows: r.duplicate_rows,
    reconciliation: (r.reconciliation as ReconciliationSummary) ?? {},
    commitResult: (r.commit_result as { createdCount?: number; updatedCount?: number }) ?? {},
    failureReason: r.failure_reason, rollbackReason: r.rollback_reason, createdBy: r.created_by,
    createdAt: r.created_at, mappedAt: r.mapped_at, validatedAt: r.validated_at,
    committedAt: r.committed_at, rolledBackAt: r.rolled_back_at,
  };
}

export class SupabaseImportRepository implements ImportRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async createBatch(input: CreateBatchInput): Promise<{ batchId: string }> {
    const { data, error } = await this.supabase.from("import_batches").insert({
      company_id: input.companyId, import_type: input.importType, source_system: input.sourceSystem,
      original_filename: input.originalFilename, file_hash: input.fileHash, created_by: input.createdBy,
      status: "UPLOADED",
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { batchId: (data as { id: string }).id };
  }

  async saveMapping(companyId: string, batchId: string, mappings: ColumnMapping[]): Promise<void> {
    const { error } = await this.supabase.from("import_batches")
      .update({ column_mappings: mappings, status: "MAPPED", mapped_at: new Date().toISOString() })
      .eq("id", batchId).eq("company_id", companyId);
    if (error) throw new Error(error.message);
  }

  async replaceStagingRows(companyId: string, batchId: string, rows: StagingRowInput[]): Promise<void> {
    await this.supabase.from("import_batch_rows").delete().eq("batch_id", batchId);
    if (rows.length === 0) return;
    const payload = rows.map((r) => ({
      batch_id: batchId, company_id: companyId, row_number: r.rowNumber, raw_data: r.rawData,
      normalized_data: r.normalizedData, validation_status: r.validationStatus, errors: r.errors,
      warnings: r.warnings, detected_existing_id: r.detectedExistingId, proposed_action: r.proposedAction,
      row_hash: r.rowHash,
    }));
    const { error } = await this.supabase.from("import_batch_rows").insert(payload);
    if (error) throw new Error(error.message);
  }

  async applyValidationSummary(companyId: string, batchId: string, summary: ValidationSummary): Promise<void> {
    const { error } = await this.supabase.from("import_batches").update({
      total_rows: summary.totalRows, valid_rows: summary.validRows, warning_rows: summary.warningRows,
      error_rows: summary.errorRows, duplicate_rows: summary.duplicateRows,
      reconciliation: summary.reconciliation, validated_at: new Date().toISOString(),
      status: summary.readyToCommit ? "READY_TO_COMMIT" : "VALIDATED",
    }).eq("id", batchId).eq("company_id", companyId);
    if (error) throw new Error(error.message);
  }

  async getBatch(companyId: string, batchId: string): Promise<ImportBatch | null> {
    const { data } = await this.supabase.from("import_batches").select("*")
      .eq("id", batchId).eq("company_id", companyId).maybeSingle();
    return data ? mapBatchRow(data as BatchRow) : null;
  }

  async listBatches(companyId: string): Promise<ImportBatch[]> {
    const { data } = await this.supabase.from("import_batches").select("*")
      .eq("company_id", companyId).order("created_at", { ascending: false });
    return ((data ?? []) as BatchRow[]).map(mapBatchRow);
  }

  async getBatchRows(companyId: string, batchId: string): Promise<ImportBatchRow[]> {
    const { data } = await this.supabase.from("import_batch_rows").select("*")
      .eq("batch_id", batchId).eq("company_id", companyId).order("row_number", { ascending: true });
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string, batchId: r.batch_id as string, companyId: r.company_id as string,
      rowNumber: r.row_number as number, rawData: r.raw_data as Record<string, string>,
      normalizedData: r.normalized_data as Record<string, unknown>, validationStatus: r.validation_status as RowValidationStatus,
      errors: (r.errors as RowFieldError[]) ?? [], warnings: (r.warnings as RowFieldError[]) ?? [],
      detectedExistingId: r.detected_existing_id as string | null, proposedAction: r.proposed_action as ProposedAction,
      rowHash: r.row_hash as string, committedEntityId: r.committed_entity_id as string | null,
      committedEntityTable: r.committed_entity_table as string | null,
    }));
  }

  async findCommittedBatchByHash(companyId: string, importType: ImportType, fileHash: string): Promise<ImportBatch | null> {
    const { data } = await this.supabase.from("import_batches").select("*")
      .eq("company_id", companyId).eq("import_type", importType).eq("file_hash", fileHash)
      .eq("status", "COMMITTED").order("created_at", { ascending: false }).limit(1).maybeSingle();
    return data ? mapBatchRow(data as BatchRow) : null;
  }

  async commitBatch(companyId: string, batchId: string, actorId: string) {
    const { data, error } = await this.supabase.rpc("commit_import_batch", {
      p_company_id: companyId, p_batch_id: batchId, p_actor_id: actorId,
    });
    if (error) return { outcome: "failed" as const, detail: error.message };
    const row = (data ?? [])[0] as { result_outcome: CommitOutcome; detail: string | null } | undefined;
    return { outcome: row?.result_outcome ?? "failed", detail: row?.detail ?? null };
  }

  async rollbackBatch(companyId: string, batchId: string, actorId: string, reason: string) {
    const { data, error } = await this.supabase.rpc("rollback_import_batch", {
      p_company_id: companyId, p_batch_id: batchId, p_actor_id: actorId, p_reason: reason,
    });
    if (error) return { outcome: "invalid_input" as const };
    const row = (data ?? [])[0] as { result_outcome: RollbackOutcome; blockers: RollbackBlocker[] | null } | undefined;
    return { outcome: row?.result_outcome ?? "invalid_input", blockers: row?.blockers ?? undefined };
  }

  async findCustomerByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<LookupCustomer | null> {
    const { data } = await this.supabase.from("customers").select("id, name, legacy_id")
      .eq("company_id", companyId).eq("legacy_source_system", sourceSystem).eq("legacy_id", legacyId).maybeSingle();
    return data ? { id: data.id as string, name: data.name as string, legacyId: data.legacy_id as string | null } : null;
  }

  async findCustomerByExactName(companyId: string, name: string): Promise<LookupCustomer[]> {
    const { data } = await this.supabase.from("customers").select("id, name, legacy_id")
      .eq("company_id", companyId).ilike("name", name);
    return ((data ?? []) as Array<{ id: string; name: string; legacy_id: string | null }>)
      .filter((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase())
      .map((r) => ({ id: r.id, name: r.name, legacyId: r.legacy_id }));
  }

  async findSalesmanByName(companyId: string, name: string): Promise<{ id: string } | null> {
    const { data: users } = await this.supabase.from("users").select("id, full_name")
      .eq("company_id", companyId).ilike("full_name", name);
    const candidates = ((users ?? []) as Array<{ id: string; full_name: string }>)
      .filter((u) => u.full_name.trim().toLowerCase() === name.trim().toLowerCase());
    if (candidates.length === 0) return null;

    const { data: userRoles } = await this.supabase
      .from("user_roles").select("user_id, role:roles(name)")
      .eq("company_id", companyId).in("user_id", candidates.map((c) => c.id));
    const salesUserId = ((userRoles ?? []) as unknown as Array<{ user_id: string; role: { name: string } | null }>)
      .find((ur) => ur.role?.name === "sales")?.user_id;
    return salesUserId ? { id: salesUserId } : null;
  }

  async findPicByPhoneOnStore(companyId: string, customerId: string, normalizedPhone: string): Promise<{ id: string } | null> {
    const { data } = await this.supabase.from("customer_pics").select("id")
      .eq("company_id", companyId).eq("customer_id", customerId).eq("phone", normalizedPhone).maybeSingle();
    return data ? { id: data.id as string } : null;
  }

  async findProductByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null> {
    const { data } = await this.supabase.from("products").select("id")
      .eq("company_id", companyId).eq("legacy_source_system", sourceSystem).eq("legacy_id", legacyId).maybeSingle();
    return data ? { id: data.id as string } : null;
  }

  async findProductBySku(companyId: string, sku: string): Promise<{ id: string } | null> {
    const { data } = await this.supabase.from("products").select("id")
      .eq("company_id", companyId).eq("sku", sku).maybeSingle();
    return data ? { id: data.id as string } : null;
  }

  async findArInvoiceByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null> {
    const { data } = await this.supabase.from("legacy_ar_invoices").select("id")
      .eq("company_id", companyId).eq("legacy_source_system", sourceSystem).eq("legacy_id", legacyId).maybeSingle();
    return data ? { id: data.id as string } : null;
  }

  async findOrderByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null> {
    const { data } = await this.supabase.from("sales_orders").select("id")
      .eq("company_id", companyId).eq("legacy_source_system", sourceSystem).eq("legacy_id", legacyId).maybeSingle();
    return data ? { id: data.id as string } : null;
  }
}

// ---------------------------------------------------------------------------
// InMemory (test)
// ---------------------------------------------------------------------------

interface MemCustomer {
  id: string; companyId: string; name: string; phone: string | null; address: string | null; area: string | null;
  assignedSalesId: string | null; isActive: boolean; legacySourceSystem: string | null; legacyId: string | null;
  importBatchId: string | null; lastOrderAt: string | null;
}
interface MemPic { id: string; companyId: string; customerId: string; name: string; phone: string; email: string | null; roles: string[]; validationStatus: string; legacyId: string | null; }
interface MemProduct { id: string; companyId: string; sku: string; name: string; unit: string; price: number; isActive: boolean; legacySourceSystem: string | null; legacyId: string | null; }
interface MemAr { id: string; companyId: string; customerId: string; legacyId: string; originalAmount: number; amountPaid: number; outstandingBalance: number; }
interface MemOrder { id: string; companyId: string; customerId: string; legacyId: string | null; status: string; isHistorical: boolean; }
interface MemDelivery { id: string; salesOrderId: string; }
interface MemUser { id: string; companyId: string; fullName: string; role: string; isActive: boolean; }

export class InMemoryImportRepository implements ImportRepository {
  batches = new Map<string, ImportBatch>();
  rows = new Map<string, ImportBatchRow[]>();
  customers = new Map<string, MemCustomer>();
  pics = new Map<string, MemPic>();
  products = new Map<string, MemProduct>();
  arInvoices = new Map<string, MemAr>();
  orders = new Map<string, MemOrder>();
  deliveries = new Map<string, MemDelivery>();
  users = new Map<string, MemUser>();
  private seq = 0;

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  // --- test seed helpers ---
  seedUser(u: MemUser) { this.users.set(u.id, u); }
  seedCustomer(c: MemCustomer) { this.customers.set(c.id, c); }
  seedProduct(p: MemProduct) { this.products.set(p.id, p); }
  seedDelivery(d: MemDelivery) { this.deliveries.set(d.id, d); }
  getCustomerSync(id: string) { return this.customers.get(id); }
  getPicSync(id: string) { return this.pics.get(id); }
  getProductSync(id: string) { return this.products.get(id); }
  getArSync(id: string) { return this.arInvoices.get(id); }
  getOrderSync(id: string) { return this.orders.get(id); }
  totalCustomers() { return this.customers.size; }
  totalPics() { return this.pics.size; }
  totalProducts() { return this.products.size; }
  totalAr() { return this.arInvoices.size; }
  totalOrders() { return this.orders.size; }

  async createBatch(input: CreateBatchInput): Promise<{ batchId: string }> {
    const id = this.id("batch");
    const now = new Date().toISOString();
    this.batches.set(id, {
      id, companyId: input.companyId, importType: input.importType, sourceSystem: input.sourceSystem,
      originalFilename: input.originalFilename, fileHash: input.fileHash, status: "UPLOADED",
      columnMappings: [], totalRows: 0, validRows: 0, warningRows: 0, errorRows: 0, duplicateRows: 0,
      reconciliation: {}, commitResult: {}, failureReason: null, rollbackReason: null,
      createdBy: input.createdBy, createdAt: now, mappedAt: null, validatedAt: null, committedAt: null, rolledBackAt: null,
    });
    this.rows.set(id, []);
    return { batchId: id };
  }

  async saveMapping(companyId: string, batchId: string, mappings: ColumnMapping[]): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.companyId !== companyId) return;
    batch.columnMappings = mappings;
    batch.status = "MAPPED";
    batch.mappedAt = new Date().toISOString();
  }

  async replaceStagingRows(companyId: string, batchId: string, rows: StagingRowInput[]): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.companyId !== companyId) return;
    this.rows.set(batchId, rows.map((r) => ({
      id: this.id("row"), batchId, companyId, rowNumber: r.rowNumber, rawData: r.rawData,
      normalizedData: r.normalizedData, validationStatus: r.validationStatus, errors: r.errors,
      warnings: r.warnings, detectedExistingId: r.detectedExistingId, proposedAction: r.proposedAction,
      rowHash: r.rowHash, committedEntityId: null, committedEntityTable: null,
    })));
  }

  async applyValidationSummary(companyId: string, batchId: string, summary: ValidationSummary): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.companyId !== companyId) return;
    batch.totalRows = summary.totalRows; batch.validRows = summary.validRows;
    batch.warningRows = summary.warningRows; batch.errorRows = summary.errorRows;
    batch.duplicateRows = summary.duplicateRows; batch.reconciliation = summary.reconciliation;
    batch.validatedAt = new Date().toISOString();
    batch.status = summary.readyToCommit ? "READY_TO_COMMIT" : "VALIDATED";
  }

  async getBatch(companyId: string, batchId: string): Promise<ImportBatch | null> {
    const batch = this.batches.get(batchId);
    return batch && batch.companyId === companyId ? batch : null;
  }

  async listBatches(companyId: string): Promise<ImportBatch[]> {
    return [...this.batches.values()].filter((b) => b.companyId === companyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getBatchRows(companyId: string, batchId: string): Promise<ImportBatchRow[]> {
    return (this.rows.get(batchId) ?? []).filter((r) => r.companyId === companyId).sort((a, b) => a.rowNumber - b.rowNumber);
  }

  async findCommittedBatchByHash(companyId: string, importType: ImportType, fileHash: string): Promise<ImportBatch | null> {
    return [...this.batches.values()].find((b) =>
      b.companyId === companyId && b.importType === importType && b.fileHash === fileHash && b.status === "COMMITTED"
    ) ?? null;
  }

  async commitBatch(companyId: string, batchId: string, actorId: string) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.companyId !== companyId) return { outcome: "not_found" as const };

    const actor = this.users.get(actorId);
    if (!actor || actor.companyId !== companyId || !actor.isActive
        || !["owner","manager","admin","super_admin"].includes(actor.role)) {
      return { outcome: "forbidden" as const };
    }

    if (batch.status === "COMMITTED") return { outcome: "already_committed" as const };
    if (!["READY_TO_COMMIT", "FAILED"].includes(batch.status)) return { outcome: "invalid_status" as const };

    const rows = (this.rows.get(batchId) ?? []).filter((r) => r.proposedAction === "CREATE" || r.proposedAction === "UPDATE");
    let created = 0, updated = 0;

    try {
      for (const row of rows.sort((a, b) => a.rowNumber - b.rowNumber)) {
        if (batch.importType === "CUSTOMER_PIC") {
          const nd = row.normalizedData as Record<string, unknown>;
          let customerId = [...this.customers.values()].find((c) =>
            c.companyId === companyId && c.legacySourceSystem === batch.sourceSystem && c.legacyId === nd.store_legacy_code
          )?.id ?? null;

          if (!customerId) {
            if (row.proposedAction === "UPDATE" && row.detectedExistingId) {
              const existing = this.customers.get(row.detectedExistingId);
              if (existing) {
                existing.name = (nd.store_name as string) || existing.name;
                existing.phone = (nd.store_phone as string) ?? existing.phone;
                existing.address = (nd.store_address as string) ?? existing.address;
                existing.area = (nd.store_area as string) ?? existing.area;
                existing.isActive = (nd.is_active as boolean) ?? existing.isActive;
                customerId = existing.id;
              }
            } else {
              customerId = this.id("customer");
              this.customers.set(customerId, {
                id: customerId, companyId, name: nd.store_name as string, phone: (nd.store_phone as string) ?? null,
                address: (nd.store_address as string) ?? null, area: (nd.store_area as string) ?? null,
                assignedSalesId: (nd.assigned_sales_id as string) ?? null, isActive: (nd.is_active as boolean) ?? true,
                legacySourceSystem: batch.sourceSystem, legacyId: nd.store_legacy_code as string,
                importBatchId: batchId, lastOrderAt: null,
              });
            }
          }

          const picId = this.id("pic");
          this.pics.set(picId, {
            id: picId, companyId, customerId: customerId!, name: nd.pic_name as string, phone: nd.pic_phone as string,
            email: (nd.pic_email as string) ?? null, roles: nd.pic_roles as string[], validationStatus: "UNVERIFIED",
            legacyId: (nd.pic_legacy_code as string) ?? null,
          });
          row.committedEntityId = picId;
          row.committedEntityTable = "customer_pics";

        } else if (batch.importType === "PRODUCT_PRICE") {
          const nd = row.normalizedData as Record<string, unknown>;
          let productId: string;
          if (row.proposedAction === "UPDATE" && row.detectedExistingId) {
            const existing = this.products.get(row.detectedExistingId)!;
            existing.name = (nd.name as string) || existing.name;
            existing.unit = (nd.unit as string) || existing.unit;
            existing.price = (nd.price as number) ?? existing.price;
            existing.isActive = (nd.is_active as boolean) ?? existing.isActive;
            productId = existing.id;
          } else {
            productId = this.id("product");
            this.products.set(productId, {
              id: productId, companyId, sku: nd.sku as string, name: nd.name as string,
              unit: nd.unit as string, price: nd.price as number, isActive: (nd.is_active as boolean) ?? true,
              legacySourceSystem: batch.sourceSystem, legacyId: nd.product_legacy_code as string,
            });
          }
          row.committedEntityId = productId;
          row.committedEntityTable = "products";

        } else if (batch.importType === "OPEN_AR") {
          const nd = row.normalizedData as Record<string, unknown>;
          let arId: string;
          if (row.proposedAction === "UPDATE" && row.detectedExistingId) {
            const existing = this.arInvoices.get(row.detectedExistingId)!;
            existing.originalAmount = nd.original_amount as number;
            existing.amountPaid = nd.amount_paid as number;
            existing.outstandingBalance = nd.outstanding_balance as number;
            arId = existing.id;
          } else {
            // Mirror FK constraint legacy_ar_invoices.customer_id REFERENCES customers(id) -- Postgres akan menolak
            // insert dengan customer_id yang tidak ada, InMemory harus mensimulasikan kegagalan yang sama.
            if (!nd.customer_id || !this.customers.has(nd.customer_id as string)) {
              throw new Error(`customer_id tidak valid/ditemukan untuk baris ${row.rowNumber}`);
            }
            arId = this.id("ar");
            this.arInvoices.set(arId, {
              id: arId, companyId, customerId: nd.customer_id as string, legacyId: nd.legacy_invoice_number as string,
              originalAmount: nd.original_amount as number, amountPaid: nd.amount_paid as number,
              outstandingBalance: nd.outstanding_balance as number,
            });
          }
          row.committedEntityId = arId;
          row.committedEntityTable = "legacy_ar_invoices";

        } else if (batch.importType === "OPEN_ORDER" || batch.importType === "HISTORICAL_ORDER") {
          const nd = row.normalizedData as Record<string, unknown>;
          if (!nd.customer_id || !this.customers.has(nd.customer_id as string)) {
            throw new Error(`customer_id tidak valid/ditemukan untuk baris ${row.rowNumber}`);
          }
          const orderId = this.id("order");
          this.orders.set(orderId, {
            id: orderId, companyId, customerId: nd.customer_id as string,
            legacyId: nd.legacy_order_number as string, status: nd.status as string, isHistorical: true,
          });
          const customer = this.customers.get(nd.customer_id as string);
          if (customer && nd.order_date) {
            const orderDate = nd.order_date as string;
            if (!customer.lastOrderAt || customer.lastOrderAt < orderDate) customer.lastOrderAt = orderDate;
          }
          row.committedEntityId = orderId;
          row.committedEntityTable = "sales_orders";
        }

        // Hitung SATU KALI per baris staging (bukan per entity bawah yang
        // tersentuh, mis. toko yang direuse antar baris PIC) -- ini yang
        // menjamin createdCount+updatedCount persis sama dengan jumlah baris
        // yang preview tampilkan sebagai CREATE/UPDATE (LANGKAH E).
        if (row.proposedAction === "CREATE") created += 1;
        else if (row.proposedAction === "UPDATE") updated += 1;
      }
    } catch (e) {
      batch.status = "FAILED";
      batch.failureReason = e instanceof Error ? e.message : String(e);
      return { outcome: "failed" as const, detail: batch.failureReason };
    }

    batch.status = "COMMITTED";
    batch.committedAt = new Date().toISOString();
    batch.commitResult = { createdCount: created, updatedCount: updated };
    return { outcome: "committed" as const };
  }

  async rollbackBatch(companyId: string, batchId: string, actorId: string, reason: string) {
    if (!reason.trim()) return { outcome: "invalid_input" as const };
    const batch = this.batches.get(batchId);
    if (!batch || batch.companyId !== companyId) return { outcome: "not_found" as const };

    const actor = this.users.get(actorId);
    if (!actor || actor.companyId !== companyId || !actor.isActive
        || !["owner","manager","admin","super_admin"].includes(actor.role)) {
      return { outcome: "forbidden" as const };
    }

    if (batch.status === "ROLLED_BACK") return { outcome: "already_rolled_back" as const };
    if (batch.status !== "COMMITTED") return { outcome: "invalid_status" as const };

    const rows = (this.rows.get(batchId) ?? []).filter((r) => r.committedEntityId);
    const blockers: RollbackBlocker[] = [];

    for (const row of rows) {
      if (row.committedEntityTable === "customer_pics") {
        const pic = this.pics.get(row.committedEntityId!);
        if (pic && pic.validationStatus !== "UNVERIFIED") {
          blockers.push({ rowNumber: row.rowNumber, entityTable: "customer_pics", entityId: row.committedEntityId!, reason: "PIC sudah diverifikasi/diubah statusnya" });
        }
        if (pic) {
          const liveOrder = [...this.orders.values()].some((o) => o.customerId === pic.customerId);
          if (liveOrder) blockers.push({ rowNumber: row.rowNumber, entityTable: "customers", entityId: pic.customerId, reason: "Toko sudah punya order live di luar batch ini" });
        }
      } else if (row.committedEntityTable === "products") {
        // InMemory tidak memodelkan sales_order_items -- tidak ada blocker produk di sini.
      } else if (row.committedEntityTable === "sales_orders") {
        const hasDelivery = [...this.deliveries.values()].some((d) => d.salesOrderId === row.committedEntityId);
        if (hasDelivery) blockers.push({ rowNumber: row.rowNumber, entityTable: "sales_orders", entityId: row.committedEntityId!, reason: "Order sudah punya delivery live" });
      }
    }

    if (blockers.length > 0) return { outcome: "blocked" as const, blockers };

    for (const row of rows) {
      if (row.committedEntityTable === "customer_pics") {
        const pic = this.pics.get(row.committedEntityId!);
        this.pics.delete(row.committedEntityId!);
        if (pic) {
          const customer = this.customers.get(pic.customerId);
          const stillHasPics = [...this.pics.values()].some((p) => p.customerId === pic.customerId);
          if (customer && customer.importBatchId === batchId && !stillHasPics) {
            this.customers.delete(pic.customerId);
          }
        }
      } else if (row.committedEntityTable === "products") {
        this.products.delete(row.committedEntityId!);
      } else if (row.committedEntityTable === "legacy_ar_invoices") {
        this.arInvoices.delete(row.committedEntityId!);
      } else if (row.committedEntityTable === "sales_orders") {
        this.orders.delete(row.committedEntityId!);
      }
    }

    batch.status = "ROLLED_BACK";
    batch.rolledBackAt = new Date().toISOString();
    batch.rollbackReason = reason;
    return { outcome: "rolled_back" as const };
  }

  async findCustomerByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<LookupCustomer | null> {
    const c = [...this.customers.values()].find((x) => x.companyId === companyId && x.legacySourceSystem === sourceSystem && x.legacyId === legacyId);
    return c ? { id: c.id, name: c.name, legacyId: c.legacyId } : null;
  }

  async findCustomerByExactName(companyId: string, name: string): Promise<LookupCustomer[]> {
    return [...this.customers.values()]
      .filter((c) => c.companyId === companyId && c.name.trim().toLowerCase() === name.trim().toLowerCase())
      .map((c) => ({ id: c.id, name: c.name, legacyId: c.legacyId }));
  }

  async findSalesmanByName(companyId: string, name: string): Promise<{ id: string } | null> {
    const u = [...this.users.values()].find((x) => x.companyId === companyId && x.role === "sales" && x.fullName.trim().toLowerCase() === name.trim().toLowerCase());
    return u ? { id: u.id } : null;
  }

  async findPicByPhoneOnStore(companyId: string, customerId: string, normalizedPhone: string): Promise<{ id: string } | null> {
    const p = [...this.pics.values()].find((x) => x.companyId === companyId && x.customerId === customerId && x.phone === normalizedPhone);
    return p ? { id: p.id } : null;
  }

  async findProductByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null> {
    const p = [...this.products.values()].find((x) => x.companyId === companyId && x.legacySourceSystem === sourceSystem && x.legacyId === legacyId);
    return p ? { id: p.id } : null;
  }

  async findProductBySku(companyId: string, sku: string): Promise<{ id: string } | null> {
    const p = [...this.products.values()].find((x) => x.companyId === companyId && x.sku === sku);
    return p ? { id: p.id } : null;
  }

  async findArInvoiceByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null> {
    const a = [...this.arInvoices.values()].find((x) => x.companyId === companyId && x.legacyId === legacyId);
    void sourceSystem;
    return a ? { id: a.id } : null;
  }

  async findOrderByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null> {
    const o = [...this.orders.values()].find((x) => x.companyId === companyId && x.legacyId === legacyId);
    void sourceSystem;
    return o ? { id: o.id } : null;
  }
}
