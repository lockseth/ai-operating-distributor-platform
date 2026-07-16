// =============================================================================
// FlowSales AI — Shared Type Definitions
// All types are product-agnostic and reusable across the entire ecosystem.
// =============================================================================

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export type UUID = string;
export type ISODateString = string;

export interface TimestampedEntity {
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface AuditedEntity extends TimestampedEntity {
  created_by: UUID | null;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Companies (Tenants)
// ---------------------------------------------------------------------------

export type SubscriptionPlan = "trial" | "starter" | "professional" | "enterprise";
export type SubscriptionStatus = "active" | "inactive" | "suspended" | "cancelled";

export interface Company extends TimestampedEntity {
  id: UUID;
  name: string;
  slug: string;
  domain: string | null;
  logo_url: string | null;
  settings: Record<string, JsonValue>;
  subscription_plan: SubscriptionPlan;
  subscription_status: SubscriptionStatus;
  is_active: boolean;
}

export type CompanyInsert = Omit<Company, "id" | "created_at" | "updated_at">;
export type CompanyUpdate = Partial<CompanyInsert>;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface User extends TimestampedEntity {
  id: UUID;
  company_id: UUID;
  email: string;
  full_name: string;
  avatar_url: string | null;
  phone: string | null;
  is_active: boolean;
}

export type UserInsert = Omit<User, "created_at" | "updated_at">;
export type UserUpdate = Partial<Omit<UserInsert, "id" | "company_id">>;

// ---------------------------------------------------------------------------
// Roles & Permissions
// ---------------------------------------------------------------------------

export type SystemRole =
  | "super_admin"
  | "owner"
  | "manager"
  | "sales"
  | "admin"
  | "warehouse"
  | "finance"
  | "driver";

export interface Role extends TimestampedEntity {
  id: UUID;
  company_id: UUID | null;
  name: SystemRole | string;
  description: string | null;
  is_system_role: boolean;
}

export type PermissionModule =
  | "companies"
  | "users"
  | "products"
  | "customers"
  | "orders"
  | "reports"
  | "settings"
  | "ai"
  | "automation";

export type PermissionAction = "view" | "create" | "update" | "delete" | "export" | "manage";

export interface Permission {
  id: UUID;
  name: string;
  module: PermissionModule;
  action: PermissionAction;
  description: string | null;
}

export interface UserRole extends Pick<TimestampedEntity, "created_at"> {
  id: UUID;
  user_id: UUID;
  role_id: UUID;
  company_id: UUID;
  assigned_by: UUID | null;
}

export interface RolePermission {
  role_id: UUID;
  permission_id: UUID;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface ProductCategory extends TimestampedEntity {
  id: UUID;
  company_id: UUID;
  name: string;
  parent_id: UUID | null;
}

export interface Product extends AuditedEntity {
  id: UUID;
  company_id: UUID;
  sku: string;
  name: string;
  description: string | null;
  category_id: UUID | null;
  price: number;
  cost: number | null;
  unit: string;
  stock_quantity: number;
  min_stock: number;
  is_active: boolean;
  custom_fields: Record<string, JsonValue>;
}

export type ProductInsert = Omit<Product, "id" | "created_at" | "updated_at">;
export type ProductUpdate = Partial<Omit<ProductInsert, "company_id" | "created_by">>;

// ---------------------------------------------------------------------------
// Customers (Resellers)
// ---------------------------------------------------------------------------

export type CustomerType = "reseller" | "direct" | "distributor" | "modern_trade";

export interface Customer extends AuditedEntity {
  id: UUID;
  company_id: UUID;
  code: string;
  name: string;
  type: CustomerType;
  phone: string | null;
  email: string | null;
  address: string | null;
  area: string | null;
  assigned_sales_id: UUID | null;
  last_order_at: ISODateString | null;
  is_active: boolean;
  custom_fields: Record<string, JsonValue>;
}

export type CustomerInsert = Omit<Customer, "id" | "created_at" | "updated_at">;
export type CustomerUpdate = Partial<Omit<CustomerInsert, "company_id" | "created_by">>;

// ---------------------------------------------------------------------------
// Sales Orders
// ---------------------------------------------------------------------------

export type OrderStatus =
  | "draft"
  | "confirmed"
  | "processing"
  | "delivering"
  | "delivered"
  | "invoiced"
  | "paid"
  | "cancelled";

export interface SalesOrder extends AuditedEntity {
  id: UUID;
  company_id: UUID;
  order_number: string;
  customer_id: UUID;
  sales_id: UUID | null;
  status: OrderStatus;
  total_amount: number;
  discount_amount: number;
  tax_amount: number;
  final_amount: number;
  notes: string | null;
  delivery_date: string | null;
  delivered_at: ISODateString | null;
  custom_fields: Record<string, JsonValue>;
}

export interface SalesOrderItem {
  id: UUID;
  order_id: UUID;
  product_id: UUID;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  total_amount: number;
  notes: string | null;
}

export type SalesOrderInsert = Omit<SalesOrder, "id" | "created_at" | "updated_at" | "order_number">;
export type SalesOrderItemInsert = Omit<SalesOrderItem, "id">;

// ---------------------------------------------------------------------------
// Audit Logs
// ---------------------------------------------------------------------------

export interface AuditLog {
  id: UUID;
  company_id: UUID;
  user_id: UUID | null;
  action: string;
  entity_type: string;
  entity_id: UUID | null;
  old_data: Record<string, JsonValue> | null;
  new_data: Record<string, JsonValue> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Setting extends TimestampedEntity {
  id: UUID;
  company_id: UUID;
  key: string;
  value: JsonValue;
}

// ---------------------------------------------------------------------------
// API Responses
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  data: T;
  message?: string;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: UUID;
  email: string;
  company_id: UUID;
  company: Pick<Company, "id" | "name" | "slug" | "logo_url" | "subscription_plan">;
  roles: SystemRole[];
  permissions: string[];
}

// ---------------------------------------------------------------------------
// Decision Kernel — shared contracts (AI Decision Kernel Foundation Gate)
//
// Types only. Setiap domain (sales-orders, dispatch, delivery, dst) tetap
// memiliki logic keputusannya sendiri — bagian ini hanya menstandardisasi
// BENTUK output/audit yang dipakai berulang, mencegah drift seperti yang
// sudah terjadi pada knowledge_candidates (lihat Operating Brain Readiness
// Report). Tidak ada orchestrator atau business logic di sini.
// ---------------------------------------------------------------------------

/** Satu alasan keputusan — code untuk logic/filtering, message untuk manusia. */
export interface DecisionReason {
  code: string;
  message: string;
}

/** Siapa/tenant mana yang bertanggung jawab atas sebuah keputusan/aksi. */
export interface ActorContext {
  actorId: UUID | null;
  companyId: UUID;
  isAiDecision: boolean;
}

/** Metadata audit standar untuk keputusan lintas domain (bukan tabel baru —
 * setiap domain tetap memetakan ini ke kolom event table miliknya sendiri). */
export interface DecisionAuditMetadata {
  actor: ActorContext;
  reasons: DecisionReason[];
  /** 0..1. Opsional — tidak semua domain punya confidence score (mis. discount
   * validation memakai boolean flag, bukan confidence). Jangan dipaksakan. */
  confidenceScore?: number;
}

export type KnowledgeCandidateType =
  | "product_alias"
  | "customer_alias"
  | "unit_alias"
  | "dispatch_planning_override"
  | "other";

/** Kontrak resmi untuk menulis knowledge_candidates — satu bentuk untuk
 * semua domain, dipakai lewat insertKnowledgeCandidate() (@flowsales/database).
 * status SELALU 'pending' (diset oleh helper, bukan caller) — koreksi domain
 * tidak boleh langsung mengubah Published Knowledge. */
export interface KnowledgeCandidateInput {
  companyId: UUID;
  candidateType: KnowledgeCandidateType;
  rawText: string;
  suggestedValue: Record<string, JsonValue>;
  sourceOrderId?: UUID | null;
  submittedBy: UUID | null;
}

/** Tenant policy access contract — settings dibaca sebagai map key->value
 * (JSONB, dari tabel `settings`) lalu diekstrak lewat readTenantPolicy()
 * (@flowsales/shared). I/O (query ke Supabase) tetap tanggung jawab domain
 * masing-masing — kontrak ini hanya menstandardisasi bentuk & fallback. */
export type TenantPolicySettings = Record<string, JsonValue>;
