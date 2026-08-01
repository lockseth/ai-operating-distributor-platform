// Gate 3D-B3 — pure decision logic for public first-owner signup.
//
// Kontrak: docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
// (§5.A, §7a step 3). Fungsi di sini TIDAK PERNAH memanggil Supabase/network —
// hanya mengklasifikasi input/response yang sudah ada, supaya bisa diuji tanpa
// DB/browser (selaras CLAUDE.md dev rule 2: business logic di lib/ per modul).
//
// Server (RPC public.provision_first_owner, migration
// 20260907000001_gate_3d_b2_atomic_owner_provisioning_rpc.sql) adalah SATU-
// SATUNYA tempat company/profile/role benar-benar dibuat. File ini tidak
// pernah menyimpan/membaca role, company_id, atau privilege apa pun — hanya
// company_name/full_name/phone (data profil, bukan data otorisasi) yang selalu
// dikumpulkan ulang dari pengguna terautentikasi tepat sebelum RPC dipanggil,
// tidak pernah dibawa lewat user_metadata/localStorage melewati email
// confirmation (lihat catatan desain di signup-form.tsx).

export interface SignupFormInput {
  email: string;
  password: string;
  confirmPassword: string;
  companyName: string;
  fullName: string;
  phone: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateProfileFields(companyName: string, fullName: string, phone: string): string | null {
  const trimmedCompany = companyName.trim();
  const trimmedFullName = fullName.trim();
  const trimmedPhone = phone.trim();

  if (trimmedCompany.length < 2 || trimmedCompany.length > 255) {
    return "Nama perusahaan harus 2-255 karakter.";
  }
  if (trimmedFullName.length < 2 || trimmedFullName.length > 255) {
    return "Nama lengkap harus 2-255 karakter.";
  }
  if (trimmedPhone.length > 50) {
    return "Nomor telepon maksimal 50 karakter.";
  }
  return null;
}

/** Validasi UX client-side saja — server/RPC tetap satu-satunya sumber kebenaran. */
export function validateSignupInput(input: SignupFormInput): string | null {
  const email = input.email.trim();
  if (!email || !EMAIL_PATTERN.test(email)) {
    return "Email tidak valid.";
  }
  if (input.password.length < 8) {
    return "Password minimal 8 karakter.";
  }
  if (input.password !== input.confirmPassword) {
    return "Password dan konfirmasi password tidak cocok.";
  }
  return validateProfileFields(input.companyName, input.fullName, input.phone);
}

export interface ContinueOnboardingInput {
  companyName: string;
  fullName: string;
  phone: string;
}

/** Validasi untuk layar lanjutan (session sudah ada, tinggal profil tenant). */
export function validateContinueOnboardingInput(input: ContinueOnboardingInput): string | null {
  return validateProfileFields(input.companyName, input.fullName, input.phone);
}

export interface ProvisionRpcParams {
  p_company_name: string;
  p_full_name: string;
  p_phone: string | null;
}

/**
 * Bentuk SATU-SATUNYA payload RPC yang boleh dikirim — sengaja hanya tiga key
 * ini (cocok persis signature provision_first_owner). Tidak ada jalur untuk
 * menyelipkan role/company_id/user_id di sini secara struktural.
 */
export function buildProvisionRpcParams(input: ContinueOnboardingInput): ProvisionRpcParams {
  const phone = input.phone.trim();
  return {
    p_company_name: input.companyName.trim(),
    p_full_name: input.fullName.trim(),
    p_phone: phone.length > 0 ? phone : null,
  };
}

export interface SignUpLikeUser {
  identities?: unknown[] | null;
}

export interface SignUpLikeResponseData {
  user: SignUpLikeUser | null;
  session: unknown | null;
}

export interface SignUpLikeError {
  message: string;
}

export type SignUpOutcome =
  | { kind: "duplicate_email" }
  | { kind: "confirmation_required" }
  | { kind: "session_ready" }
  | { kind: "unexpected_error" };

/**
 * Mengklasifikasi respons supabase.auth.signUp() TANPA menebak apakah
 * "Confirm email" aktif di project hosted — keduanya ditangani eksplisit:
 *  - Confirm email OFF + email baru  -> data.session terisi -> session_ready.
 *  - Confirm email ON  + email baru  -> data.session null, identities berisi
 *    1 entri baru -> confirmation_required.
 *  - Confirm email ON  + email sudah terdaftar & confirmed -> Supabase
 *    mengembalikan fake user object (identities: []), TANPA error -> harus
 *    diperlakukan sebagai duplicate_email, bukan confirmation_required.
 *  - Confirm email OFF + email sudah terdaftar -> Supabase mengembalikan
 *    error message "User already registered" -> duplicate_email.
 * (Perilaku ini didokumentasikan resmi di @supabase/auth-js GoTrueClient.signUp).
 */
export function classifySignUpOutcome(
  error: SignUpLikeError | null,
  data: SignUpLikeResponseData | null
): SignUpOutcome {
  if (error) {
    if (/already registered/i.test(error.message)) {
      return { kind: "duplicate_email" };
    }
    return { kind: "unexpected_error" };
  }

  if (!data || !data.user) {
    return { kind: "unexpected_error" };
  }

  if (data.session) {
    return { kind: "session_ready" };
  }

  if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { kind: "duplicate_email" };
  }

  return { kind: "confirmation_required" };
}

export interface ProvisionRpcError {
  message: string;
}

export type ProvisionErrorOutcome =
  | { kind: "already_provisioned" }
  | { kind: "invalid_input" }
  | { kind: "unauthenticated" }
  | { kind: "unexpected_error" };

/** Mengklasifikasi error dari public.provision_first_owner() by message prefix (lihat migration). */
export function classifyProvisionError(error: ProvisionRpcError): ProvisionErrorOutcome {
  if (error.message.includes("AODP_ALREADY_PROVISIONED")) {
    return { kind: "already_provisioned" };
  }
  if (error.message.includes("AODP_INVALID_INPUT")) {
    return { kind: "invalid_input" };
  }
  if (error.message.includes("AODP_UNAUTHENTICATED")) {
    return { kind: "unauthenticated" };
  }
  return { kind: "unexpected_error" };
}
