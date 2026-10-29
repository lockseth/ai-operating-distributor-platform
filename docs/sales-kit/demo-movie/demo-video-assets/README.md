# Demo Video Assets — Manifest

Aset visual pendukung untuk AODP Product Demo Movie (90 detik). Dibuat
mengikuti `../Storyboard.md` dan `../Script.md`.

## Isi Folder

| File | Scene | Sifat | Catatan |
|---|---|---|---|
| `00_style-key.png` | Referensi gaya | AI-generated | Mood board warna/cahaya — acuan grading untuk semua scene |
| `scene1_opening-warehouse.png` | 1 — Opening Problem | AI-generated | Cinematic B-roll, siap pakai langsung |
| `scene3_customer-health-concept.png` | 3 — Customer Health AI | AI-generated concept | 🟡 Vision — bukan tiruan UI produk |
| `scene5_business-guard-concept.png` | 5 — Business Guard AI | AI-generated concept | 🟡 Vision — hero module |
| `scene6_collection-concept.png` | 6 — Collection Intelligence | AI-generated concept | 🟡 Vision |
| `scene8_closing-background.png` | 8 — Closing Logo | AI-generated | Plate kosong — wordmark & tagline ditambahkan di post |

Semua gambar 1376×768 (16:9), model `nano_banana_2`, di-generate via MCP
Higgsfield dan diunduh ke folder ini (bukan tautan eksternal yang bisa kedaluwarsa).

## Yang BELUM ada di folder ini (butuh langkah manual)

### Scene 2 — Executive Intelligence (🟢 LIVE) & sebagian Scene 4 — Laporan Sales (🟢 LIVE)

Ini **wajib screen-capture asli dari aplikasi**, bukan AI-generated — inilah
justru scene yang paling penting karena membuktikan produk sungguh berjalan.
Cara reproduksi:

1. Pastikan Supabase lokal aktif (`supabase start`) — tanpa ini halaman hanya
   menampilkan skeleton loading, bukan data (sudah diverifikasi saat produksi
   dokumen ini: dengan Docker mati, halaman tetap tidak crash tapi juga belum
   terisi data — cukup untuk auth demo, tidak cukup untuk syuting).
2. `pnpm --filter @flowsales/web dev`
3. Buka `/login` → klik **"Masuk Demo (Development Only)"** (bypass dev-only,
   lihat `apps/web/src/lib/demo/`) — atau login manual dengan akun seed
   (`owner@aodp.test`).
4. Screen-record halaman `/dashboard/owner` (Executive Intelligence) dan
   `/dashboard/reports` (Laporan Sales) — idealnya dengan `pnpm seed:dev` sudah
   dijalankan supaya datanya lebih kaya dari sekadar company kosong.
5. Untuk video final, ganti data seed dengan angka yang selaras `demo-data.json`
   di folder ini (Distribusi Makmur Jaya) supaya konsisten dengan seluruh video —
   **atau** biarkan data seed asli dan sesuaikan VoiceOver/Subtitle ke angka
   tersebut. Jangan mencampur dua sumber angka yang berbeda di video final.

### Scene 7 — Executive WhatsApp Report mockup

Ilustrasi notifikasi WhatsApp bergaya bersih (bukan screenshot literal aplikasi
WhatsApp, untuk menghindari peniruan merek pihak ketiga) — belum di-generate.
Bisa dibuat oleh desainer motion graphic langsung di software compositing
(After Effects/Figma), memakai teks dari `demo-data.json` →
`scene7_whatsapp_report.message_preview`.

### Motion graphics & tipografi on-screen

Semua badge **"Visi Kami — Segera Hadir"**, animasi count-up angka, dan
wordmark closing (Scene 8) **belum di-render sebagai video/motion** — file di
folder ini adalah still image/plate. Assembly video (transisi, motion graphic,
burn-in teks, sinkronisasi dengan `VoiceOver_ID.md`/`Subtitle.srt`) adalah
pekerjaan compositing yang memerlukan software video editing (After Effects,
Premiere, DaVinci Resolve) — di luar kemampuan tool generatif yang dipakai
untuk membuat still image di atas.

## Kenapa tidak semua scene di-generate sebagai video penuh?

`generate_video` tersedia dan bisa dipakai untuk B-roll (mis. Scene 1), tapi
untuk motion graphic presisi (grafik naik-turun, badge muncul di waktu
tertentu, sinkron ke VO per detik) hasil AI-video generatif sulit dikontrol
presisinya dibanding compositing manual dengan still image di atas sebagai
key frame. Still image + arahan motion di `Script.md` memberi tim
editor/motion designer kendali penuh atas timing — lebih andal untuk kualitas
"CEO presentation" yang diminta.
