// =============================================================================
// Gate 2I.4 -- G11 (LOCK): placeholder "Segera Hadir" lama diganti server
// redirect ke /dashboard/finance/collection (workspace nyata Gate 2I.2).
// Tidak ada auth check di file ini -- otorisasi final dijaga
// (dashboard)/dashboard/finance/layout.tsx (receivable.view) yang membungkus
// destination redirect, pola identik shim existing (dashboard)/finance/page.tsx
// -> redirect("/dashboard/finance") (master contract §2.1, tidak diubah).
// /dashboard/risk tidak disentuh (di luar scope, master contract §2.4).
// =============================================================================

import { redirect } from "next/navigation";

export default function CollectionRedirectPage() {
  redirect("/dashboard/finance/collection");
}
