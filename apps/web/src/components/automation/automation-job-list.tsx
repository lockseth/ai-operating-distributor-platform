"use client";

import { useState } from "react";
import { listAutomationJobsAction, replayAutomationJobAction } from "@/lib/n8n-automation/actions";
import type { AutomationJobStatus, AutomationOutboxListItem } from "@/lib/n8n-automation/types";

interface AutomationJobListProps {
  initialJobs: AutomationOutboxListItem[];
}

const STATUS_LABEL: Record<AutomationJobStatus, string> = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  RETRY: "RETRY",
  FAILED: "FAILED",
  DEAD_LETTER: "DEAD_LETTER",
};

const STATUS_TONE: Record<AutomationJobStatus, string> = {
  PENDING: "bg-gray-100 text-gray-600",
  PROCESSING: "bg-blue-50 text-blue-700",
  SENT: "bg-green-50 text-green-700",
  RETRY: "bg-amber-50 text-amber-700",
  FAILED: "bg-red-50 text-red-700",
  DEAD_LETTER: "bg-red-100 text-red-800",
};

const ALL_STATUSES: AutomationJobStatus[] = [
  "PENDING",
  "PROCESSING",
  "RETRY",
  "SENT",
  "FAILED",
  "DEAD_LETTER",
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ReplayButton({ jobId, onReplayed }: { jobId: string; onReplayed: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReplay() {
    setSaving(true);
    setError(null);
    const result = await replayAutomationJobAction(jobId, reason);
    setSaving(false);
    if (result.ok) {
      setOpen(false);
      setReason("");
      onReplayed();
    } else {
      setError(result.error ?? "Gagal replay.");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
      >
        Replay
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        className="w-40 rounded-lg border border-gray-300 px-2 py-1 text-xs"
        placeholder="Alasan replay"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="button"
        disabled={saving}
        onClick={handleReplay}
        className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "..." : "Kirim"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400">
        Batal
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function AutomationJobList({ initialJobs }: AutomationJobListProps) {
  const [jobs, setJobs] = useState(initialJobs);
  const [statusFilter, setStatusFilter] = useState<AutomationJobStatus | "ALL">("ALL");
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    const result = await listAutomationJobsAction(
      statusFilter === "ALL" ? undefined : [statusFilter],
    );
    setLoading(false);
    if (result.ok && result.jobs) setJobs(result.jobs);
  }

  async function handleFilterChange(next: AutomationJobStatus | "ALL") {
    setStatusFilter(next);
    setLoading(true);
    const result = await listAutomationJobsAction(next === "ALL" ? undefined : [next]);
    setLoading(false);
    if (result.ok && result.jobs) setJobs(result.jobs);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => handleFilterChange("ALL")}
          className={`rounded-full px-3 py-1 text-xs font-medium ${statusFilter === "ALL" ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600"}`}
        >
          Semua
        </button>
        {ALL_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => handleFilterChange(status)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${statusFilter === status ? "bg-gray-800 text-white" : STATUS_TONE[status]}`}
          >
            {STATUS_LABEL[status]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Memuat...</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Event</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Channel</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Status</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Attempt</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Waktu</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Error</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="px-3 py-2 text-gray-700">{job.eventType}</td>
                  <td className="px-3 py-2 text-gray-500">{job.channel}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[job.status]}`}>
                      {STATUS_LABEL[job.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {job.attemptCount}/{job.maxAttempts}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{formatDateTime(job.createdAt)}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-xs text-gray-400" title={job.lastError ?? ""}>
                    {job.lastError ?? "-"}
                  </td>
                  <td className="px-3 py-2">
                    {(job.status === "DEAD_LETTER" || job.status === "FAILED") && (
                      <ReplayButton jobId={job.id} onReplayed={reload} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
