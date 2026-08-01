// Gate 3D-B3 — unit tests untuk pure decision logic signup (lib/auth/signup.ts).
// Tidak butuh DB/browser -- murni fungsi in-memory, selaras pola test lain di
// bawah lib/ (mis. salesman/service.test.ts) yang tidak memerlukan Supabase.

import { describe, expect, it } from "vitest";
import {
  buildProvisionRpcParams,
  classifyProvisionError,
  classifySignUpOutcome,
  validateContinueOnboardingInput,
  validateSignupInput,
} from "./signup";

const validSignup = {
  email: "owner@perusahaan.test",
  password: "password123",
  confirmPassword: "password123",
  companyName: "PT Sumber Warna Alam",
  fullName: "Budi Owner",
  phone: "0812-3456-7890",
};

describe("validateSignupInput", () => {
  it("menerima input valid", () => {
    expect(validateSignupInput(validSignup)).toBeNull();
  });

  it("menolak email invalid", () => {
    expect(validateSignupInput({ ...validSignup, email: "bukan-email" })).toMatch(/email/i);
  });

  it("menolak password < 8 karakter", () => {
    expect(validateSignupInput({ ...validSignup, password: "short1", confirmPassword: "short1" })).toMatch(
      /password/i
    );
  });

  it("menolak password mismatch (obligasi test #4)", () => {
    expect(
      validateSignupInput({ ...validSignup, password: "password123", confirmPassword: "password456" })
    ).toMatch(/cocok/i);
  });

  it("menolak nama perusahaan kosong", () => {
    expect(validateSignupInput({ ...validSignup, companyName: " " })).toMatch(/perusahaan/i);
  });

  it("menolak nama lengkap kosong", () => {
    expect(validateSignupInput({ ...validSignup, fullName: " " })).toMatch(/lengkap/i);
  });

  it("menolak nomor telepon terlalu panjang", () => {
    expect(validateSignupInput({ ...validSignup, phone: "0".repeat(51) })).toMatch(/telepon/i);
  });

  it("menerima telepon kosong (opsional)", () => {
    expect(validateSignupInput({ ...validSignup, phone: "" })).toBeNull();
  });
});

describe("validateContinueOnboardingInput", () => {
  it("menerima input valid tanpa field auth", () => {
    expect(
      validateContinueOnboardingInput({ companyName: "PT Valid", fullName: "Nama Lengkap", phone: "" })
    ).toBeNull();
  });

  it("menolak nama perusahaan kosong di layar lanjutan", () => {
    expect(
      validateContinueOnboardingInput({ companyName: "", fullName: "Nama Lengkap", phone: "" })
    ).toMatch(/perusahaan/i);
  });
});

describe("buildProvisionRpcParams", () => {
  it("hanya menghasilkan p_company_name/p_full_name/p_phone -- tidak ada jalur untuk role/company_id/user_id", () => {
    const params = buildProvisionRpcParams({
      companyName: "  PT Trim Spasi  ",
      fullName: "  Nama Trim  ",
      phone: "  0812  ",
    });
    expect(params).toEqual({
      p_company_name: "PT Trim Spasi",
      p_full_name: "Nama Trim",
      p_phone: "0812",
    });
    expect(Object.keys(params).sort()).toEqual(["p_company_name", "p_full_name", "p_phone"]);
  });

  it("phone kosong -> null (bukan string kosong) supaya cocok DEFAULT NULL di RPC", () => {
    const params = buildProvisionRpcParams({ companyName: "PT X", fullName: "Nama", phone: "   " });
    expect(params.p_phone).toBeNull();
  });
});

describe("classifySignUpOutcome (obligasi test #6, #7, #5)", () => {
  it("error 'User already registered' -> duplicate_email (confirm-email OFF, email lama)", () => {
    expect(classifySignUpOutcome({ message: "User already registered" }, null)).toEqual({
      kind: "duplicate_email",
    });
  });

  it("error lain -> unexpected_error, bukan duplicate_email", () => {
    expect(classifySignUpOutcome({ message: "Network error" }, null)).toEqual({
      kind: "unexpected_error",
    });
  });

  it("tidak ada error, session terisi -> session_ready (confirm-email OFF, email baru) (#6)", () => {
    expect(
      classifySignUpOutcome(null, {
        user: { identities: [{ id: "x" }] },
        session: { access_token: "t" },
      })
    ).toEqual({ kind: "session_ready" });
  });

  it("tidak ada error, session null, identities 1 entri baru -> confirmation_required (#7)", () => {
    expect(
      classifySignUpOutcome(null, {
        user: { identities: [{ id: "x" }] },
        session: null,
      })
    ).toEqual({ kind: "confirmation_required" });
  });

  it("tidak ada error, session null, identities=[] (fake user Supabase) -> duplicate_email, BUKAN confirmation_required", () => {
    expect(
      classifySignUpOutcome(null, {
        user: { identities: [] },
        session: null,
      })
    ).toEqual({ kind: "duplicate_email" });
  });

  it("tidak ada user sama sekali -> unexpected_error (fail-safe, tidak pernah dianggap sukses)", () => {
    expect(classifySignUpOutcome(null, { user: null, session: null })).toEqual({
      kind: "unexpected_error",
    });
    expect(classifySignUpOutcome(null, null)).toEqual({ kind: "unexpected_error" });
  });
});

describe("classifyProvisionError (obligasi test #9, #11)", () => {
  it("AODP_ALREADY_PROVISIONED -> already_provisioned (retry tidak membuat tenant kedua, #11)", () => {
    expect(
      classifyProvisionError({ message: "AODP_ALREADY_PROVISIONED: caller already has a tenant membership" })
    ).toEqual({ kind: "already_provisioned" });
  });

  it("AODP_INVALID_INPUT -> invalid_input", () => {
    expect(classifyProvisionError({ message: "AODP_INVALID_INPUT: company name must be..." })).toEqual({
      kind: "invalid_input",
    });
  });

  it("AODP_UNAUTHENTICATED -> unauthenticated", () => {
    expect(classifyProvisionError({ message: "AODP_UNAUTHENTICATED: caller must be authenticated" })).toEqual({
      kind: "unauthenticated",
    });
  });

  it("error tak dikenal -> unexpected_error (retry aman, bukan crash)", () => {
    expect(classifyProvisionError({ message: "connection reset" })).toEqual({ kind: "unexpected_error" });
  });
});
