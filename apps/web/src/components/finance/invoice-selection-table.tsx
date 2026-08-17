"use client";

// =============================================================================
// Daftar invoice dengan checkbox multi-pilih + "Cetak Terpilih" -- Founder
// konfirmasi (2026-08-17) invoice dicetak sekaligus ke printer continuous
// form, bukan satu-satu real-time. Kirim ke /finance/invoices/print-batch
// (buildPrintSheets sudah menangani pairing panel lintas dokumen). Selection
// murni state lokal per page-load, tidak dipersist -- scope-nya memang cuma
// "pilih beberapa, cetak, selesai", bukan draft yang perlu bertahan.
// =============================================================================

import { useMemo, useState } from "react";
import Link from "next/link";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";
import type { InvoiceListItem } from "@/lib/finance/queries";

export function InvoiceSelectionTable({ items }: { items: InvoiceListItem[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const allSelected = items.every((item) => prev.has(item.id));
      return allSelected ? new Set() : new Set(items.map((item) => item.id));
    });
  }

  const allOnPageSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  const columns: Column<InvoiceListItem>[] = useMemo(
    () => [
      {
        key: "select",
        label: "",
        render: (row) => (
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={() => toggle(row.id)}
            aria-label={`Pilih invoice ${row.invoiceNumber}`}
            className="h-4 w-4 rounded border-gray-300"
          />
        ),
      },
      {
        key: "invoiceNumber",
        label: "No. Invoice",
        render: (row) => (
          <Link
            href={`/dashboard/finance/invoices/${row.id}`}
            className="font-mono text-xs font-semibold text-blue-600 hover:underline"
          >
            {row.invoiceNumber}
          </Link>
        ),
      },
      { key: "customerName", label: "Customer" },
      {
        key: "issuedAt",
        label: "Tgl. Terbit",
        render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.issuedAt)}</span>,
      },
      {
        key: "dueDate",
        label: "Jatuh Tempo",
        render: (row) => (
          <div>
            <span className="text-xs text-gray-600">{row.dueDate ? formatJakartaDateTime(row.dueDate) : "—"}</span>
            {row.ageDays != null && row.financialStatus !== "paid" && (
              <p className="text-xs text-gray-400">{row.ageDays} hari</p>
            )}
          </div>
        ),
      },
      { key: "totalAmount", label: "Nilai Invoice", align: "right", render: (row) => formatRupiah(row.totalAmount) },
      {
        key: "outstandingBalance",
        label: "Outstanding",
        align: "right",
        render: (row) => <span className="font-semibold text-gray-900">{formatRupiah(row.outstandingBalance)}</span>,
      },
      {
        key: "financialStatus",
        label: "Status",
        render: (row) => <StatusBadge status={row.financialStatus} domain="invoice" />,
      },
      {
        key: "promiseStatus",
        label: "Collection",
        render: (row) =>
          row.promiseStatus ? (
            <StatusBadge status={row.promiseStatus} domain="promise" />
          ) : (
            <span className="text-xs text-gray-400">—</span>
          ),
      },
    ],
    [selected],
  );

  const printHref = `/dashboard/finance/invoices/print-batch?ids=${Array.from(selected).join(",")}`;

  return (
    <div className="space-y-3">
      <button type="button" onClick={toggleAllOnPage} className="text-xs font-medium text-blue-600 hover:underline">
        {allOnPageSelected ? "Batalkan semua" : `Pilih semua di halaman ini (${items.length})`}
      </button>

      <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
        <DataTable<InvoiceListItem> columns={columns} data={items} keyExtractor={(row) => row.id} />
      </div>

      <ul className="space-y-2 md:hidden">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() => toggle(item.id)}
              aria-label={`Pilih invoice ${item.invoiceNumber}`}
              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/dashboard/finance/invoices/${item.id}`}
                    className="font-mono text-sm font-semibold text-blue-600 hover:underline"
                  >
                    {item.invoiceNumber}
                  </Link>
                  <p className="mt-0.5 text-xs text-gray-500">{item.customerName}</p>
                </div>
                <StatusBadge status={item.financialStatus} domain="invoice" />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                <div>
                  <dt className="text-gray-400">Nilai Invoice</dt>
                  <dd className="font-medium text-gray-800">{formatRupiah(item.totalAmount)}</dd>
                </div>
                <div>
                  <dt className="text-gray-400">Outstanding</dt>
                  <dd className="font-semibold text-gray-900">{formatRupiah(item.outstandingBalance)}</dd>
                </div>
                <div>
                  <dt className="text-gray-400">Jatuh Tempo</dt>
                  <dd className="text-gray-700">{item.dueDate ? formatJakartaDateTime(item.dueDate) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-gray-400">Collection</dt>
                  <dd>{item.promiseStatus ? <StatusBadge status={item.promiseStatus} domain="promise" /> : "—"}</dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ul>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 shadow-lg print:hidden">
          <p className="text-sm font-medium text-blue-800">{selected.size} invoice dipilih</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs font-medium text-blue-600 hover:underline"
            >
              Batal
            </button>
            <a
              href={printHref}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              Cetak Terpilih
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
