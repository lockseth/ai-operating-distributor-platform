// =============================================================================
// AODP Document Engine -- print renderer. Komponen ini PURE PRESENTATIONAL:
// hanya menerima PrintDocumentViewModel yang sudah tervalidasi/terformat
// (lib/document-engine/print-view-model.ts) -- TIDAK PERNAH melakukan query
// repository/database, TIDAK PERNAH menghitung uang (formatRupiah sudah
// dipanggil di view model, bukan di sini). Dilarang menampilkan bagian
// "CATATAN" apa pun (lihat AODP_DOCUMENT_CONSTITUTION_v1.0.md footer
// Pengirim/Penerima -- gate ini merevisi footer menjadi Salesman/Pengirim/
// Penerima TANPA Catatan, sesuai spesifikasi bisnis LOCKED gate ini).
// =============================================================================

import type { PrintDocumentViewModel, PrintPanelViewModel } from "@/lib/document-engine/print-view-model";
import "./print.css";

export interface PrintDocumentPageProps {
  viewModel: PrintDocumentViewModel;
}

export function PrintDocumentPage({ viewModel }: PrintDocumentPageProps) {
  const [panelA, panelB] = viewModel.panels;
  return (
    <div className="doc-engine-page" data-document-number={viewModel.documentNumber}>
      <DocumentPanel panel={panelA} />
      <DocumentPanel panel={panelB} />
    </div>
  );
}

function DocumentPanel({ panel }: { panel: PrintPanelViewModel }) {
  return (
    <section className="doc-engine-panel">
      <header className="doc-engine-header">
        <div className="doc-engine-company-block">
          {panel.tenant.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- dokumen cetak statis, bukan halaman web biasa
            <img src={panel.tenant.logoUrl} alt="" className="doc-engine-logo" />
          ) : null}
          <div>
            <div className="doc-engine-company-name">{panel.tenant.companyName}</div>
            <div>{panel.tenant.companyAddress}</div>
            <div>
              {panel.tenant.companyEmail} &middot; {panel.tenant.companyPhone}
            </div>
          </div>
        </div>
        <div className="doc-engine-doc-meta">
          <div className="doc-engine-doc-title">{panel.documentTypeLabel}</div>
          <div>No: {panel.documentNumber}</div>
          <div>Tanggal: {panel.documentDateLabel}</div>
        </div>
      </header>

      <section className="doc-engine-customer">
        <div>Toko: {panel.storeName}</div>
        <div>Alamat: {panel.storeAddress}</div>
        <div>PIC/Penerima: {panel.picLabel}</div>
        <div>Salesman: {panel.salesmanName}</div>
        <div>Ref. Order: {panel.orderReference}</div>
        {panel.deliveryReference ? <div>Ref. Delivery: {panel.deliveryReference}</div> : null}
        <div>Termin: {panel.paymentTermsLabel}</div>
      </section>

      <table className="doc-engine-items">
        <thead>
          <tr>
            <th>No</th>
            <th>Kode</th>
            <th>Nama Produk</th>
            <th>Jenis</th>
            <th>Satuan</th>
            <th>Qty</th>
            <th>Harga</th>
            <th>Potongan</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {panel.lines.map((line) => (
            <tr key={line.no}>
              <td>{line.no}</td>
              <td>{line.productCode}</td>
              <td>{line.productName}</td>
              <td>{line.productType}</td>
              <td>{line.unit}</td>
              <td>{line.quantity}</td>
              <td>{line.unitPriceLabel}</td>
              <td>{line.discountLabel}</td>
              <td>{line.lineTotalLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="doc-engine-totals">
        <div>Subtotal: {panel.subtotalLabel}</div>
        <div>Total Potongan: {panel.totalDiscountLabel}</div>
        <div className="doc-engine-grand-total">Grand Total: {panel.grandTotalLabel}</div>
        <div className="doc-engine-terbilang">Terbilang: {panel.terbilangLabel}</div>
      </section>

      <footer className="doc-engine-signatures">
        <div className="doc-engine-signature-block">
          <div className="doc-engine-signature-line" />
          <div className="doc-engine-signature-role">Salesman</div>
          <div>{panel.signatures.salesmanName}</div>
        </div>
        <div className="doc-engine-signature-block">
          <div className="doc-engine-signature-line" />
          <div className="doc-engine-signature-role">Pengirim</div>
          <div>{panel.signatures.delivererName}</div>
        </div>
        <div className="doc-engine-signature-block">
          <div className="doc-engine-signature-line" />
          <div className="doc-engine-signature-role">Penerima</div>
        </div>
      </footer>
    </section>
  );
}
