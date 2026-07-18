import type { InlineKeyboardButton } from "@/lib/telegram/client";
import { buildMenuCallbackData } from "./conversation";

export interface MainMenuItem {
  number: number;
  action: string;
  label: string;
}

// Urutan & label sesuai Waluyo Daily Operating Loop bagian C (Menu Utama).
export const MAIN_MENU_ITEMS: MainMenuItem[] = [
  { number: 1, action: "start_day", label: "Mulai Hari" },
  { number: 2, action: "agenda", label: "Agenda Hari Ini" },
  { number: 3, action: "start_visit", label: "Mulai Kunjungan" },
  { number: 4, action: "order_intake", label: "Input Order WA/Telepon" },
  { number: 5, action: "deliveries", label: "Pengiriman Hari Ini" },
  { number: 6, action: "add_store", label: "Tambah Toko" },
  { number: 7, action: "progress", label: "Target & Pencapaian" },
  { number: 8, action: "close_day", label: "Tutup Hari" },
  { number: 9, action: "report_problem", label: "Laporkan Masalah" },
];

export function buildMainMenuText(): string {
  const lines = ["Menu Utama:"];
  for (const item of MAIN_MENU_ITEMS) lines.push(`${item.number}. ${item.label}`);
  lines.push("");
  lines.push("Balas dengan nomor menu, atau ketuk tombol di bawah.");
  return lines.join("\n");
}

export function buildMainMenuKeyboard(): InlineKeyboardButton[][] {
  return MAIN_MENU_ITEMS.map((item) => [
    { text: `${item.number}. ${item.label}`, callbackData: buildMenuCallbackData(item.action) },
  ]);
}

export function resolveMenuAction(input: {
  numberedChoice: number | null;
  callbackAction: string | null;
}): string | null {
  if (input.callbackAction) return input.callbackAction;
  if (input.numberedChoice !== null) {
    const item = MAIN_MENU_ITEMS.find((i) => i.number === input.numberedChoice);
    return item?.action ?? null;
  }
  return null;
}
