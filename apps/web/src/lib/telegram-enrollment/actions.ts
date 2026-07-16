"use server";

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import {
  buildEnrollmentCommand,
  buildEnrollmentDeepLink,
  generateEnrollmentToken,
  hashEnrollmentToken,
  TELEGRAM_ENROLLMENT_TTL_MINUTES,
} from "./token";

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TelegramEnrollmentActionResult {
  ok: boolean;
  error?: string;
  enrollment?: {
    command: string;
    deepLink: string | null;
    expiresAt: string;
  };
}

function canManageTelegram(user: {
  roles: string[];
  permissions: string[];
}): boolean {
  return (
    hasPermission(user.permissions, "telegram.manage") ||
    MANAGE_ROLES.some((role) => user.roles.includes(role))
  );
}

export async function createTelegramEnrollmentAction(
  salesmanId: string,
): Promise<TelegramEnrollmentActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Enrollment tidak tersedia pada sesi demo." };
  }
  if (!canManageTelegram(user)) {
    return { ok: false, error: "Tidak berwenang mengelola Telegram Salesman." };
  }
  if (!UUID_PATTERN.test(salesmanId)) {
    return { ok: false, error: "Salesman tidak valid." };
  }

  const rawToken = generateEnrollmentToken();
  const expiresAt = new Date(
    Date.now() + TELEGRAM_ENROLLMENT_TTL_MINUTES * 60_000,
  );
  const supabase = getAdminClient();

  try {
    const { data, error } = await supabase.rpc(
      "issue_telegram_salesman_enrollment",
      {
        p_company_id: user.company_id,
        p_user_id: salesmanId,
        p_token_hash: hashEnrollmentToken(rawToken),
        p_expires_at: expiresAt.toISOString(),
        p_created_by: user.id,
      },
    );

    if (error) {
      console.error("[Telegram Enrollment] issue RPC failed", error.code);
      return { ok: false, error: "Gagal membuat kode Telegram. Coba kembali." };
    }

    const row = (
      (data ?? []) as {
        result_outcome: string;
        enrollment_token_id: string | null;
      }[]
    )[0];

    if (row?.result_outcome === "already_linked") {
      return {
        ok: false,
        error:
          "Salesman sudah terhubung ke Telegram. Putuskan koneksi lama terlebih dahulu.",
      };
    }
    if (row?.result_outcome === "not_eligible") {
      return {
        ok: false,
        error: "Target harus merupakan Salesman aktif di perusahaan ini.",
      };
    }
    if (row?.result_outcome !== "issued" || !row.enrollment_token_id) {
      return { ok: false, error: "Kode Telegram tidak dapat dibuat." };
    }

    revalidatePath("/dashboard/users");
    return {
      ok: true,
      enrollment: {
        command: buildEnrollmentCommand(rawToken),
        deepLink: buildEnrollmentDeepLink(
          process.env.TELEGRAM_BOT_USERNAME,
          rawToken,
        ),
        expiresAt: expiresAt.toISOString(),
      },
    };
  } catch {
    return { ok: false, error: "Gagal membuat kode Telegram. Coba kembali." };
  }
}

export async function disconnectTelegramIdentityAction(
  salesmanId: string,
): Promise<TelegramEnrollmentActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Perubahan tidak tersedia pada sesi demo." };
  }
  if (!canManageTelegram(user)) {
    return { ok: false, error: "Tidak berwenang mengelola Telegram Salesman." };
  }
  if (!UUID_PATTERN.test(salesmanId)) {
    return { ok: false, error: "Salesman tidak valid." };
  }

  const supabase = getAdminClient();
  try {
    const { data, error } = await supabase.rpc(
      "revoke_telegram_salesman_identity",
      {
        p_company_id: user.company_id,
        p_user_id: salesmanId,
        p_revoked_by: user.id,
      },
    );

    if (error) {
      console.error("[Telegram Enrollment] revoke RPC failed", error.code);
      return {
        ok: false,
        error: "Gagal memutuskan koneksi Telegram. Coba kembali.",
      };
    }

    const row = (
      (data ?? []) as {
        result_outcome: string;
        telegram_identity_id: string | null;
      }[]
    )[0];

    if (row?.result_outcome === "not_found") {
      return { ok: false, error: "Koneksi Telegram aktif tidak ditemukan." };
    }
    if (row?.result_outcome !== "revoked") {
      return {
        ok: false,
        error: "Koneksi Telegram tidak dapat diputuskan.",
      };
    }

    revalidatePath("/dashboard/users");
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Gagal memutuskan koneksi Telegram. Coba kembali.",
    };
  }
}
