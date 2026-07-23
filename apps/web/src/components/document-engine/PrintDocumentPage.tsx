// =============================================================================
// AODP Document Engine -- print renderer. Komponen ini PURE PRESENTATIONAL:
// hanya menerima PrintDocumentViewModel yang sudah tervalidasi/terformat
// (lib/document-engine/print-view-model.ts) -- TIDAK PERNAH melakukan query
// repository/database, TIDAK PERNAH menghitung uang.
//
// LOCKED (Founder, 2026-07-23): SATU dokumen = SATU halaman fisik 9.5x11in --
// Continuous Form 4 Ply berarti kertas rangkap FISIK/carbonless printer
// (4 lembar karbon tercetak bersamaan satu print run), BUKAN duplikasi
// konten oleh renderer. Sebelumnya komponen ini merender 2 panel identik per
// halaman; itu supersede -- lihat AODP_DOCUMENT_LAYOUT_GUIDE.md revision
// history. Struktur visual mengikuti template Pak Waluyo (source of truth
// visual, docs/document-engine): perforasi kiri/kanan, header logo+identitas,
// garis hijau/oranye, panel metadata dokumen (termasuk SATU-SATUNYA baris
// Tempo pembayaran -- panel KETENTUAN PEMBAYARAN terpisah DIHAPUS
// 2026-07-23, redundan dengan baris ini), panel DATA TOKO/CUSTOMER
// full-width dua kolom internal, tabel produk header hijau, panel tanda
// tangan, ringkasan total, footer benefit/service, badge continuous form +
// strip COPY 1-4 (informasi ply, statis -- BUKAN data tenant).
//
// LOCKED (Founder, 2026-07-23): panel DATA TOKO/CUSTOMER full-width dua
// kolom internal (kiri: Kode Toko/Nama Toko/Alamat; kanan: No. Telp/
// Ref. Order/Ref. Delivery/Salesman) -- disetujui setelah verifikasi visual
// PO & Invoice. Jangan mengembalikan panel KETENTUAN PEMBAYARAN terpisah,
// jangan menduplikasi baris Tempo (satu-satunya sumber tetap due date di
// meta-box header), jangan mengubah pembagian dua kolom ini tanpa approval
// eksplisit baru.
//
// Dilarang menampilkan bagian "CATATAN" apa pun, DPP/PPN/Biaya Lain --
// kontrak Totals aktif HANYA Subtotal/Potongan/Grand Total/Terbilang.
// Bank/No. Rekening/Metode Pembayaran TIDAK ditampilkan karena belum ada
// canonical source di skema (lihat laporan gate) -- BUKAN dikarang.
// =============================================================================

import type { PrintDocumentViewModel } from "@/lib/document-engine/print-view-model";
import "./print.css";

export interface PrintDocumentPageProps {
  viewModel: PrintDocumentViewModel;
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

export function PrintDocumentPage({ viewModel }: PrintDocumentPageProps) {
  const vm = viewModel;
  return (
    <div className="doc-engine-page" data-document-number={vm.documentNumber}>
      <div className="doc-engine-perforation doc-engine-perforation-left" />
      <div className="doc-engine-perforation doc-engine-perforation-right" />
      <div className="doc-engine-content">
        <header className="doc-engine-header">
          <div className="doc-engine-company-block">
            {vm.tenant.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- dokumen cetak statis, bukan halaman web biasa
              <img src={vm.tenant.logoUrl} alt="" className="doc-engine-logo" />
            ) : null}
            <div>
              <div className="doc-engine-company-name">{vm.tenant.companyName}</div>
              <div className="doc-engine-company-address">{vm.tenant.companyAddress}</div>
              <div className="doc-engine-company-contact">
                <span>
                  <MailIcon />
                  {vm.tenant.companyEmail}
                </span>
                <span>
                  <PhoneIcon />
                  {vm.tenant.companyPhone}
                </span>
              </div>
            </div>
          </div>
          <div className="doc-engine-meta-box">
            <div className="doc-engine-meta-title">{vm.documentTypeLabel}</div>
            <table className="doc-engine-meta-table">
              <tbody>
                <tr>
                  <td>No. Dokumen</td>
                  <td>:</td>
                  <td>{vm.documentNumber}</td>
                </tr>
                <tr>
                  <td>Tanggal</td>
                  <td>:</td>
                  <td>{vm.documentDateLabel}</td>
                </tr>
                {vm.dueDateLabel ? (
                  <tr>
                    <td>Tempo</td>
                    <td>:</td>
                    <td>{vm.dueDateLabel}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>Salesman</td>
                  <td>:</td>
                  <td>{vm.salesmanName}</td>
                </tr>
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
                      <td>{vm.storeCode}</td>
                    </tr>
                    <tr>
                      <td>Nama Toko</td>
                      <td>:</td>
                      <td>{vm.storeName}</td>
                    </tr>
                    <tr>
                      <td>Alamat</td>
                      <td>:</td>
                      <td>{vm.storeAddress}</td>
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
                      <td>{vm.storePhone}</td>
                    </tr>
                    <tr>
                      <td>Ref. Order</td>
                      <td>:</td>
                      <td>{vm.orderReference}</td>
                    </tr>
                    {vm.deliveryReference ? (
                      <tr>
                        <td>Ref. Delivery</td>
                        <td>:</td>
                        <td>{vm.deliveryReference}</td>
                      </tr>
                    ) : null}
                    <tr>
                      <td>Salesman</td>
                      <td>:</td>
                      <td>{vm.salesmanName}</td>
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
            {vm.lines.map((line) => (
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

        <div className="doc-engine-footer-row">
          <footer className="doc-engine-signatures">
            <div className="doc-engine-signature-block">
              <div className="doc-engine-signature-space" />
              <div className="doc-engine-signature-line" />
              <div className="doc-engine-signature-role">SALESMAN</div>
              <div className="doc-engine-signature-name">{vm.signatures.salesmanName}</div>
            </div>
            <div className="doc-engine-signature-block">
              <div className="doc-engine-signature-space" />
              <div className="doc-engine-signature-line" />
              <div className="doc-engine-signature-role">PENGIRIM</div>
              <div className="doc-engine-signature-name">{vm.signatures.delivererName}</div>
            </div>
            <div className="doc-engine-signature-block">
              <div className="doc-engine-signature-space" />
              <div className="doc-engine-signature-line" />
              <div className="doc-engine-signature-role">DITERIMA OLEH</div>
              {vm.receiverName ? (
                <div className="doc-engine-signature-name">{vm.receiverName}</div>
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
              <span>{vm.subtotalLabel}</span>
            </div>
            <div className="doc-engine-totals-row">
              <span>Potongan</span>
              <span>{vm.totalDiscountLabel}</span>
            </div>
            <div className="doc-engine-grand-total">
              <span>GRAND TOTAL</span>
              <span className="doc-engine-grand-total-value">{vm.grandTotalLabel}</span>
            </div>
            <div className="doc-engine-terbilang">Terbilang: {vm.terbilangLabel}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
