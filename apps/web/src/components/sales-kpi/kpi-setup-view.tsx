"use client";

import { useEffect, useState } from "react";
import {
  createSalesKpiPeriodAction,
  getKpiCalibrationBaselineAction,
  getSalesKpiAchievementProjectionAction,
  setSalesKpiPeriodStatusAction,
  setSalesKpiTargetAction,
  setSalesKpiTargetsCalibratedAction,
} from "@/lib/sales-kpi/actions";
import type {
  SalesKpiAchievementProjection,
  SalesKpiCalibrationBaseline,
  SalesKpiPeriodStatus,
} from "@/lib/sales-kpi/types";

interface PeriodOption {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface SalesmanOption {
  id: string;
  fullName: string;
}

interface KpiSetupViewProps {
  periods: PeriodOption[];
  salesmen: SalesmanOption[];
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  LOCKED: "LOCKED",
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  ACTIVE: "bg-blue-50 text-blue-700",
  LOCKED: "bg-red-50 text-red-700",
};

function NewPeriodForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [workingDays, setWorkingDays] = useState(21);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    const result = await createSalesKpiPeriodAction({ name, startDate, endDate, workingDays });
    setSaving(false);
    if (result.ok) {
      setOpen(false);
      setName("");
      setStartDate("");
      setEndDate("");
      onCreated();
    } else {
      setError(result.error ?? "Gagal membuat periode.");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
      >
        + Buat Periode Baru
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <input
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm sm:col-span-2"
          placeholder="Nama periode (mis. Agustus 2026)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="date"
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <input
          type="date"
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600">
          Hari kerja:
          <input
            type="number"
            min={1}
            className="ml-2 w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm"
            value={workingDays}
            onChange={(e) => setWorkingDays(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={saving}
          onClick={handleSubmit}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Menyimpan..." : "Simpan Periode (DRAFT)"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-gray-500 hover:underline"
        >
          Batal
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function SalesmanCalibrationRow({
  periodId,
  periodStatus,
  salesman,
}: {
  periodId: string;
  periodStatus: string;
  salesman: SalesmanOption;
}) {
  const [baseline, setBaseline] = useState<SalesKpiCalibrationBaseline | null>(null);
  const [projection, setProjection] = useState<SalesKpiAchievementProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [callTarget, setCallTarget] = useState("");
  const [ecTarget, setEcTarget] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [orderCountTarget, setOrderCountTarget] = useState("");
  const [revenueTarget, setRevenueTarget] = useState("");
  const [orderReason, setOrderReason] = useState("");
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [orderSavedNote, setOrderSavedNote] = useState<string | null>(null);

  const [nooTarget, setNooTarget] = useState("");
  const [nooReason, setNooReason] = useState("");
  const [nooError, setNooError] = useState<string | null>(null);
  const [nooSaving, setNooSaving] = useState(false);
  const [nooSavedNote, setNooSavedNote] = useState<string | null>(null);

  async function applyCalibrationData(
    baselineResult: Awaited<ReturnType<typeof getKpiCalibrationBaselineAction>>,
    projectionResult: Awaited<ReturnType<typeof getSalesKpiAchievementProjectionAction>>,
  ) {
    setLoading(false);
    if (baselineResult.ok && baselineResult.baseline) setBaseline(baselineResult.baseline);
    if (projectionResult.ok && projectionResult.projection) {
      setProjection(projectionResult.projection);
      setCallTarget(
        projectionResult.projection.call.target !== null
          ? String(projectionResult.projection.call.target)
          : "",
      );
      setEcTarget(
        projectionResult.projection.effectiveCall.target !== null
          ? String(projectionResult.projection.effectiveCall.target)
          : "",
      );
      setReason(
        projectionResult.projection.call.target !== null ? "" : "Target awal periode",
      );
      setOrderCountTarget(
        projectionResult.projection.orderCount.target !== null
          ? String(projectionResult.projection.orderCount.target)
          : "",
      );
      setRevenueTarget(
        projectionResult.projection.revenue.target !== null
          ? String(projectionResult.projection.revenue.target)
          : "",
      );
      setNooTarget(
        projectionResult.projection.noo.target !== null
          ? String(projectionResult.projection.noo.target)
          : "",
      );
    }
  }

  async function reload() {
    const [baselineResult, projectionResult] = await Promise.all([
      getKpiCalibrationBaselineAction(periodId, salesman.id),
      getSalesKpiAchievementProjectionAction(periodId, salesman.id),
    ]);
    await applyCalibrationData(baselineResult, projectionResult);
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      const [baselineResult, projectionResult] = await Promise.all([
        getKpiCalibrationBaselineAction(periodId, salesman.id),
        getSalesKpiAchievementProjectionAction(periodId, salesman.id),
      ]);
      if (cancelled) return;
      await applyCalibrationData(baselineResult, projectionResult);
    }
    void run();

    return () => {
      cancelled = true;
    };
  }, [periodId, salesman.id]);

  const hasExistingTarget = projection ? projection.call.target !== null : false;
  const canEdit = periodStatus !== "LOCKED";

  async function handleSave() {
    setError(null);
    setSavedNote(null);
    const callValue = Number(callTarget);
    const ecValue = Number(ecTarget);
    if (!Number.isInteger(callValue) || callValue < 0) {
      setError("Target Call harus bilangan bulat non-negatif.");
      return;
    }
    if (!Number.isInteger(ecValue) || ecValue < 0) {
      setError("Target EC harus bilangan bulat non-negatif.");
      return;
    }
    if (ecValue > callValue) {
      setError("Target EC tidak boleh melebihi target Call.");
      return;
    }
    if (reason.trim().length < 3) {
      setError("Alasan perubahan wajib diisi (minimal 3 karakter).");
      return;
    }

    setSaving(true);
    const result = await setSalesKpiTargetsCalibratedAction({
      periodId,
      salespersonId: salesman.id,
      callTarget: callValue,
      ecTarget: ecValue,
      changeReason: reason,
    });
    setSaving(false);
    if (result.ok) {
      setSavedNote("Target tersimpan.");
      setReason("");
      await reload();
    } else {
      setError(result.error ?? "Gagal menyimpan target.");
    }
  }

  async function handleSaveOrderRevenue() {
    setOrderError(null);
    setOrderSavedNote(null);
    const orderCountValue = Number(orderCountTarget);
    const revenueValue = Number(revenueTarget);
    if (!Number.isInteger(orderCountValue) || orderCountValue < 0) {
      setOrderError("Target Order Count harus bilangan bulat non-negatif.");
      return;
    }
    if (!Number.isInteger(revenueValue) || revenueValue < 0) {
      setOrderError("Target Revenue harus bilangan bulat non-negatif (Rupiah).");
      return;
    }
    if (orderReason.trim().length < 3) {
      setOrderError("Alasan perubahan wajib diisi (minimal 3 karakter).");
      return;
    }

    setOrderSaving(true);
    const orderCountResult = await setSalesKpiTargetAction({
      periodId,
      salespersonId: salesman.id,
      kpiCode: "ORDER_COUNT",
      targetValue: orderCountValue,
      changeReason: orderReason,
    });
    if (!orderCountResult.ok) {
      setOrderSaving(false);
      setOrderError(orderCountResult.error ?? "Gagal menyimpan target Order Count.");
      return;
    }
    const revenueResult = await setSalesKpiTargetAction({
      periodId,
      salespersonId: salesman.id,
      kpiCode: "REVENUE",
      targetValue: revenueValue,
      changeReason: orderReason,
    });
    setOrderSaving(false);
    if (revenueResult.ok) {
      setOrderSavedNote("Target tersimpan.");
      setOrderReason("");
      await reload();
    } else {
      setOrderError(revenueResult.error ?? "Gagal menyimpan target Revenue.");
    }
  }

  async function handleSaveNoo() {
    setNooError(null);
    setNooSavedNote(null);
    const nooValue = Number(nooTarget);
    if (!Number.isInteger(nooValue) || nooValue < 0) {
      setNooError("Target NOO harus bilangan bulat non-negatif (jumlah toko).");
      return;
    }
    if (nooReason.trim().length < 3) {
      setNooError("Alasan perubahan wajib diisi (minimal 3 karakter).");
      return;
    }

    setNooSaving(true);
    const nooResult = await setSalesKpiTargetAction({
      periodId,
      salespersonId: salesman.id,
      kpiCode: "NOO",
      targetValue: nooValue,
      changeReason: nooReason,
    });
    setNooSaving(false);
    if (nooResult.ok) {
      setNooSavedNote("Target tersimpan.");
      setNooReason("");
      await reload();
    } else {
      setNooError(nooResult.error ?? "Gagal menyimpan target NOO.");
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-800">{salesman.fullName}</h3>

      {loading ? (
        <p className="mt-2 text-xs text-gray-400">Memuat baseline...</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium text-gray-500">Baseline Historis (evidence)</p>
            {!baseline || baseline.sufficiency === "INSUFFICIENT" ? (
              <p className="mt-1 text-sm text-gray-400">Data belum cukup</p>
            ) : (
              <div className="mt-1 space-y-0.5 text-sm text-gray-700">
                <p>Call: {baseline.historicalCall}</p>
                <p>EC: {baseline.historicalEffectiveCall}</p>
                <p>EC Rate: {baseline.ecRate !== null ? `${baseline.ecRate}%` : "-"}</p>
                <p className="text-xs text-gray-400">{baseline.observedDays} hari observasi</p>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500">Target</p>
            <div className="mt-1 flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-sm">
                Call
                <input
                  type="number"
                  min={0}
                  disabled={!canEdit}
                  className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                  value={callTarget}
                  onChange={(e) => setCallTarget(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                EC
                <input
                  type="number"
                  min={0}
                  disabled={!canEdit}
                  className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                  value={ecTarget}
                  onChange={(e) => setEcTarget(e.target.value)}
                />
              </label>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500">Achievement Otomatis</p>
            {projection ? (
              <div className="mt-1 space-y-0.5 text-sm text-gray-700">
                <p>Call: {projection.call.actual}{projection.call.target !== null ? ` / ${projection.call.target}` : ""}</p>
                <p>EC: {projection.effectiveCall.actual}{projection.effectiveCall.target !== null ? ` / ${projection.effectiveCall.target}` : ""}</p>
              </div>
            ) : (
              <p className="mt-1 text-sm text-gray-400">Data belum cukup</p>
            )}
          </div>
        </div>
      )}

      {!loading && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <p className="text-xs font-medium text-gray-500">Target Order Count &amp; Revenue (semua channel order confirmed)</p>
          <div className="mt-1 flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              Order Count
              <input
                type="number"
                min={0}
                disabled={!canEdit}
                className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                value={orderCountTarget}
                onChange={(e) => setOrderCountTarget(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              Revenue (Rp)
              <input
                type="number"
                min={0}
                disabled={!canEdit}
                className="w-32 rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                value={revenueTarget}
                onChange={(e) => setRevenueTarget(e.target.value)}
              />
            </label>
            {projection && (
              <p className="text-xs text-gray-500">
                Achievement: {projection.orderCount.actual} order
                {projection.orderCount.target !== null ? ` / ${projection.orderCount.target}` : ""}
                {" -- "}
                Rp{Math.round(projection.revenue.actual).toLocaleString("id-ID")}
                {projection.revenue.target !== null
                  ? ` / Rp${Math.round(projection.revenue.target).toLocaleString("id-ID")}`
                  : ""}
              </p>
            )}
          </div>
          {canEdit && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="min-w-[16rem] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                placeholder="Alasan perubahan (wajib)"
                value={orderReason}
                onChange={(e) => setOrderReason(e.target.value)}
              />
              <button
                type="button"
                disabled={orderSaving}
                onClick={handleSaveOrderRevenue}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {orderSaving ? "Menyimpan..." : "Simpan Target"}
              </button>
            </div>
          )}
          {!canEdit && (
            <p className="mt-2 text-xs text-gray-400">Periode terkunci -- target tidak dapat diubah.</p>
          )}
          {orderError && <p className="mt-2 text-sm text-red-600">{orderError}</p>}
          {orderSavedNote && <p className="mt-2 text-sm text-green-600">{orderSavedNote}</p>}
        </div>
      )}

      {!loading && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <p className="text-xs font-medium text-gray-500">
            Target NOO / Buka Toko Baru (jumlah toko baru produktif -- customer dengan sales order confirmed pertama kalinya)
          </p>
          <div className="mt-1 flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm">
              Target (jumlah toko)
              <input
                type="number"
                min={0}
                disabled={!canEdit}
                className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                value={nooTarget}
                onChange={(e) => setNooTarget(e.target.value)}
              />
            </label>
            {projection && (
              <p className="text-xs text-gray-500">
                Realisasi: {projection.noo.actual} toko
                {projection.noo.target !== null ? ` / ${projection.noo.target}` : ""}
              </p>
            )}
          </div>
          {canEdit && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="min-w-[16rem] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                placeholder="Alasan perubahan (wajib)"
                value={nooReason}
                onChange={(e) => setNooReason(e.target.value)}
              />
              <button
                type="button"
                disabled={nooSaving}
                onClick={handleSaveNoo}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {nooSaving ? "Menyimpan..." : "Simpan Target"}
              </button>
            </div>
          )}
          {!canEdit && (
            <p className="mt-2 text-xs text-gray-400">Periode terkunci -- target tidak dapat diubah.</p>
          )}
          {nooError && <p className="mt-2 text-sm text-red-600">{nooError}</p>}
          {nooSavedNote && <p className="mt-2 text-sm text-green-600">{nooSavedNote}</p>}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="min-w-[16rem] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            placeholder={hasExistingTarget ? "Alasan perubahan (wajib)" : "Alasan/catatan target awal"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Menyimpan..." : "Simpan Target"}
          </button>
        </div>
      )}
      {!canEdit && (
        <p className="mt-3 text-xs text-gray-400">Periode terkunci -- target tidak dapat diubah.</p>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {savedNote && <p className="mt-2 text-sm text-green-600">{savedNote}</p>}
    </div>
  );
}

export function KpiSetupView({ periods: initialPeriods, salesmen }: KpiSetupViewProps) {
  const [periods, setPeriods] = useState(initialPeriods);
  const [periodId, setPeriodId] = useState(initialPeriods[0]?.id ?? "");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  const selectedPeriod = periods.find((p) => p.id === periodId) ?? null;

  async function refreshPeriods() {
    // Re-fetch tidak tersedia dari client tanpa server action daftar --
    // cukup reload halaman supaya periode baru muncul di selector.
    window.location.reload();
  }

  async function handleStatusChange(nextStatus: SalesKpiPeriodStatus) {
    if (!selectedPeriod) return;
    setStatusSaving(true);
    setStatusError(null);
    const result = await setSalesKpiPeriodStatusAction(selectedPeriod.id, nextStatus);
    setStatusSaving(false);
    if (result.ok) {
      setPeriods((prev) =>
        prev.map((p) => (p.id === selectedPeriod.id ? { ...p, status: nextStatus } : p)),
      );
    } else {
      setStatusError(result.error ?? "Gagal mengubah status periode.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">Periode</span>
          <select
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
          >
            {periods.length === 0 && <option value="">Belum ada periode</option>}
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.status})
              </option>
            ))}
          </select>
        </label>

        <NewPeriodForm onCreated={refreshPeriods} />

        {selectedPeriod && (
          <>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[selectedPeriod.status] ?? "bg-gray-100 text-gray-600"}`}
            >
              {STATUS_LABEL[selectedPeriod.status] ?? selectedPeriod.status}
            </span>
            {selectedPeriod.status === "DRAFT" && (
              <button
                type="button"
                disabled={statusSaving}
                onClick={() => handleStatusChange("ACTIVE")}
                className="rounded-lg border border-blue-300 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50"
              >
                Aktifkan Periode
              </button>
            )}
            {selectedPeriod.status === "ACTIVE" && (
              <button
                type="button"
                disabled={statusSaving}
                onClick={() => handleStatusChange("LOCKED")}
                className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Kunci Periode
              </button>
            )}
          </>
        )}
      </div>
      {statusError && <p className="text-sm text-red-600">{statusError}</p>}

      {!selectedPeriod ? (
        <p className="text-sm text-gray-400">Buat periode DRAFT untuk mulai kalibrasi target.</p>
      ) : salesmen.length === 0 ? (
        <p className="text-sm text-gray-400">Belum ada salesman aktif di tenant ini.</p>
      ) : (
        <div className="space-y-3">
          {salesmen.map((salesman) => (
            <SalesmanCalibrationRow
              key={salesman.id}
              periodId={selectedPeriod.id}
              periodStatus={selectedPeriod.status}
              salesman={salesman}
            />
          ))}
        </div>
      )}
    </div>
  );
}
