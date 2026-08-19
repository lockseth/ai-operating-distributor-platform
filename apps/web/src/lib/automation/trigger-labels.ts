// =============================================================================
// Label tampilan untuk trigger_type/event_type automation -- dipakai bareng
// oleh halaman Automation (tabel rules & webhooks) dan form Tambah Webhook,
// supaya daftar event type yang bisa dipilih selalu konsisten dengan yang
// ditampilkan di tabel.
// =============================================================================

export const TRIGGER_LABELS: Record<string, string> = {
  customer_dormant: "Reseller Dormant",
  churn_risk: "Churn Risk",
  repeat_order_due: "Repeat Order Due",
  large_order: "Order Besar",
  new_order: "Order Baru",
  low_stock: "Stok Rendah",
  payment_overdue: "Pembayaran Jatuh Tempo",
  new_customer: "Reseller Baru",
  scheduled_daily: "Jadwal Harian",
  scheduled_weekly: "Jadwal Mingguan",
  manual: "Manual",
  special_price_proposal_submitted: "Pengajuan Harga Khusus",
};
