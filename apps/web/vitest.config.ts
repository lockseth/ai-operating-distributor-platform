import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Banyak *.integration.test.ts di repo ini adalah DB-backed (Postgres
    // lokal sungguhan lewat PostgREST, bukan mock) -- PostgREST lokal TIDAK
    // mengkonfigurasi PGRST_DB_POOL eksplisit (dikonfirmasi lewat `docker
    // inspect supabase_rest_AODP`), jadi memakai pool koneksi default-nya.
    // Default vitest men-fork worker sebanyak core CPU (28 di mesin dev ini)
    // -- jauh melebihi pool itu begitu banyak file integration test DB-backed
    // kebetulan berjalan bersamaan, menyebabkan request PostgREST intermiten
    // gagal ("upstream server" / null read) yang TIDAK terkait kode/bug
    // bisnis apa pun. Dibuktikan bertahap: gagal acak di 28 worker default,
    // MASIH gagal sesekali di maxForks=4 dan maxForks=2 (beberapa test file
    // sendiri memanggil beberapa RPC concurrent lewat Promise.all untuk
    // menguji concurrency-safety di level DB, mengalikan jumlah koneksi
    // efektif per file), dan HANYA 100% stabil (5x run berturut-turut,
    // 1683/1683) di maxForks=1 -- file test berjalan serial, tanpa
    // menyentuh/melemahkan test concurrency di dalam satu file. Durasi
    // tetap wajar (~50-58 detik untuk seluruh suite).
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@flowsales/ai": path.resolve(__dirname, "../../packages/ai/src/index.ts"),
      "@flowsales/database": path.resolve(__dirname, "../../packages/database/src/index.ts"),
      "@flowsales/types": path.resolve(__dirname, "../../packages/types/src/index.ts"),
    },
  },
});
