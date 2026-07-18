"use client";

// =============================================================================
// Form "Tambah PIC" -- admin menambah PIC lain ke toko yang sudah ada
// (satu toko dapat memiliki beberapa PIC). Selalu UNVERIFIED.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Loader2 } from "lucide-react";
import { createCustomerPicAction } from "@/lib/customer-pic/actions";
import { PIC_ROLES, PIC_ROLE_LABEL, type PicRole } from "@/lib/customer-pic/types";

export function AddPicForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<PicRole[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleRole(role: PicRole) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  function submit() {
    if (!name.trim() || !phone.trim() || roles.length === 0) {
      setError("Nama, nomor, dan minimal satu peran wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createCustomerPicAction({
        customerId, name: name.trim(), phone: phone.trim(), email: email.trim() || null, roles,
      });
      if (!result.ok) {
        setError(result.error ?? "Gagal menambah PIC.");
        return;
      }
      setOpen(false);
      setName("");
      setPhone("");
      setEmail("");
      setRoles([]);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
      >
        <UserPlus className="h-3.5 w-3.5" />
        Tambah PIC
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={isPending}
        placeholder="Nama PIC"
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={isPending}
        placeholder="Nomor telepon/WhatsApp"
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={isPending}
        placeholder="Email PIC (opsional)"
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        {PIC_ROLES.map((role) => (
          <label key={role} className="flex items-center gap-1.5 text-xs text-gray-600">
            <input type="checkbox" checked={roles.includes(role)} onChange={() => toggleRole(role)} disabled={isPending} />
            {PIC_ROLE_LABEL[role]}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Simpan PIC
        </button>
        <button
          onClick={() => { setOpen(false); setError(null); }}
          disabled={isPending}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          Batal
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
