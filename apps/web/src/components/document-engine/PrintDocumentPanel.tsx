// =============================================================================
// AODP Document Engine -- print panel renderer. Komponen ini PURE PRESENTATIONAL:
// hanya menerima PaginatedPrintPanel yang sudah tervalidasi/terformat
// (lib/document-engine/print-pagination.ts) -- TIDAK PERNAH melakukan query
// repository/database, TIDAK PERNAH menghitung uang.
//
// LOCK "AODP WALUYO -- CONTINUATION PANEL PRINT GATE" (23 Juli 2026,
// corrective pass kedua): SATU dokumen bisa terdiri dari 1..N panel
// (continuation) di dalam satu atau lebih PhysicalPrintSheet. Komponen ini
// merender SATU panel/halaman dari dokumen tersebut -- identitas dokumen
// (nomor, versi, tenant, pelanggan) SAMA di seluruh panel; HANYA panel
// final (panel.isFinalPanel) menampilkan totals & tanda tangan.
// Komponen ini TIDAK memiliki wrapper halaman fisik -- itu tanggung jawab
// PhysicalPrintSheet (satu sheet = dua panel).
//
// LOCKED (Founder, 23 Juli 2026): tanda tangan final SALESMAN, PENGIRIM,
// PENERIMA -- BUKAN "Disiapkan Oleh"/"Diterima Oleh".
//
// Dilarang menampilkan bagian "CATATAN" apa pun, DPP/PPN/Biaya Lain,
// footer benefit/service, badge continuous form, atau strip COPY 1-4 --
// kontrak Totals aktif HANYA Subtotal/Potongan/Grand Total/Terbilang.
// Bank/No. Rekening/Metode Pembayaran TIDAK ditampilkan karena belum ada
// canonical source di skema -- BUKAN dikarang.
//
// AUDIT FIX (corrective pass kedua): perforasi/sprocket/dekorasi
// continuous-form DIHAPUS total dari production print -- lihat print.css.
// =============================================================================

import type { PaginatedPrintPanel } from "@/lib/document-engine/print-pagination";
import "./print.css";

export interface PrintDocumentPanelProps {
  panel: PaginatedPrintPanel;
}

function MailIcon() {
  return (
    <svg className="doc-engine-contact-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 4h16v12H2z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 4l8 7 8-7" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg className="doc-engine-contact-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 3c-1 0-1.5.7-1.4 1.6C3.2 9.8 10.2 16.8 15.4 17.4c.9.1 1.6-.4 1.6-1.4v-2.1c0-.5-.3-.9-.8-1l-2.6-.7c-.4-.1-.8 0-1 .3l-.8 1c-2-1-3.6-2.6-4.6-4.6l1-.8c.3-.2.4-.6.3-1L8.2 3.8c-.1-.5-.5-.8-1-.8H4z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PrintDocumentPanel({ panel }: PrintDocumentPanelProps) {
  const p = panel;
  const isContinuationDocument = p.pageCount > 1;

  return (
    <div className="doc-engine-panel" data-document-number={p.documentNumber} data-page-index={p.pageIndex} data-page-count={p.pageCount}>
      <div className="doc-engine-content">
        <header className="doc-engine-header">
          <div className="doc-engine-company-block">
            {p.tenant.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- dokumen cetak statis, bukan halaman web biasa
              <img src={p.tenant.logoUrl} alt="" className="doc-engine-logo" />
            ) : null}
            <div>
              <div className="doc-engine-company-name">{p.tenant.companyName}</div>
              <div className="doc-engine-company-address">{p.tenant.companyAddress}</div>
              <div className="doc-engine-company-contact">
                <span>
                  <MailIcon />
                  {p.tenant.companyEmail}
                </span>
                <span>
                  <PhoneIcon />
                  {p.tenant.companyPhone}
                </span>
              </div>
            </div>
          </div>
          <div className="doc-engine-meta-box">
            <div className="doc-engine-meta-title">{p.documentTypeLabel}</div>
            <table className="doc-engine-meta-table">
              <tbody>
                <tr>
                  <td>No. Dokumen</td>
                  <td>:</td>
                  <td>{p.documentNumber}</td>
                </tr>
                <tr>
                  <td>Tanggal</td>
                  <td>:</td>
                  <td>{p.documentDateLabel}</td>
                </tr>
                {p.dueDateLabel ? (
                  <tr>
                    <td>Tempo</td>
                    <td>:</td>
                    <td>{p.dueDateLabel}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>Salesman</td>
                  <td>:</td>
                  <td>{p.salesmanName}</td>
                </tr>
                {isContinuationDocument ? (
                  <tr>
                    <td>Halaman</td>
                    <td>:</td>
                    <td className="doc-engine-page-indicator">
                      {p.pageIndex}/{p.pageCount}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </header>

        <div className="doc-engine-identity-divider" />

        <div className="doc-engine-info-row">
          <section className="doc-engine-info-panel">
            <div className="doc-engine-panel-title">DATA TOKO / CUSTOMER</div>
            <div className="doc-engine-info-columns">
              <div className="doc-engine-info-column">
                <table className="doc-engine-info-table">
                  <tbody>
                    <tr>
                      <td>Kode Toko</td>
                      <td>:</td>
                      <td>{p.storeCode}</td>
                    </tr>
                    <tr>
                      <td>Nama Toko</td>
                      <td>:</td>
                      <td>{p.storeName}</td>
                    </tr>
                    <tr>
                      <td>Alamat</td>
                      <td>:</td>
                      <td>{p.storeAddress}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="doc-engine-info-column">
                <table className="doc-engine-info-table">
                  <tbody>
                    <tr>
                      <td>No. Telp</td>
                      <td>:</td>
                      <td>{p.storePhone}</td>
                    </tr>
                    <tr>
                      <td>Ref. Order</td>
                      <td>:</td>
                      <td>{p.orderReference}</td>
                    </tr>
                    {p.deliveryReference ? (
                      <tr>
                        <td>Ref. Delivery</td>
                        <td>:</td>
                        <td>{p.deliveryReference}</td>
                      </tr>
                    ) : null}
                    <tr>
                      <td>Salesman</td>
                      <td>:</td>
                      <td>{p.salesmanName}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <table className="doc-engine-items">
          <thead>
            <tr>
              <th>No</th>
              <th>Kode Barang</th>
              <th>Nama Produk</th>
              <th>Jenis Produk</th>
              <th>Satuan</th>
              <th>Qty</th>
              <th>Harga</th>
              <th>Potongan</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((line) => (
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

        {!p.isFinalPanel ? (
          <div className="doc-engine-continuation-marker">Bersambung ke halaman berikutnya</div>
        ) : null}

        {p.totals && p.signatures ? (
          <div className="doc-engine-footer-row">
            <footer className="doc-engine-signatures">
              <div className="doc-engine-signature-block">
                <div className="doc-engine-signature-space" />
                <div className="doc-engine-signature-line" />
                <div className="doc-engine-signature-role">SALESMAN</div>
                <div className="doc-engine-signature-name">{p.signatures.salesmanName}</div>
              </div>
              <div className="doc-engine-signature-block">
                <div className="doc-engine-signature-space" />
                <div className="doc-engine-signature-line" />
                <div className="doc-engine-signature-role">PENGIRIM</div>
                <div className="doc-engine-signature-name">{p.signatures.delivererName}</div>
              </div>
              <div className="doc-engine-signature-block">
                <div className="doc-engine-signature-space" />
                <div className="doc-engine-signature-line" />
                <div className="doc-engine-signature-role">PENERIMA</div>
                {p.receiverName ? (
                  <div className="doc-engine-signature-name">{p.receiverName}</div>
                ) : (
                  <div className="doc-engine-signature-placeholder">
                    (....................)
                    <br />
                    Nama &amp; Tanda Tangan
                  </div>
                )}
              </div>
            </footer>

            <div className="doc-engine-totals-box">
              <div className="doc-engine-totals-row">
                <span>Subtotal Barang</span>
                <span>{p.totals.subtotalLabel}</span>
              </div>
              <div className="doc-engine-totals-row">
                <span>Potongan</span>
                <span>{p.totals.totalDiscountLabel}</span>
              </div>
              <div className="doc-engine-grand-total">
                <span>GRAND TOTAL</span>
                <span className="doc-engine-grand-total-value">{p.totals.grandTotalLabel}</span>
              </div>
              <div className="doc-engine-terbilang">Terbilang: {p.totals.terbilangLabel}</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
