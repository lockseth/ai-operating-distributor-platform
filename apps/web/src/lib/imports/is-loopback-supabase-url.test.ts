import { describe, it, expect } from "vitest";
import { isLoopbackSupabaseUrl } from "./is-loopback-supabase-url";

describe("isLoopbackSupabaseUrl -- safety guard, mencegah DB integration test menyasar cloud/demo/production", () => {
  it("URL loopback sah -> true", () => {
    expect(isLoopbackSupabaseUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackSupabaseUrl("http://localhost:54321")).toBe(true);
    expect(isLoopbackSupabaseUrl("http://[::1]:54321")).toBe(true);
    expect(isLoopbackSupabaseUrl("http://[::1]")).toBe(true);
  });

  it("hostname cloud sungguhan -> false", () => {
    expect(isLoopbackSupabaseUrl("https://project.supabase.co")).toBe(false);
  });

  it("subdomain yang MENGANDUNG kata 'localhost'/'127.0.0.1' tapi BUKAN host loopback -> false (bukti .hostname, bukan substring match)", () => {
    expect(isLoopbackSupabaseUrl("http://localhost.example.com")).toBe(false);
    expect(isLoopbackSupabaseUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackSupabaseUrl("http://localhost.evil.test")).toBe(false);
  });

  it("userinfo trick -- 'localhost' sebagai username, host sungguhan domain lain -> false", () => {
    expect(isLoopbackSupabaseUrl("http://localhost@evil.example.com")).toBe(false);
  });

  it("string kosong/invalid -> false, tidak pernah throw", () => {
    expect(isLoopbackSupabaseUrl("")).toBe(false);
    expect(isLoopbackSupabaseUrl("not a url")).toBe(false);
    expect(isLoopbackSupabaseUrl("   ")).toBe(false);
  });
});
