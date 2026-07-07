import Link from "next/link";
import { ListTodo, ArrowRight, CheckCircle2 } from "lucide-react";
import type { ExecutiveAction, Priority } from "@/lib/executive/types";

interface ActionsCardProps {
  actions: ExecutiveAction[];
}

const PRIORITY_BADGE: Record<Priority, string> = {
  URGENT: "bg-red-100 text-red-700 border-red-200",
  HIGH: "bg-amber-100 text-amber-700 border-amber-200",
  MEDIUM: "bg-blue-100 text-blue-700 border-blue-200",
};

export function ActionsCard({ actions }: ActionsCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
          <ListTodo className="h-4 w-4 text-blue-600" />
        </div>
        <h2 className="text-sm font-semibold text-gray-900">Tindakan Direkomendasikan</h2>
        {actions.length > 0 && (
          <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {actions.length}
          </span>
        )}
      </div>

      {actions.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4" />
          Tidak ada tindakan mendesak — pertahankan ritme saat ini.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {actions.map((a, i) => (
            <li key={`${a.module}-${i}`} className="flex items-start gap-3">
              <span
                className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${PRIORITY_BADGE[a.priority]}`}
              >
                {a.priority}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">{a.action}</p>
                <p className="text-xs text-gray-500">{a.rationale}</p>
              </div>
              {a.href && (
                <Link
                  href={a.href}
                  className="mt-0.5 flex shrink-0 items-center gap-0.5 text-xs font-medium text-blue-600 hover:text-blue-800"
                >
                  Buka <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
