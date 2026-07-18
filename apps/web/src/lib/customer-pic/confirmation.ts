// =============================================================================
// Pesan balasan Telegram untuk alur Tambah Toko dan Tambah PIC.
// =============================================================================

import { PIC_ROLES, PIC_ROLE_LABEL, type PicRole, type StoreSummary } from "./types";
import type { StorePicDraft } from "./conversation";

export function buildNoAssignedAreaReply(): string {
  return "Anda belum memiliki wilayah kerja (coverage area) yang ditugaskan. Hubungi admin/owner untuk menetapkan wilayah kerja sebelum menambah toko.";
}

export function buildAskStoreNamePrompt(): string {
  return "Tambah Toko — siapa nama toko/pelanggan baru ini?";
}

export function buildAskStoreAddressPrompt(): string {
  return "Alamat toko? (ketik alamat, atau \"-\" bila belum ada)";
}

export function buildAskStoreAreaPrompt(areas: readonly string[]): string {
  const lines = areas.map((a, i) => `${i + 1}. ${a}`);
  return ["Pilih wilayah (coverage area) toko ini:", ...lines, "", `Balas dengan angka 1-${areas.length}.`].join("\n");
}

export function buildInvalidChoiceReply(maxOption: number): string {
  return `Pilihan tidak dikenali. Balas dengan angka 1-${maxOption}.`;
}

export function buildAskStorePhonePrompt(): string {
  return "Nomor telepon toko? (ketik nomornya, atau \"-\" bila belum ada)";
}

export function buildAskPicNamePrompt(): string {
  return "Siapa nama PIC (contact person) toko ini?";
}

export function buildAskPicPhonePrompt(): string {
  return "Nomor telepon/WhatsApp PIC?";
}

export function buildAskPicEmailPrompt(): string {
  return "Email PIC (opsional). Ketik tanda - jika tidak ada.";
}

export function buildInvalidEmailReply(): string {
  return "Format email tidak valid. Ketik ulang email yang benar, atau \"-\" untuk melewati.";
}

export function buildAskPicRolesPrompt(): string {
  const lines = PIC_ROLES.map((r, i) => `${i + 1}. ${PIC_ROLE_LABEL[r]}`);
  return [
    "Peran PIC ini (boleh lebih dari satu, pisahkan dengan koma/spasi, mis. \"1,3\"):",
    ...lines,
    "",
    `Balas dengan angka 1-${PIC_ROLES.length}.`,
  ].join("\n");
}

export function buildInvalidMultiChoiceReply(maxOption: number): string {
  return `Pilihan tidak dikenali. Balas satu atau lebih angka 1-${maxOption}, dipisah koma/spasi (mis. "1,3").`;
}

function rolesLabel(roles: readonly PicRole[]): string {
  return roles.map((r) => PIC_ROLE_LABEL[r]).join(", ");
}

export function buildFinalConfirmationPrompt(draft: StorePicDraft): string {
  return [
    "Ringkasan Toko Baru:",
    `Nama Toko: ${draft.storeName ?? "-"}`,
    `Alamat: ${draft.storeAddress ?? "-"}`,
    `Wilayah: ${draft.storeArea ?? "-"}`,
    `Telepon Toko: ${draft.storePhone ?? "-"}`,
    "",
    "PIC:",
    `Nama: ${draft.picName ?? "-"}`,
    `Telepon: ${draft.picPhone ?? "-"}`,
    `Email: ${draft.picEmail ?? "-"}`,
    `Peran: ${draft.picRoles ? rolesLabel(draft.picRoles) : "-"}`,
    "",
    "Balas KONFIRMASI untuk menyimpan, UBAH untuk mengulang isian, atau BATAL untuk membatalkan.",
  ].join("\n");
}

export function buildProcessCancelledReply(): string {
  return "Dibatalkan. Tidak ada toko yang dibuat.";
}

export function buildExactDuplicateReply(existingStoreName: string): string {
  return `Toko dengan nama/nomor yang sama sudah terdaftar: "${existingStoreName}". Silakan gunakan toko yang sudah ada, atau hubungi admin bila ini memang toko berbeda.`;
}

export function buildSimilarDuplicateWarningPrompt(existingStoreName: string): string {
  return [
    `⚠️ Ditemukan toko yang mirip: "${existingStoreName}".`,
    "Apakah ini benar toko yang BERBEDA?",
    "",
    "Balas KONFIRMASI untuk tetap membuat toko baru ini, atau BATAL untuk membatalkan.",
  ].join("\n");
}

export function buildStoreCreatedReply(storeName: string, picName: string): string {
  return [
    `Toko "${storeName}" berhasil dibuat.`,
    `PIC "${picName}" tercatat dengan status UNVERIFIED — menunggu verifikasi admin/owner/manager.`,
  ].join("\n");
}

export function buildUnexpectedErrorReply(): string {
  return "Gagal memproses permintaan. Coba lagi atau hubungi admin.";
}

// ---------------------------------------------------------------------------
// Tambah PIC (PIC kedua dan seterusnya ke toko yang sudah ada).
// ---------------------------------------------------------------------------

export function buildAskStoreSearchPrompt(): string {
  return "Tambah PIC — ketik nama toko (atau sebagian nama) tempat PIC ini akan didaftarkan.";
}

export function buildStoreSearchNoResultsPrompt(): string {
  return "Toko tidak ditemukan pada daftar toko Anda. Coba nama lain, atau ketik BATAL.";
}

export function buildStoreSearchMultipleResultsPrompt(stores: readonly StoreSummary[]): string {
  const lines = stores.map((s, i) => `${i + 1}. ${s.name}`);
  return ["Ditemukan beberapa toko, pilih salah satu:", ...lines, "", `Balas dengan angka 1-${stores.length}.`].join("\n");
}

export function buildStoreFoundConfirmPrompt(storeName: string): string {
  return `Toko ditemukan: "${storeName}". Siapa nama PIC baru ini?`;
}

export function buildAddPicFinalConfirmationPrompt(storeName: string, draft: StorePicDraft): string {
  return [
    `Ringkasan PIC Baru — Toko "${storeName}":`,
    `Nama: ${draft.addPicName ?? "-"}`,
    `Telepon: ${draft.addPicPhone ?? "-"}`,
    `Email: ${draft.addPicEmail ?? "-"}`,
    `Peran: ${draft.addPicRoles ? rolesLabel(draft.addPicRoles) : "-"}`,
    "",
    "Balas KONFIRMASI untuk menyimpan, UBAH untuk mengulang isian, atau BATAL untuk membatalkan.",
  ].join("\n");
}

export function buildAddPicCreatedReply(storeName: string, picName: string): string {
  return `PIC "${picName}" berhasil ditambahkan ke toko "${storeName}" dengan status UNVERIFIED — menunggu verifikasi admin/owner/manager.`;
}

export function buildPhoneExistsOnStoreReply(): string {
  return "Nomor ini sudah terdaftar sebagai PIC pada toko ini sebelumnya. Tidak dibuat PIC baru -- gunakan PIC yang sudah ada, atau hubungi admin bila ini memang orang berbeda.";
}
