import { Sparkles } from "lucide-react";
import type { ExecutiveBriefing } from "@/lib/executive/types";

interface BriefingCardProps {
  briefing: ExecutiveBriefing;
}

export function BriefingCard({ briefing }: BriefingCardProps) {
  return (
    <div className="rounded-xl border border-purple-100 bg-purple-50 p-5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100">
          <Sparkles className="h-4 w-4 text-purple-600" />
        </div>
        <h2 className="text-sm font-semibold text-purple-900">Briefing Eksekutif</h2>
        <span className="ml-auto rounded-full border border-purple-200 bg-white px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-purple-500">
          Ringkasan berbasis aturan v1
        </span>
      </div>

      <p className="mt-3 text-sm font-semibold text-purple-900">{briefing.headline}</p>
      <div className="mt-2 space-y-2">
        {briefing.paragraphs.map((p, i) => (
          <p key={i} className="text-sm leading-relaxed text-purple-800">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}
