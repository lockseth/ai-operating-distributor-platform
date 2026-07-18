// =============================================================================
// Repository — Tambah Toko & PIC. Pola sama dengan order-disputes/repository.ts:
// Supabase (RPC produksi) + InMemory (mencerminkan logika RPC lewat
// service.ts) supaya test cepat tanpa Postgres tetap merefleksikan perilaku
// produksi 1:1.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeIdPhone } from "./phone";
import { normalizeEmail, isValidEmailFormat } from "./email";
import { findExactStoreDuplicate, findSimilarStoreDuplicate, findPicPhoneOnOtherStore, isValidPicRoles } from "./service";
import type {
  CreateStoreWithPicInput,
  CreateStoreWithPicResult,
  CreateCustomerPicInput,
  CreateCustomerPicResult,
  UpdateCustomerPicInput,
  UpdateCustomerPicResult,
  VerifyCustomerPicInput,
  VerifyCustomerPicResult,
  CustomerPicRecord,
  CustomerPicHistoryRecord,
  CustomerRelationshipEventRecord,
  StoreSummary,
  PicRole,
  PicValidationStatus,
  AdminSettablePicStatus,
} from "./types";

export interface CustomerPicRepository {
  createStoreWithPic(input: CreateStoreWithPicInput): Promise<CreateStoreWithPicResult>;
  createCustomerPic(input: CreateCustomerPicInput): Promise<CreateCustomerPicResult>;
  updateCustomerPic(input: UpdateCustomerPicInput): Promise<UpdateCustomerPicResult>;
  verifyCustomerPic(input: VerifyCustomerPicInput): Promise<VerifyCustomerPicResult>;

  getStoreSummary(companyId: string, customerId: string): Promise<StoreSummary | null>;
  listPicsForStore(companyId: string, customerId: string): Promise<CustomerPicRecord[]>;
  getPicHistory(companyId: string, customerPicId: string): Promise<CustomerPicHistoryRecord[]>;
  getRelationshipEvents(companyId: string, customerId: string): Promise<CustomerRelationshipEventRecord[]>;

  /** Wilayah yang DITUGASKAN ke seorang Salesman (bukan seluruh daftar tenant). */
  getSalesmanCoverageAreas(companyId: string, userId: string): Promise<string[]>;
  /** Seluruh wilayah valid milik tenant (companies.settings.coverage_areas). */
  getTenantCoverageAreas(companyId: string): Promise<string[]>;
  /** Role utama actor pada company (untuk keputusan area mana yang boleh dipilih di percakapan). */
  getActorRole(companyId: string, userId: string): Promise<string | null>;
  /**
   * Toko milik tenant yang DITUGASKAN ke Salesman tsb (kebijakan ownership
   * sama seperti createCustomerPic), dicocokkan dengan substring nama --
   * dipakai alur Telegram "Tambah PIC" untuk mencari toko.
   */
  searchStoresForSalesman(companyId: string, salesmanId: string, query: string): Promise<StoreSummary[]>;
}

// -----------------------------------------------------------------------
// Supabase
// -----------------------------------------------------------------------

export class SupabaseCustomerPicRepository implements CustomerPicRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async createStoreWithPic(input: CreateStoreWithPicInput): Promise<CreateStoreWithPicResult> {
    const { data, error } = await this.supabase.rpc("create_store_with_pic", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_store_name: input.storeName,
      p_store_phone: input.storePhone,
      p_store_address: input.storeAddress,
      p_store_area: input.storeArea,
      p_store_latitude: input.storeLatitude,
      p_store_longitude: input.storeLongitude,
      p_assigned_sales_id: input.assignedSalesId,
      p_pic_name: input.picName,
      p_pic_phone: input.picPhone,
      p_pic_roles: input.picRoles,
      p_idempotency_key: input.idempotencyKey,
      p_source: input.source,
      p_override_similar_duplicate: input.overrideSimilarDuplicate,
      p_override_reason: input.overrideReason,
      p_pic_email: input.picEmail,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = (data ?? [])[0] as
      | { result_outcome: string; customer_id: string | null; customer_pic_id: string | null; duplicate_customer_id: string | null }
      | undefined;
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    if (row.result_outcome === "created" || row.result_outcome === "already_exists") {
      return { outcome: row.result_outcome, customerId: row.customer_id!, customerPicId: row.customer_pic_id! };
    }
    if (row.result_outcome === "exact_duplicate_store" || row.result_outcome === "similar_duplicate_warning") {
      return { outcome: row.result_outcome, duplicateCustomerId: row.duplicate_customer_id! };
    }
    if (
      row.result_outcome === "invalid_input" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_area" ||
      row.result_outcome === "area_not_assigned" ||
      row.result_outcome === "invalid_assigned_sales"
    ) {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async createCustomerPic(input: CreateCustomerPicInput): Promise<CreateCustomerPicResult> {
    const { data, error } = await this.supabase.rpc("create_customer_pic", {
      p_company_id: input.companyId,
      p_customer_id: input.customerId,
      p_actor_id: input.actorId,
      p_name: input.name,
      p_phone: input.phone,
      p_roles: input.roles,
      p_idempotency_key: input.idempotencyKey,
      p_source: input.source,
      p_email: input.email,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = (data ?? [])[0] as { result_outcome: string; customer_pic_id: string | null } | undefined;
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (row.result_outcome === "created" || row.result_outcome === "already_exists") {
      return { outcome: row.result_outcome, customerPicId: row.customer_pic_id! };
    }
    if (row.result_outcome === "phone_exists_on_store") {
      return { outcome: "phone_exists_on_store", existingCustomerPicId: row.customer_pic_id! };
    }
    if (row.result_outcome === "invalid_input" || row.result_outcome === "forbidden" || row.result_outcome === "customer_not_found") {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async updateCustomerPic(input: UpdateCustomerPicInput): Promise<UpdateCustomerPicResult> {
    const { data, error } = await this.supabase.rpc("update_customer_pic", {
      p_company_id: input.companyId,
      p_customer_pic_id: input.customerPicId,
      p_actor_id: input.actorId,
      p_new_name: input.newName,
      p_new_phone: input.newPhone,
      p_new_roles: input.newRoles,
      p_reason: input.reason,
      p_source: input.source,
      p_new_email: input.newEmail,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = (data ?? [])[0] as { result_outcome: string } | undefined;
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    switch (row.result_outcome) {
      case "updated":
      case "no_changes":
      case "invalid_input":
      case "forbidden":
      case "not_found":
        return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async verifyCustomerPic(input: VerifyCustomerPicInput): Promise<VerifyCustomerPicResult> {
    const { data, error } = await this.supabase.rpc("verify_customer_pic", {
      p_company_id: input.companyId,
      p_customer_pic_id: input.customerPicId,
      p_reviewer_id: input.reviewerId,
      p_new_status: input.newStatus,
      p_reason: input.reason,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = (data ?? [])[0] as { result_outcome: string; new_status: string | null } | undefined;
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (row.result_outcome === "verified") {
      return { outcome: "verified", newStatus: row.new_status as AdminSettablePicStatus };
    }
    switch (row.result_outcome) {
      case "invalid_input":
      case "forbidden":
      case "not_found":
        return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async getStoreSummary(companyId: string, customerId: string): Promise<StoreSummary | null> {
    const { data } = await this.supabase
      .from("customers")
      .select("id, company_id, name, phone, address, area, latitude, longitude, assigned_sales_id, is_active")
      .eq("id", customerId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (!data) return null;
    const row = data as unknown as {
      id: string; company_id: string; name: string; phone: string | null; address: string | null; area: string | null;
      latitude: number | null; longitude: number | null; assigned_sales_id: string | null; is_active: boolean;
    };
    return {
      id: row.id, companyId: row.company_id, name: row.name, phone: row.phone, address: row.address, area: row.area,
      latitude: row.latitude, longitude: row.longitude, assignedSalesId: row.assigned_sales_id, isActive: row.is_active,
    };
  }

  async listPicsForStore(companyId: string, customerId: string): Promise<CustomerPicRecord[]> {
    const { data } = await this.supabase
      .from("customer_pics")
      .select("*")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: true });
    return ((data ?? []) as unknown as SupabasePicRow[]).map(mapPicRow);
  }

  async getPicHistory(companyId: string, customerPicId: string): Promise<CustomerPicHistoryRecord[]> {
    const { data } = await this.supabase
      .from("customer_pic_history")
      .select("*")
      .eq("company_id", companyId)
      .eq("customer_pic_id", customerPicId)
      .order("created_at", { ascending: true });
    return ((data ?? []) as unknown as SupabaseHistoryRow[]).map(mapHistoryRow);
  }

  async getRelationshipEvents(companyId: string, customerId: string): Promise<CustomerRelationshipEventRecord[]> {
    const { data } = await this.supabase
      .from("customer_relationship_events")
      .select("*")
      .eq("company_id", companyId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });
    return ((data ?? []) as unknown as SupabaseEventRow[]).map(mapEventRow);
  }

  async getSalesmanCoverageAreas(companyId: string, userId: string): Promise<string[]> {
    const { data } = await this.supabase
      .from("salesman_coverage_areas")
      .select("area")
      .eq("company_id", companyId)
      .eq("user_id", userId);
    return ((data ?? []) as { area: string }[]).map((r) => r.area);
  }

  async getTenantCoverageAreas(companyId: string): Promise<string[]> {
    const { data } = await this.supabase.from("companies").select("settings").eq("id", companyId).maybeSingle();
    const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
    const areas = settings?.coverage_areas;
    return Array.isArray(areas) ? areas.filter((a): a is string => typeof a === "string") : [];
  }

  async getActorRole(companyId: string, userId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("user_roles")
      .select("role:roles!role_id(name)")
      .eq("company_id", companyId)
      .eq("user_id", userId);
    const rows = (data ?? []) as unknown as { role: { name: string } | null }[];
    const priority = ["super_admin", "owner", "manager", "admin", "sales"];
    for (const p of priority) {
      if (rows.some((r) => r.role?.name === p)) return p;
    }
    return rows[0]?.role?.name ?? null;
  }

  async searchStoresForSalesman(companyId: string, salesmanId: string, query: string): Promise<StoreSummary[]> {
    const { data } = await this.supabase
      .from("customers")
      .select("id, company_id, name, phone, address, area, latitude, longitude, assigned_sales_id, is_active")
      .eq("company_id", companyId)
      .eq("assigned_sales_id", salesmanId)
      .eq("is_active", true)
      .ilike("name", `%${query}%`)
      .limit(8);
    return ((data ?? []) as unknown as {
      id: string; company_id: string; name: string; phone: string | null; address: string | null; area: string | null;
      latitude: number | null; longitude: number | null; assigned_sales_id: string | null; is_active: boolean;
    }[]).map((row) => ({
      id: row.id, companyId: row.company_id, name: row.name, phone: row.phone, address: row.address, area: row.area,
      latitude: row.latitude, longitude: row.longitude, assignedSalesId: row.assigned_sales_id, isActive: row.is_active,
    }));
  }
}

interface SupabasePicRow {
  id: string; company_id: string; customer_id: string; name: string; phone: string; email: string | null; roles: string[];
  validation_status: string; created_by: string; created_at: string; verified_by: string | null;
  verified_at: string | null; updated_at: string;
}
function mapPicRow(row: SupabasePicRow): CustomerPicRecord {
  return {
    id: row.id, companyId: row.company_id, customerId: row.customer_id, name: row.name, phone: row.phone,
    email: row.email, roles: row.roles as PicRole[], validationStatus: row.validation_status as PicValidationStatus,
    createdBy: row.created_by, createdAt: row.created_at, verifiedBy: row.verified_by, verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
  };
}

interface SupabaseHistoryRow {
  id: string; company_id: string; customer_pic_id: string; customer_id: string; change_type: string;
  field_name: string | null; old_value: string | null; new_value: string | null; reason: string | null;
  source: string; actor_id: string; created_at: string;
}
function mapHistoryRow(row: SupabaseHistoryRow): CustomerPicHistoryRecord {
  return {
    id: row.id, companyId: row.company_id, customerPicId: row.customer_pic_id, customerId: row.customer_id,
    changeType: row.change_type as CustomerPicHistoryRecord["changeType"], fieldName: row.field_name,
    oldValue: row.old_value, newValue: row.new_value, reason: row.reason,
    source: row.source as CustomerPicHistoryRecord["source"], actorId: row.actor_id, createdAt: row.created_at,
  };
}

interface SupabaseEventRow {
  id: string; company_id: string; customer_id: string; customer_pic_id: string | null; event_type: string;
  severity: string; payload: Record<string, unknown>; actor_id: string | null; created_at: string;
}
function mapEventRow(row: SupabaseEventRow): CustomerRelationshipEventRecord {
  return {
    id: row.id, companyId: row.company_id, customerId: row.customer_id, customerPicId: row.customer_pic_id,
    eventType: row.event_type as CustomerRelationshipEventRecord["eventType"],
    severity: row.severity as CustomerRelationshipEventRecord["severity"], payload: row.payload,
    actorId: row.actor_id, createdAt: row.created_at,
  };
}

// -----------------------------------------------------------------------
// InMemory — mencerminkan logika RPC (service.ts) untuk test cepat tanpa DB.
// -----------------------------------------------------------------------

interface InMemoryUserSeed {
  id: string;
  companyId: string;
  role: string;
  isActive: boolean;
}

export class InMemoryCustomerPicRepository implements CustomerPicRepository {
  private stores = new Map<string, StoreSummary>();
  private pics = new Map<string, CustomerPicRecord>();
  private history: CustomerPicHistoryRecord[] = [];
  private events: CustomerRelationshipEventRecord[] = [];
  private users = new Map<string, InMemoryUserSeed>();
  private salesmenCoverage = new Map<string, Set<string>>(); // `${companyId}:${userId}` -> areas
  private tenantAreas = new Map<string, string[]>(); // companyId -> areas
  private idempotencyIndex = new Map<string, string>(); // `${companyId}:${key}` -> customerPicId
  private nextId = 1;
  public auditLogs: { companyId: string; actorId: string; action: string; entityType: string; entityId: string }[] = [];

  seedUser(seed: InMemoryUserSeed): void {
    this.users.set(seed.id, seed);
  }
  seedTenantAreas(companyId: string, areas: string[]): void {
    this.tenantAreas.set(companyId, areas);
  }
  seedSalesmanCoverage(companyId: string, userId: string, areas: string[]): void {
    this.salesmenCoverage.set(`${companyId}:${userId}`, new Set(areas));
  }
  seedStore(store: StoreSummary): void {
    this.stores.set(store.id, store);
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  async createStoreWithPic(input: CreateStoreWithPicInput): Promise<CreateStoreWithPicResult> {
    if (!input.storeName.trim() || !input.picName.trim() || !input.picPhone.trim()) {
      return { outcome: "invalid_input" };
    }
    if (!isValidPicRoles(input.picRoles)) return { outcome: "invalid_input" };
    if (input.overrideSimilarDuplicate && !input.overrideReason?.trim()) return { outcome: "invalid_input" };
    const normalizedPicEmailCheck = normalizeEmail(input.picEmail);
    if (normalizedPicEmailCheck !== null && !isValidEmailFormat(normalizedPicEmailCheck)) return { outcome: "invalid_input" };

    if (input.idempotencyKey) {
      const key = `${input.companyId}:${input.idempotencyKey}`;
      const existingId = this.idempotencyIndex.get(key);
      if (existingId) {
        const existing = this.pics.get(existingId)!;
        return { outcome: "already_exists", customerId: existing.customerId, customerPicId: existing.id };
      }
    }

    const actor = this.users.get(input.actorId);
    if (!actor || actor.companyId !== input.companyId || !actor.isActive) return { outcome: "forbidden" };

    const tenantAreas = this.tenantAreas.get(input.companyId) ?? [];
    if (input.storeArea && !tenantAreas.includes(input.storeArea)) return { outcome: "invalid_area" };

    if (actor.role === "sales") {
      if (input.assignedSalesId !== input.actorId) return { outcome: "forbidden" };
      if (input.storeArea) {
        const assigned = this.salesmenCoverage.get(`${input.companyId}:${input.actorId}`) ?? new Set();
        if (!assigned.has(input.storeArea)) return { outcome: "area_not_assigned" };
      }
    } else if (!["owner", "manager", "admin", "super_admin"].includes(actor.role)) {
      return { outcome: "forbidden" };
    }

    if (input.assignedSalesId) {
      const target = this.users.get(input.assignedSalesId);
      if (!target || target.companyId !== input.companyId || !target.isActive || target.role !== "sales") {
        return { outcome: "invalid_assigned_sales" };
      }
    }

    const tenantStores = [...this.stores.values()].filter((s) => s.companyId === input.companyId);
    const exact = findExactStoreDuplicate(input.storeName, input.storePhone, input.storeAddress, tenantStores);
    if (exact) return { outcome: "exact_duplicate_store", duplicateCustomerId: exact.id };

    if (!input.overrideSimilarDuplicate) {
      const similar = findSimilarStoreDuplicate(input.storeName, input.storePhone, input.storeAddress, input.storeArea, tenantStores);
      if (similar) return { outcome: "similar_duplicate_warning", duplicateCustomerId: similar.id };
    }

    const normalizedStorePhone = normalizeIdPhone(input.storePhone);
    const normalizedPicPhone = normalizeIdPhone(input.picPhone)!;
    const now = new Date().toISOString();

    const customerId = this.id("customer");
    this.stores.set(customerId, {
      id: customerId, companyId: input.companyId, name: input.storeName.trim(), phone: normalizedStorePhone,
      address: input.storeAddress?.trim() || null, area: input.storeArea || null,
      latitude: input.storeLatitude, longitude: input.storeLongitude, assignedSalesId: input.assignedSalesId,
      isActive: true,
    });

    const customerPicId = this.id("pic");
    const picRecord: CustomerPicRecord = {
      id: customerPicId, companyId: input.companyId, customerId, name: input.picName.trim(), phone: normalizedPicPhone,
      email: normalizeEmail(input.picEmail), roles: input.picRoles, validationStatus: "UNVERIFIED", createdBy: input.actorId, createdAt: now,
      verifiedBy: null, verifiedAt: null, updatedAt: now,
    };
    this.pics.set(customerPicId, picRecord);
    if (input.idempotencyKey) this.idempotencyIndex.set(`${input.companyId}:${input.idempotencyKey}`, customerPicId);

    this.history.push({
      id: this.id("hist"), companyId: input.companyId, customerPicId, customerId, changeType: "CREATED",
      fieldName: null, oldValue: null, newValue: input.picName.trim(), reason: null, source: input.source,
      actorId: input.actorId, createdAt: now,
    });
    this.events.push({
      id: this.id("evt"), companyId: input.companyId, customerId, customerPicId, eventType: "PIC_ADDED",
      severity: "info", payload: { picName: input.picName.trim(), roles: input.picRoles, source: input.source },
      actorId: input.actorId, createdAt: now,
    });

    const duplicatePic = findPicPhoneOnOtherStore(normalizedPicPhone, customerId, [...this.pics.values()]);
    if (duplicatePic) {
      this.events.push({
        id: this.id("evt"), companyId: input.companyId, customerId, customerPicId, eventType: "DUPLICATE_PIC_DETECTED",
        severity: "low", payload: { phone: normalizedPicPhone }, actorId: input.actorId, createdAt: now,
      });
    }

    this.auditLogs.push({ companyId: input.companyId, actorId: input.actorId, action: "customer.store_created", entityType: "customers", entityId: customerId });
    this.auditLogs.push({ companyId: input.companyId, actorId: input.actorId, action: "customer_pic.created", entityType: "customer_pics", entityId: customerPicId });

    return { outcome: "created", customerId, customerPicId };
  }

  async createCustomerPic(input: CreateCustomerPicInput): Promise<CreateCustomerPicResult> {
    if (!input.name.trim() || !input.phone.trim() || !isValidPicRoles(input.roles)) return { outcome: "invalid_input" };
    const normalizedEmailCheck = normalizeEmail(input.email);
    if (normalizedEmailCheck !== null && !isValidEmailFormat(normalizedEmailCheck)) return { outcome: "invalid_input" };

    if (input.idempotencyKey) {
      const key = `${input.companyId}:${input.idempotencyKey}`;
      const existingId = this.idempotencyIndex.get(key);
      if (existingId) return { outcome: "already_exists", customerPicId: existingId };
    }

    const actor = this.users.get(input.actorId);
    if (!actor || actor.companyId !== input.companyId || !actor.isActive) return { outcome: "forbidden" };

    const store = this.stores.get(input.customerId);
    if (!store || store.companyId !== input.companyId) return { outcome: "customer_not_found" };

    if (actor.role === "sales" && store.assignedSalesId !== input.actorId) return { outcome: "forbidden" };
    if (actor.role !== "sales" && !["owner", "manager", "admin", "super_admin"].includes(actor.role)) return { outcome: "forbidden" };

    const normalizedPhone = normalizeIdPhone(input.phone)!;

    // Nomor PIC yang sama pada TOKO YANG SAMA -> kembalikan record existing,
    // BUKAN membuat duplicate baru secara diam-diam.
    const existingPhonePic = [...this.pics.values()].find((p) => p.customerId === input.customerId && p.phone === normalizedPhone);
    if (existingPhonePic) return { outcome: "phone_exists_on_store", existingCustomerPicId: existingPhonePic.id };

    const now = new Date().toISOString();
    const customerPicId = this.id("pic");
    this.pics.set(customerPicId, {
      id: customerPicId, companyId: input.companyId, customerId: input.customerId, name: input.name.trim(),
      phone: normalizedPhone, email: normalizeEmail(input.email), roles: input.roles, validationStatus: "UNVERIFIED", createdBy: input.actorId,
      createdAt: now, verifiedBy: null, verifiedAt: null, updatedAt: now,
    });
    if (input.idempotencyKey) this.idempotencyIndex.set(`${input.companyId}:${input.idempotencyKey}`, customerPicId);

    this.history.push({
      id: this.id("hist"), companyId: input.companyId, customerPicId, customerId: input.customerId, changeType: "CREATED",
      fieldName: null, oldValue: null, newValue: input.name.trim(), reason: null, source: input.source,
      actorId: input.actorId, createdAt: now,
    });
    this.events.push({
      id: this.id("evt"), companyId: input.companyId, customerId: input.customerId, customerPicId, eventType: "PIC_ADDED",
      severity: "info", payload: { picName: input.name.trim(), roles: input.roles, source: input.source },
      actorId: input.actorId, createdAt: now,
    });

    const duplicatePic = findPicPhoneOnOtherStore(normalizedPhone, input.customerId, [...this.pics.values()]);
    if (duplicatePic) {
      this.events.push({
        id: this.id("evt"), companyId: input.companyId, customerId: input.customerId, customerPicId,
        eventType: "DUPLICATE_PIC_DETECTED", severity: "low", payload: { phone: normalizedPhone },
        actorId: input.actorId, createdAt: now,
      });
    }

    this.auditLogs.push({ companyId: input.companyId, actorId: input.actorId, action: "customer_pic.created", entityType: "customer_pics", entityId: customerPicId });
    return { outcome: "created", customerPicId };
  }

  async updateCustomerPic(input: UpdateCustomerPicInput): Promise<UpdateCustomerPicResult> {
    if (!input.reason.trim()) return { outcome: "invalid_input" };
    if (input.newRoles !== null && !isValidPicRoles(input.newRoles)) return { outcome: "invalid_input" };
    if (input.newEmail !== null) {
      const normalizedEmailCheck = normalizeEmail(input.newEmail);
      if (normalizedEmailCheck !== null && !isValidEmailFormat(normalizedEmailCheck)) return { outcome: "invalid_input" };
    }

    const actor = this.users.get(input.actorId);
    if (!actor || actor.companyId !== input.companyId || !actor.isActive || !["owner", "manager", "admin", "super_admin"].includes(actor.role)) {
      return { outcome: "forbidden" };
    }

    const pic = this.pics.get(input.customerPicId);
    if (!pic || pic.companyId !== input.companyId) return { outcome: "not_found" };

    let newStatus = pic.validationStatus;
    let changed = false;
    const now = new Date().toISOString();

    if (input.newName?.trim() && input.newName.trim() !== pic.name) {
      this.history.push({
        id: this.id("hist"), companyId: input.companyId, customerPicId: pic.id, customerId: pic.customerId,
        changeType: "NAME_CHANGED", fieldName: "name", oldValue: pic.name, newValue: input.newName.trim(),
        reason: input.reason, source: input.source, actorId: input.actorId, createdAt: now,
      });
      this.events.push({
        id: this.id("evt"), companyId: input.companyId, customerId: pic.customerId, customerPicId: pic.id,
        eventType: "PIC_NAME_CHANGED", severity: "info", payload: { old: pic.name, new: input.newName.trim(), reason: input.reason },
        actorId: input.actorId, createdAt: now,
      });
      changed = true;
    }

    let normalizedNewPhone: string | null = null;
    if (input.newPhone?.trim()) {
      normalizedNewPhone = normalizeIdPhone(input.newPhone);
      if (normalizedNewPhone !== pic.phone) {
        this.history.push({
          id: this.id("hist"), companyId: input.companyId, customerPicId: pic.id, customerId: pic.customerId,
          changeType: "PHONE_CHANGED", fieldName: "phone", oldValue: pic.phone, newValue: normalizedNewPhone,
          reason: input.reason, source: input.source, actorId: input.actorId, createdAt: now,
        });
        this.events.push({
          id: this.id("evt"), companyId: input.companyId, customerId: pic.customerId, customerPicId: pic.id,
          eventType: "PIC_PHONE_CHANGED", severity: "medium", payload: { old: pic.phone, new: normalizedNewPhone, reason: input.reason },
          actorId: input.actorId, createdAt: now,
        });
        if (pic.validationStatus !== "UNVERIFIED" && pic.validationStatus !== "INACTIVE") {
          newStatus = "REVERIFY_REQUIRED";
        }
        changed = true;
      } else {
        normalizedNewPhone = null;
      }
    }

    if (input.newRoles && JSON.stringify(input.newRoles) !== JSON.stringify(pic.roles)) {
      this.history.push({
        id: this.id("hist"), companyId: input.companyId, customerPicId: pic.id, customerId: pic.customerId,
        changeType: "ROLES_CHANGED", fieldName: "roles", oldValue: pic.roles.join(","), newValue: input.newRoles.join(","),
        reason: input.reason, source: input.source, actorId: input.actorId, createdAt: now,
      });
      this.events.push({
        id: this.id("evt"), companyId: input.companyId, customerId: pic.customerId, customerPicId: pic.id,
        eventType: "PIC_ROLES_CHANGED", severity: "info", payload: { old: pic.roles, new: input.newRoles, reason: input.reason },
        actorId: input.actorId, createdAt: now,
      });
      changed = true;
    }

    // Email TIDAK PERNAH mempengaruhi validationStatus -- bukan bukti verifikasi.
    let newEmailValue: string | null | undefined = undefined; // undefined = tidak diubah
    if (input.newEmail !== null) {
      const normalizedNewEmail = normalizeEmail(input.newEmail);
      if (normalizedNewEmail !== pic.email) {
        this.history.push({
          id: this.id("hist"), companyId: input.companyId, customerPicId: pic.id, customerId: pic.customerId,
          changeType: "EMAIL_CHANGED", fieldName: "email", oldValue: pic.email, newValue: normalizedNewEmail,
          reason: input.reason, source: input.source, actorId: input.actorId, createdAt: now,
        });
        this.events.push({
          id: this.id("evt"), companyId: input.companyId, customerId: pic.customerId, customerPicId: pic.id,
          eventType: "PIC_EMAIL_CHANGED", severity: "info", payload: { reason: input.reason },
          actorId: input.actorId, createdAt: now,
        });
        newEmailValue = normalizedNewEmail;
        changed = true;
      }
    }

    if (!changed) return { outcome: "no_changes" };

    const updated: CustomerPicRecord = {
      ...pic,
      name: input.newName?.trim() || pic.name,
      phone: normalizedNewPhone ?? pic.phone,
      roles: input.newRoles ?? pic.roles,
      email: newEmailValue !== undefined ? newEmailValue : pic.email,
      validationStatus: newStatus,
      updatedAt: now,
    };
    this.pics.set(pic.id, updated);
    this.auditLogs.push({ companyId: input.companyId, actorId: input.actorId, action: "customer_pic.updated", entityType: "customer_pics", entityId: pic.id });
    return { outcome: "updated" };
  }

  async verifyCustomerPic(input: VerifyCustomerPicInput): Promise<VerifyCustomerPicResult> {
    if (!input.reason.trim()) return { outcome: "invalid_input" };

    const reviewer = this.users.get(input.reviewerId);
    if (!reviewer || reviewer.companyId !== input.companyId || !reviewer.isActive || !["owner", "manager", "admin", "super_admin"].includes(reviewer.role)) {
      return { outcome: "forbidden" };
    }

    const pic = this.pics.get(input.customerPicId);
    if (!pic || pic.companyId !== input.companyId) return { outcome: "not_found" };
    // Tidak ada cek self-verify di sini -- role gate di atas sudah cukup:
    // Salesman tidak pernah lolos (createdBy mereka sendiri atau bukan),
    // sementara admin/owner/manager boleh verifikasi PIC buatan sendiri.

    const now = new Date().toISOString();
    const oldStatus = pic.validationStatus;
    this.pics.set(pic.id, { ...pic, validationStatus: input.newStatus, verifiedBy: input.reviewerId, verifiedAt: now, updatedAt: now });

    this.history.push({
      id: this.id("hist"), companyId: input.companyId, customerPicId: pic.id, customerId: pic.customerId,
      changeType: "STATUS_CHANGED", fieldName: "validation_status", oldValue: oldStatus, newValue: input.newStatus,
      reason: input.reason, source: "ADMIN_DASHBOARD", actorId: input.reviewerId, createdAt: now,
    });

    const eventType = input.newStatus === "VERIFIED_BY_ADMIN" ? "PIC_VERIFIED" : input.newStatus === "REVERIFY_REQUIRED" ? "PIC_REVERIFY_REQUIRED" : "PIC_DEACTIVATED";
    this.events.push({
      id: this.id("evt"), companyId: input.companyId, customerId: pic.customerId, customerPicId: pic.id,
      eventType, severity: input.newStatus === "VERIFIED_BY_ADMIN" ? "info" : "medium",
      payload: { oldStatus, newStatus: input.newStatus, reason: input.reason }, actorId: input.reviewerId, createdAt: now,
    });

    this.auditLogs.push({ companyId: input.companyId, actorId: input.reviewerId, action: "customer_pic.verified", entityType: "customer_pics", entityId: pic.id });
    return { outcome: "verified", newStatus: input.newStatus };
  }

  async getStoreSummary(companyId: string, customerId: string): Promise<StoreSummary | null> {
    const store = this.stores.get(customerId);
    if (!store || store.companyId !== companyId) return null;
    return store;
  }

  async searchStoresForSalesman(companyId: string, salesmanId: string, query: string): Promise<StoreSummary[]> {
    const q = query.trim().toLowerCase();
    return [...this.stores.values()]
      .filter((s) => s.companyId === companyId && s.assignedSalesId === salesmanId && s.isActive && s.name.toLowerCase().includes(q))
      .slice(0, 8);
  }

  async listPicsForStore(companyId: string, customerId: string): Promise<CustomerPicRecord[]> {
    return [...this.pics.values()].filter((p) => p.companyId === companyId && p.customerId === customerId);
  }

  async getPicHistory(companyId: string, customerPicId: string): Promise<CustomerPicHistoryRecord[]> {
    return this.history.filter((h) => h.companyId === companyId && h.customerPicId === customerPicId);
  }

  async getRelationshipEvents(companyId: string, customerId: string): Promise<CustomerRelationshipEventRecord[]> {
    return this.events.filter((e) => e.companyId === companyId && e.customerId === customerId);
  }

  async getSalesmanCoverageAreas(companyId: string, userId: string): Promise<string[]> {
    return [...(this.salesmenCoverage.get(`${companyId}:${userId}`) ?? [])];
  }

  async getTenantCoverageAreas(companyId: string): Promise<string[]> {
    return this.tenantAreas.get(companyId) ?? [];
  }

  async getActorRole(companyId: string, userId: string): Promise<string | null> {
    const u = this.users.get(userId);
    return u && u.companyId === companyId ? u.role : null;
  }

  // -- test helpers --
  getStoreSync(customerId: string): StoreSummary | undefined {
    return this.stores.get(customerId);
  }
  getPicSync(customerPicId: string): CustomerPicRecord | undefined {
    return this.pics.get(customerPicId);
  }
  totalPicsForStore(customerId: string): number {
    return [...this.pics.values()].filter((p) => p.customerId === customerId).length;
  }
  totalStores(): number {
    return this.stores.size;
  }
}
