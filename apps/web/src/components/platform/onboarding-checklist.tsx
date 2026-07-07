import { CheckCircle2, Circle, AlertCircle } from "lucide-react";

interface CheckItem {
  key:         string;
  label:       string;
  description: string;
  done:        boolean;
  warning?:    boolean;
}

interface OnboardingChecklistProps {
  items: CheckItem[];
}

export function OnboardingChecklist({ items }: OnboardingChecklistProps) {
  const doneCount  = items.filter((i) => i.done).length;
  const totalCount = items.length;
  const pct        = Math.round((doneCount / totalCount) * 100);

  return (
    <div className="rounded-xl border bg-white p-6 shadow-sm">
      {/* Progress */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Onboarding Checklist</h2>
        <span className="text-sm font-medium text-gray-600">{doneCount}/{totalCount} selesai</span>
      </div>
      <div className="w-full h-2 rounded-full bg-gray-100 mb-5">
        <div
          className={`h-2 rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.key} className={`flex items-start gap-3 rounded-lg p-3 ${
            item.done ? "bg-green-50" : item.warning ? "bg-amber-50" : "bg-gray-50"
          }`}>
            <div className="shrink-0 mt-0.5">
              {item.done ? (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              ) : item.warning ? (
                <AlertCircle className="h-5 w-5 text-amber-500" />
              ) : (
                <Circle className="h-5 w-5 text-gray-300" />
              )}
            </div>
            <div>
              <p className={`text-sm font-medium ${item.done ? "text-green-800" : "text-gray-800"}`}>
                {item.label}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>
            </div>
          </div>
        ))}
      </div>

      {pct === 100 && (
        <div className="mt-4 rounded-lg bg-green-100 px-4 py-3 text-sm text-green-800 font-medium text-center">
          ✅ Tenant siap digunakan!
        </div>
      )}
    </div>
  );
}
