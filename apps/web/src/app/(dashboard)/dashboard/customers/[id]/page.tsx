import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { DeactivateButton } from "@/components/customers/deactivate-button";
import { PicPanel, type PicView, type PicHistoryView, type RelationshipEventView } from "@/components/customer-pic/pic-panel";
import { AddPicForm } from "@/components/customer-pic/add-pic-form";
import type { PicRole, PicValidationStatus } from "@/lib/customer-pic/types";
import {
  ChevronLeft, Edit2, Users, Phone, Mail, MapPin,
  Calendar, Clock, User, Info,
} from "lucide-react";

export const metadata = { title: "Detail Pelanggan — AODP" };

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const TYPE_LABELS: Record<string, string> = {
  reseller:     "Reseller",
  direct:       "Direct / Eceran",
  distributor:  "Distributor",
  modern_trade: "Modern Trade",
};

interface Customer {
  id: string;
  code: string;
  name: string;
  type: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  area: string | null;
  is_active: boolean;
  last_order_at: string | null;
  avg_order_interval_days: number | null;
  notes: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  assigned_sales: { full_name: string } | null;
  creator: { full_name: string } | null;
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "customers.view")) redirect("/dashboard/customers");

  const supabase = await createClient();
  const { data } = await supabase
    .from("customers")
    .select("*, assigned_sales:users!assigned_sales_id(full_name), creator:users!created_by(full_name)")
    .eq("id", id)
    .eq("company_id", user.company_id)
    .single();

  if (!data) notFound();

  const customer   = data as unknown as Customer;
  const canEdit    = hasPermission(user.permissions, "customers.update");
  const canDeactivate =
    hasPermission(user.permissions, "customers.delete") || canEdit;

  const customFieldEntries = Object.entries(customer.custom_fields ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );

  const daysSinceOrder = customer.last_order_at
    ? Math.floor((new Date().getTime() - new Date(customer.last_order_at).getTime()) / 86_400_000)
    : null;

  // --- Tambah Toko & PIC (purely additive) ---
  const canVerifyPic = hasPermission(user.permissions, "customers.pic_verify");
  const canAddPic = hasPermission(user.permissions, "customers.create") || hasPermission(user.permissions, "customers.update");

  const { data: picRows } = await supabase
    .from("customer_pics")
    .select("id, name, phone, email, roles, validation_status, created_at, verified_at, created_by_user:users!created_by(id, full_name), verified_by_user:users!verified_by(full_name)")
    .eq("company_id", user.company_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: true });

  const pics: PicView[] = ((picRows ?? []) as unknown as {
    id: string; name: string; phone: string; email: string | null; roles: PicRole[]; validation_status: PicValidationStatus;
    created_at: string; verified_at: string | null;
    created_by_user: { id: string; full_name: string } | null;
    verified_by_user: { full_name: string } | null;
  }[]).map((r) => ({
    id: r.id, name: r.name, phone: r.phone, email: r.email, roles: r.roles, validationStatus: r.validation_status,
    createdByName: r.created_by_user?.full_name ?? "—", createdById: r.created_by_user?.id ?? "",
    createdAt: r.created_at, verifiedByName: r.verified_by_user?.full_name ?? null, verifiedAt: r.verified_at,
  }));

  const picIds = pics.map((p) => p.id);
  const { data: historyRows } = picIds.length
    ? await supabase
        .from("customer_pic_history")
        .select("id, customer_pic_id, change_type, field_name, old_value, new_value, reason, source, created_at, actor:users!actor_id(full_name)")
        .in("customer_pic_id", picIds)
        .order("created_at", { ascending: false })
    : { data: [] };

  const history: PicHistoryView[] = ((historyRows ?? []) as unknown as {
    id: string; customer_pic_id: string; change_type: string; field_name: string | null; old_value: string | null;
    new_value: string | null; reason: string | null; source: string; created_at: string; actor: { full_name: string } | null;
  }[]).map((r) => ({
    id: r.id, customerPicId: r.customer_pic_id, changeType: r.change_type, fieldName: r.field_name,
    oldValue: r.old_value, newValue: r.new_value, reason: r.reason, source: r.source,
    actorName: r.actor?.full_name ?? "—", createdAt: r.created_at,
  }));

  const { data: eventRows } = await supabase
    .from("customer_relationship_events")
    .select("id, event_type, severity, payload, created_at")
    .eq("company_id", user.company_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false });

  const relationshipEvents: RelationshipEventView[] = ((eventRows ?? []) as unknown as {
    id: string; event_type: string; severity: string; payload: Record<string, unknown>; created_at: string;
  }[]).map((r) => ({ id: r.id, eventType: r.event_type, severity: r.severity, payload: r.payload, createdAt: r.created_at }));

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Breadcrumb + Actions */}
      <div className="flex items-center justify-between">
        <Link href="/dashboard/customers" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Pelanggan
        </Link>
        <div className="flex items-center gap-2">
          {canDeactivate && (
            <DeactivateButton customerId={customer.id} isActive={customer.is_active} />
          )}
          {canEdit && (
            <Link
              href={`/dashboard/customers/${customer.id}/edit`}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Edit2 className="h-4 w-4" />
              Edit
            </Link>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 shrink-0">
            <Users className="h-6 w-6 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{customer.name}</h1>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                customer.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}>
                {customer.is_active ? "Aktif" : "Nonaktif"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
              <span className="font-mono text-xs">{customer.code}</span>
              <span>·</span>
              <span>{TYPE_LABELS[customer.type] ?? customer.type}</span>
              {customer.assigned_sales && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <User className="h-3.5 w-3.5" />
                    {customer.assigned_sales.full_name}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-gray-500">Order Terakhir</span>
          </div>
          <p className="text-sm font-semibold text-gray-900">
            {formatDate(customer.last_order_at) ?? <span className="text-gray-400">Belum order</span>}
          </p>
          {daysSinceOrder !== null && (
            <p className="text-xs text-gray-400 mt-0.5">{daysSinceOrder} hari lalu</p>
          )}
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-purple-500" />
            <span className="text-xs text-gray-500">Interval Rata-rata</span>
          </div>
          <p className="text-sm font-semibold text-gray-900">
            {customer.avg_order_interval_days
              ? `${customer.avg_order_interval_days} hari`
              : <span className="text-gray-400">—</span>}
          </p>
          {customer.avg_order_interval_days && (
            <p className="text-xs text-gray-400 mt-0.5">frekuensi order</p>
          )}
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Phone className="h-4 w-4 text-green-500" />
            <span className="text-xs text-gray-500">Telepon</span>
          </div>
          <p className="text-sm font-medium text-gray-900">
            {customer.phone ?? <span className="text-gray-400">—</span>}
          </p>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Mail className="h-4 w-4 text-orange-500" />
            <span className="text-xs text-gray-500">Email</span>
          </div>
          <p className="text-sm font-medium text-gray-900 truncate">
            {customer.email ?? <span className="text-gray-400">—</span>}
          </p>
        </div>
      </div>

      {/* Detail info */}
      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Informasi Lengkap</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Alamat */}
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Alamat</p>
              <p className="text-sm text-gray-900">
                {customer.address ?? <span className="text-gray-400">—</span>}
              </p>
            </div>
          </div>

          {/* Kota & Area */}
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Kota / Area</p>
              <p className="text-sm text-gray-900">
                {[customer.city, customer.area].filter(Boolean).join(" · ") || <span className="text-gray-400">—</span>}
              </p>
            </div>
          </div>
        </div>

        {/* Notes */}
        {customer.notes && (
          <div className="flex items-start gap-2 pt-2 border-t border-gray-50">
            <Info className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Catatan Internal</p>
              <p className="text-sm text-gray-700 whitespace-pre-line">{customer.notes}</p>
            </div>
          </div>
        )}
      </div>

      {/* PIC (Contact Person) */}
      <div className="space-y-2">
        <PicPanel
          customerId={customer.id}
          pics={pics}
          history={history}
          relationshipEvents={relationshipEvents}
          canVerify={canVerifyPic}
          currentUserId={user.id}
        />
        {canAddPic && (
          <div className="px-1">
            <AddPicForm customerId={customer.id} />
          </div>
        )}
      </div>

      {/* Custom Fields */}
      {customFieldEntries.length > 0 && (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Field Tambahan</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {customFieldEntries.map(([key, value]) => (
              <div key={key} className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500 capitalize">{key.replace(/_/g, " ")}</p>
                <p className="text-sm font-medium text-gray-900 mt-0.5">{String(value)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="rounded-xl border bg-gray-50 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>Dibuat: {formatDateTime(customer.created_at)}</span>
          {customer.creator?.full_name && <span>oleh {customer.creator.full_name}</span>}
          <span>Terakhir diubah: {formatDateTime(customer.updated_at)}</span>
          <span className="font-mono">ID: {customer.id}</span>
        </div>
      </div>
    </div>
  );
}
