"use client";

// Tombol "Cetak Sekarang" -- panggil dialog print browser (window.print()).
// Tidak mengatur printer/driver apa pun (di luar jangkauan web app) --
// murni shortcut supaya user tidak perlu tahu Ctrl+P. print:hidden supaya
// tombol ini sendiri tidak ikut tercetak.
export function PrintNowButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="fixed bottom-4 right-4 z-10 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-blue-700 print:hidden"
    >
      Cetak Sekarang
    </button>
  );
}
