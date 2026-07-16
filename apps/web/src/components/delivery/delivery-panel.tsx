import { Truck, MapPin, FileSignature, Camera, Mic, Clock } from "lucide-react";
import type { DeliveryStatus, DeliveryItemRecord, DeliveryExceptionRecord, DeliveryEvidenceRecord } from "@/lib/delivery/types";
import type { InvoiceEligibility } from "@/lib/delivery/types";

function formatIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  planned: "Direncanakan",
  dispatched: "Dalam Perjalanan",
  arrived: "Tiba di Toko",
  fully_received: "Diterima Penuh",
  partially_received: "Diterima Sebagian",
  rejected: "Ditolak",
  store_closed: "Toko Tutup",
  failed: "Gagal",
  verified: "Terverifikasi",
};

const STATUS_COLOR: Record<DeliveryStatus, string> = {
  planned: "bg-gray-100 text-gray-700",
  dispatched: "bg-blue-100 text-blue-700",
  arrived: "bg-blue-100 text-blue-700",
  fully_received: "bg-green-100 text-green-700",
  partially_received: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
  store_closed: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  verified: "bg-green-100 text-green-700",
};

const EVIDENCE_ICON: Record<string, typeof Camera> = {
  photo: Camera,
  signature: FileSignature,
  location: MapPin,
  voice_note: Mic,
  note: FileSignature,
};

interface DeliveryEventRow {
  eventType: string;
  toStatus: string | null;
  createdAt: string;
}

interface DeliveryPanelProps {
  status: DeliveryStatus;
  attemptNumber: number;
  items: DeliveryItemRecord[];
  exceptions: DeliveryExceptionRecord[];
  evidence: DeliveryEvidenceRecord[];
  recipient: { recipientName: string; isExpectedPic: boolean } | null;
  events: DeliveryEventRow[];
  invoiceEligibility: InvoiceEligibility;
  ownerAlertStatus: "pending" | "sent" | "failed" | null;
}

export function DeliveryPanel({
  status,
  attemptNumber,
  items,
  exceptions,
  evidence,
  recipient,
  events,
  invoiceEligibility,
  ownerAlertStatus,
}: DeliveryPanelProps) {
  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 flex-wrap">
        <Truck className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900">Delivery Verification</h2>
        <span className="text-xs text-gray-400">percobaan #{attemptNumber}</span>
        <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLOR[status]}`}>
          {STATUS_LABEL[status]}
        </span>
        {ownerAlertStatus && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              ownerAlertStatus === "sent" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
            }`}
          >
            Owner alert: {ownerAlertStatus === "sent" ? "terkirim" : ownerAlertStatus === "pending" ? "pending" : "gagal"}
          </span>
        )}
      </div>

      {/* Rekonsiliasi per item */}
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            <th className="px-5 py-2 text-left text-xs font-medium text-gray-500">Produk</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Dipesan</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Dikirim</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Diterima</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Selisih</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {items.map((item) => {
            const variance = item.dispatchedQuantity - item.receivedQuantity;
            return (
              <tr key={item.id}>
                <td className="px-5 py-2 text-gray-900">{item.productName}</td>
                <td className="px-3 py-2 text-right text-gray-500">{item.orderedQuantity} {item.unit}</td>
                <td className="px-3 py-2 text-right text-gray-500">{item.dispatchedQuantity} {item.unit}</td>
                <td className="px-3 py-2 text-right font-medium text-gray-900">{item.receivedQuantity} {item.unit}</td>
                <td className={`px-3 py-2 text-right ${variance !== 0 ? "text-red-600 font-medium" : "text-gray-400"}`}>
                  {variance !== 0 ? `-${variance} ${item.unit ?? ""}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Invoice eligibility */}
      <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span className="text-gray-500">
          Invoice eligible: <span className="font-semibold text-gray-900">{formatIDR(invoiceEligibility.totalEligibleValue)}</span> dari {formatIDR(invoiceEligibility.totalOrderedValue)}
        </span>
        {invoiceEligibility.varianceValue !== 0 && (
          <span className="text-red-600 font-medium">Selisih nilai: {formatIDR(invoiceEligibility.varianceValue)}</span>
        )}
        <span className="text-gray-400">{invoiceEligibility.isFinal ? "Final" : "Belum final"}</span>
      </div>

      {/* Exceptions */}
      {exceptions.length > 0 && (
        <div className="px-5 py-3 border-t border-gray-100">
          <p className="text-xs font-medium text-gray-500 mb-1.5">Exception</p>
          <div className="space-y-1.5">
            {exceptions.map((exc) => (
              <div key={exc.id} className="flex items-start gap-2 text-xs">
                <span
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    exc.severity === "high" ? "bg-red-100 text-red-700" : exc.severity === "medium" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {exc.severity}
                </span>
                <span className="text-gray-700">{exc.reasonCode}{exc.note ? ` — ${exc.note}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recipient + evidence */}
      {(recipient || evidence.length > 0) && (
        <div className="px-5 py-3 border-t border-gray-100 flex flex-wrap items-center gap-3 text-xs text-gray-600">
          {recipient && (
            <span>
              Penerima: <span className="font-medium text-gray-900">{recipient.recipientName}</span>
              {!recipient.isExpectedPic && <span className="ml-1 text-amber-600">(bukan PIC biasa)</span>}
            </span>
          )}
          {evidence.length > 0 && (
            <span className="flex items-center gap-2">
              Bukti:
              {evidence.map((e) => {
                const Icon = EVIDENCE_ICON[e.evidenceType] ?? Camera;
                return <Icon key={e.id} className="h-3.5 w-3.5 text-gray-400" aria-label={e.evidenceType} />;
              })}
            </span>
          )}
        </div>
      )}

      {/* Timeline */}
      {events.length > 0 && (
        <div className="px-5 py-3 border-t border-gray-100">
          <p className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> Riwayat
          </p>
          <ul className="space-y-1">
            {events.map((ev, i) => (
              <li key={i} className="text-xs text-gray-500">
                {formatDateTime(ev.createdAt)} — {ev.eventType}
                {ev.toStatus ? ` → ${STATUS_LABEL[ev.toStatus as DeliveryStatus] ?? ev.toStatus}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
