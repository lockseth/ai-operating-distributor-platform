"use client";

// Gate 2I.2 -- tab nav dipisah jadi client component supaya bisa highlight
// tab yang benar-benar aktif via usePathname() (FIN-01-05: "Tab aktif
// ter-highlight, URL berubah sesuai sub-route") -- sebelum ada >1 tab
// ber-href (2I.1), highlight statis pada satu-satunya Link tidak masalah;
// sekarang (2I.2) ada 5 route nyata sekaligus, jadi highlight harus
// mengikuti route aktif, bukan selalu tampil biru untuk semuanya.

import { usePathname } from "next/navigation";
import Link from "next/link";

export interface FinanceSection {
  label: string;
  href?: string;
  /** Alasan spesifik kenapa tab ini non-aktif (mis. "Hanya Owner..."), menggantikan tooltip generik "tahap implementasi berikutnya" bila diisi (Gate 2I.4 kontrak §B.1). */
  disabledReason?: string;
}

export function FinanceTabNav({ sections }: { sections: FinanceSection[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigasi Finance Operations" className="mt-3 -mb-px flex gap-1 overflow-x-auto">
      {sections.map((section) => {
        if (!section.href) {
          const reason = section.disabledReason ?? "Tersedia pada tahap implementasi berikutnya";
          return (
            <span
              key={section.label}
              aria-disabled="true"
              title={reason}
              className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-300"
            >
              {section.label}
            </span>
          );
        }
        const isActive = section.href === "/dashboard/finance" ? pathname === section.href : pathname.startsWith(section.href);
        return (
          <Link
            key={section.label}
            href={section.href}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              isActive ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
