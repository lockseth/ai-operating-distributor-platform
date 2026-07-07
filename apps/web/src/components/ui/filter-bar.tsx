"use client";

interface FilterOption {
  label: string;
  value: string;
}

interface FilterBarProps {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}

export function FilterBar({ options, value, onChange, label }: FilterBarProps) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs font-medium text-gray-500">{label}:</span>}
      <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              value === opt.value
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
