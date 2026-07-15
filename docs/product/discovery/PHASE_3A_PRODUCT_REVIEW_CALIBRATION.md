# 🎯 Phase 3A Product Review — Kalibrasi Customer Health & Collection

| Field | Value |
|---|---|
| Dokumen | Business Interview Guide + Calibration Matrix |
| Fase | Phase 3A Product Review — bersama Design Partner |
| Narasumber | Pak Waluyo (Waluyo Distributor — L11) |
| Acuan | Product Constitution v1.2 · Discovery Phase 3A · AODP Waluyo Living Knowledge Pack v1.0 |
| Output | Business rules terkalibrasi untuk Phase 3B |
| Sifat | Business calibration — tanpa coding/schema/UI |
| **Status Discovery** | **COMPLETE** — ditetapkan Founder, 15 Juli 2026 (lihat §0) |

> Cara pakai (riwayat asli): bagian 1 dibawa ke pertemuan (pertanyaan bergaya
> obrolan sesama pemilik usaha, bukan interogasi analis). Jawaban seharusnya
> dicatat langsung ke kolom **Jawaban Pak Waluyo** di Calibration Matrix
> (bagian 2). Setelah pertemuan, Business Rules Draft (bagian 3) difinalkan
> dan menjadi kontrak Phase 3B.
>
> **Update 16 Juli 2026 (lihat §0):** discovery/wawancara dengan Pak Waluyo
> telah selesai dan ditetapkan Founder sebagai COMPLETE. Transkrip jawaban
> mentah per pertanyaan **tidak tersimpan di repository ini** — sumber
> kanonik hasil discovery adalah `AODP_WALUYO_LIVING_KNOWLEDGE_PACK_v1.0.md`
> (`docs/knowledge/packs/waluyo/`), yang berisi temuan yang sudah disintesis
> dan dikunci (WK-01–WK-12 + decision rules DV/BG/CH/DC). §2 di bawah
> memetakan setiap kode K-xx dari Interview Guide ini ke temuan pack
> tersebut. Kolom "Jawaban Pak Waluyo" yang lama diganti kolom **Status
> Kalibrasi & Mapping** — sesuai instruksi eksplisit untuk tidak mengarang
> jawaban/threshold yang tidak benar-benar tercatat di pack.

---

## 0. Status Kalibrasi — Update 16 Juli 2026

**Sumber:** `AODP_LIVING_KNOWLEDGE_AUDIT_CORRECTED_2026-07-15.md` (`docs/audits/`)
dan `AODP_WALUYO_LIVING_KNOWLEDGE_PACK_v1.0.md` (`docs/knowledge/packs/waluyo/`).

- **Discovery Waluyo: COMPLETE** — ditetapkan Founder. Audit sebelumnya yang
  menyimpulkan "wawancara belum terjadi" dari kolom Calibration Matrix yang
  kosong adalah **documentation synchronization gap**, bukan **missing
  discovery** — matrix di repo ini memang belum pernah disinkronkan dengan
  hasil discovery yang sesungguhnya sampai pembaruan ini.
- **Taksonomi berbeda, bukan pengganti satu sama lain:** K-01–K-31 (Interview
  Guide ini, fokus Customer Health & Collection) dan WK-01–WK-12 + DV/BG/CH/DC
  (Knowledge Pack v1.0, mencakup juga Delivery Verification & Business Guard
  yang tidak ada dalam interview guide asli) memakai cakupan yang tidak
  identik. §2 memetakan overlap-nya secara eksplisit — bukan mengklaim 1:1.
- **Provenance tag** (mengikuti Quality Rule audit terkoreksi §9) dipakai di
  §2: `LOCKED` (temuan eksplisit ada di Knowledge Pack v1.0),
  `NEEDS_PILOT_CALIBRATION` (dimensi/sinyalnya diakui pack, tapi angka/ambang
  pasti secara eksplisit didelegasikan ke data pilot — lihat Pack §10),
  `NOT_OBSERVED` (parameter ini tidak disinggung sama sekali oleh Pack v1.0).
- **Tidak ada angka yang dikarang.** Bila status `NEEDS_PILOT_CALIBRATION`
  atau `NOT_OBSERVED`, nilai `Default v1` pada kolom lama **tetap berupa
  asumsi/proposal Discovery 3A — bukan hasil kalibrasi** — dan tidak boleh
  diperlakukan sebagai locked.

---

## 1. Business Interview Guide

**Cara membawakan:** ini obrolan pengalaman, bukan kuesioner. Mulai dari cerita
("Pak, cerita dong waktu itu…"), bukan dari definisi. Satu sesi ±90 menit, urutan
domain boleh mengalir mengikuti cerita beliau. Setiap pertanyaan di bawah punya
tujuan kalibrasi — kode `[K-xx]` menunjuk baris di Calibration Matrix.

### Domain 1 — Customer DNA
*Memahami seperti apa "wajah normal" customer di mata Pak Waluyo.*

1. Pak, kalau Bapak ingat-ingat customer yang dulunya bagus terus akhirnya bermasalah —
   **kapan pertama kali Bapak merasa dia mulai berubah?** Apa yang Bapak lihat waktu itu? `[K-01]`
2. **Tanda pertama** yang biasanya muncul itu apa — ordernya yang berubah, bayarnya,
   atau orangnya? `[K-01]`
3. Waktu **PIC yang biasa order berganti** (misal dari suami ke istri, atau ke anak
   buahnya) — apakah itu selalu pertanda buruk, atau kadang wajar saja? Kapan wajar,
   kapan bahaya? `[K-07]`
4. Kalau tiba-tiba yang menghubungi **pakai nomor WhatsApp baru**, apa yang Bapak
   lakukan? Pernah kejadian itu ternyata awal masalah? `[K-08]`
5. Kalau customer yang biasa ambil produk A tiba-tiba **ganti komposisi ordernya**
   (berhenti ambil produk tertentu, atau pindah ke yang murah saja) — itu sinyal
   apa buat Bapak? `[K-09]`
6. Menurut pengalaman Bapak, **berapa lama customer "diam" (tidak order) yang masih
   normal** untuk toko kecil? Untuk yang besar? `[K-02]`
7. Ada tidak customer yang **musiman** — diam lama itu biasa (misal jelang panen,
   puasa)? Bagaimana Bapak membedakan diam musiman dengan diam berbahaya? `[K-03]`

### Domain 2 — Customer Health
*Menentukan batas Aman / Perhatian / Risiko Tinggi versi Waluyo.*

8. Buat Bapak, **customer yang benar-benar sehat itu seperti apa** perilakunya —
   order dan bayarnya? `[K-04]`
9. Kapan Bapak mulai bilang dalam hati *"toko ini mulai batuk-batuk"*? Apa yang
   membuat Bapak bilang begitu? `[K-05]`
10. Kapan Bapak menganggap customer **sudah bahaya** dan harus disikapi serius? `[K-06]`
11. Dari semua tanda-tanda tadi, **indikator mana yang paling Bapak percaya** —
    yang kalau muncul, hampir pasti ada masalah? Dan indikator mana yang sering
    menipu (kelihatan buruk padahal tidak apa-apa)? `[K-10]`
12. Kalau sistem nanti memberi label ke customer Bapak — **Aman / Perhatian /
    Risiko Tinggi** — kira-kira dari 100 customer Bapak sekarang, berapa yang
    masuk masing-masing? *(sanity check ambang — hasil sistem harus mendekati
    intuisi ini)* `[K-11]`

### Domain 3 — Collection
*Kalibrasi tempo, aging, prioritas, dan eskalasi.*

13. **Tempo bayar** yang Bapak kasih biasanya berapa hari? Sama semua atau beda-beda
    — siapa yang dapat lebih panjang, siapa yang harus cash? `[K-12]`
14. Setelah lewat jatuh tempo, **hari ke berapa mulai ditagih**? Ditagihnya lewat
    apa dulu — WA, telepon, atau datang? `[K-13]`
15. Buat Bapak, nota **dianggap macet** itu setelah berapa lama? Apa yang Bapak
    lakukan kalau sudah sampai situ? `[K-14]`
16. Kalau pagi ini ada 20 toko yang nunggak, **bagaimana Bapak memutuskan siapa yang
    ditagih duluan** — yang paling besar nilainya, paling lama, atau yang gelagatnya
    paling mencurigakan? `[K-15]`
17. Customer **janji bayar tapi tidak menepati** — berapa kali janji bolos yang masih
    Bapak toleransi? Setelah itu apa: berhenti kirim barang, datangi, atau bagaimana? `[K-16]`
18. Apakah Bapak pernah **menahan pengiriman** karena tunggakan? Batasnya apa —
    nilai nunggak, umur nota, atau perasaan? `[K-17]`
19. Kalau customer **bayar sebagian** (cicil nota), itu Bapak anggap itikad baik atau
    tanda bahaya? Cicilan dipotong ke nota yang mana dulu? `[K-18]`
20. Ada praktik **tukar faktur / tanda terima** dulu sebelum bisa tagih? Bagaimana
    alurnya di tempat Bapak? `[K-19]`
21. Boleh tidak sistem **mengirim pengingat WA otomatis** ke customer menjelang jatuh
    tempo — atau semua pesan harus lewat orang Bapak dulu supaya tidak merusak
    hubungan? `[K-20]` *(menjawab OD-3A-4)*

### Domain 4 — Relationship
*Memahami sisi manusia yang tidak terlihat di angka.*

22. Di toko-toko langganan Bapak, **siapa yang biasanya order dan siapa yang pegang
    uang** — orang yang sama atau beda? `[K-21]`
23. Seberapa sering kejadian **orangnya ganti** — dan biasanya karena apa (pemilik
    sakit, anak ambil alih, karyawan keluar)? `[K-07]`
24. Seberapa besar **hubungan personal** memengaruhi keputusan Bapak kasih tempo —
    ada customer yang "tidak enak ditagih keras" karena kenal lama? Bagaimana
    sebaiknya sistem memperlakukan customer seperti itu? `[K-22]`
25. Pernah ada kejadian **customer main mata dengan orang dalam** (sales/pengantar)
    sehingga tagihannya kabur? Apa pelajarannya? `[K-23]`

### Domain 5 — Sales Behavior
*Peran sales dalam sinyal dan penagihan.*

26. Kalau ada perubahan di toko (PIC ganti, toko sepi, mau tutup) — **apakah sales
    Bapak wajib melapor?** Selama ini mereka lapor lewat apa? `[K-24]`
27. Di tempat Bapak, **apakah sales ikut menagih** di area-nya, atau penagihan
    dipegang orang khusus? Siapa yang lebih efektif? `[K-25]` *(menjawab OD-3A-1)*
28. **Kapan Bapak mulai curiga ke sales sendiri** — tanda apa yang biasanya muncul
    duluan? (setoran telat, nota aneh, diskon melebar, customer komplain tidak
    pernah dikunjungi?) `[K-26]`
29. Kalau sales tahu customer-nya mau macet, menurut Bapak dia cenderung **cepat
    lapor atau malah menutupi** (karena takut targetnya kena)? Bagaimana supaya
    dia mau jujur? `[K-27]`

### Domain 6 — Executive Decision
*Kalibrasi command center: apa yang harus sampai ke Pak Waluyo.*

30. Setiap pagi, **3 hal apa yang paling ingin Bapak tahu** tentang bisnis sebelum
    mulai aktivitas? `[K-28]`
31. Kejadian seperti apa yang membuat Bapak merasa **harus turun tangan sendiri** —
    dan mana yang cukup diserahkan ke sales atau penagih? `[K-29]`
32. Bapak lebih suka dikabari **lewat apa dan jam berapa** — WA pagi hari, atau buka
    dashboard sendiri? Seberapa sering: harian, atau hanya kalau ada bahaya? `[K-30]`
33. Kalau sistem hanya boleh mengirim **satu kalimat** ke Bapak tiap pagi, kalimat
    seperti apa yang paling berguna? `[K-28]`
34. Sebaliknya — notifikasi seperti apa yang **mengganggu** dan bikin Bapak lama-lama
    mengabaikan sistem? `[K-31]`

---

## 2. Calibration Matrix — dipetakan ke Knowledge Pack v1.0

Kolom **Default v1** = proposal asli Discovery 3A (sebelum discovery selesai) —
**dipertahankan sebagai referensi historis, bukan hasil kalibrasi**. Kolom
**Status & Mapping** adalah pemetaan jujur terhadap
`AODP_WALUYO_LIVING_KNOWLEDGE_PACK_v1.0.md`: `LOCKED` berarti Pack v1.0 secara
eksplisit menjawab parameter ini (dikutip ID temuan/rule-nya); `NEEDS_PILOT_CALIBRATION`
berarti dimensi/sinyalnya diakui pack tapi angka pastinya didelegasikan ke data
pilot (lihat Pack §10); `NOT_OBSERVED` berarti Pack v1.0 tidak menyinggung
parameter ini sama sekali.

| Kode | Parameter | Default v1 (historis) | Status & Mapping | Catatan |
|---|---|---|---|---|
| K-01 | Sinyal perubahan paling awal (urutan kepercayaan) | order melambat → bayar melambat → PIC ganti | `NEEDS_PILOT_CALIBRATION` — terkait WK-02, WK-04, WK-05 | Ketiga sinyal individual dikonfirmasi ada di Pack; urutan/prioritas kepercayaan antar-sinyal tidak dinyatakan |
| K-02 | Ambang "order melambat" | >1,5× median interval order customer itu | `NEEDS_PILOT_CALIBRATION` — terkait WK-02, CH-01 | CH-01: "Ambang persentase dan periode observasi harus dikalibrasi per tenant" — eksplisit belum dikunci |
| K-03 | Perlakuan customer musiman | belum ada — dicatat manual | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |
| K-04 | Definisi Aman | order sesuai ritme & bayar ≤ tempo | `NEEDS_PILOT_CALIBRATION` — terkait §6 (4 dimensi Customer Health) | Pack §6: "Belum ada bobot atau threshold universal yang dikunci" untuk kombinasi label |
| K-05 | Definisi Perhatian ("batuk") | ≥1 sinyal deviasi bermakna | `NEEDS_PILOT_CALIBRATION` — terkait §6 | Sama seperti K-04 |
| K-06 | Definisi Risiko Tinggi | sinyal ganda / janji dilanggar / over-limit | `NEEDS_PILOT_CALIBRATION` — terkait §6 | Sama seperti K-04 |
| K-07 | Bobot sinyal PIC berganti | sinyal Perhatian (bukan otomatis Risiko) | `LOCKED` (kualitatif) — WK-04, DV-05, CH-02; bobot numerik `NEEDS_PILOT_CALIBRATION` | DV-05: "tidak otomatis memblokir transaksi; dapat menaikkan kebutuhan verifikasi atau memicu alert bila digabung dengan sinyal lain" — arah default lama terkonfirmasi kualitatif, bobot skor pasti belum ada |
| K-08 | Bobot sinyal nomor WA baru | sinyal Perhatian | `LOCKED` (kualitatif) — WK-04; bobot numerik `NEEDS_PILOT_CALIBRATION` | WK-04 eksplisit menyebut "perubahan nomor WhatsApp" sebagai sinyal |
| K-09 | Bobot perubahan komposisi produk | belum dihitung v1 (kandidat CI-1) | `LOCKED` (kualitatif, upgrade dari kandidat) — §6 Order Health; bobot numerik `NEEDS_PILOT_CALIBRATION` | Pack §6 kini eksplisit memasukkan "perubahan mix produk" ke dimensi Order Health — CI-1 (§8 lama) naik status dari kandidat menjadi sinyal locked |
| K-10 | Indikator paling dipercaya (bobot tertinggi skor) | perilaku bayar | `NEEDS_PILOT_CALIBRATION` — terkait §6 | 4 dimensi (Order/Payment/Relationship/Exposure) disebut setara tanpa ranking bobot |
| K-11 | Distribusi label yang masuk akal | — (sanity check) | `NOT_OBSERVED` | Tidak ada data distribusi di Pack v1.0 |
| K-12 | Tempo standar & variasinya | 30 hari, seragam | `LOCKED` — WK-03 | **Koreksi nilai default:** WK-03 = "tempo pembayaran ... sekitar dua minggu" (~14 hari), eksplisit sebagai baseline tenant Waluyo — "bukan konstanta universal platform". Menggantikan default lama "30 hari, seragam" |
| K-13 | Mulai menagih setelah jatuh tempo | H+3 | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |
| K-14 | Definisi "macet" | >90 hari atau 3× janji bolos | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |
| K-15 | Urutan prioritas penagihan | nilai × umur × health × janji bolos | `NEEDS_PILOT_CALIBRATION` — terkait §4.4 | §4.4 menyebut faktor Collection (invoice, jatuh tempo, pembayaran terverifikasi, janji bayar, keterlambatan) secara umum, tanpa formula/urutan pasti |
| K-16 | Toleransi janji bolos sebelum eskalasi | 1× | `NEEDS_PILOT_CALIBRATION` — Pack §10 | §10 eksplisit mendaftar "toleransi keterlambatan dan payment mismatch" sebagai item v1.1 |
| K-17 | Aturan tahan pengiriman | rekomendasi saat Risiko Tinggi, owner memutuskan | `NOT_OBSERVED` | Pack membahas rekonsiliasi delivery (DV-*), bukan kebijakan menahan pengiriman baru karena piutang lama — topik berbeda, tidak disinggung |
| K-18 | Alokasi pembayaran parsial | nota tertua dulu | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |
| K-19 | Praktik tukar faktur/TT | tidak dimodelkan v1 | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |
| K-20 | Batas otomasi reminder WA (OD-3A-4) | H-3 & H0 otomatis, sisanya manusia | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 — OD-3A-4 tetap terbuka (lihat §8) |
| K-21 | Pemesan vs pembayar | diasumsikan bisa beda orang | `NOT_OBSERVED` | Tidak dinyatakan eksplisit di Pack v1.0 |
| K-22 | Perlakuan customer "kenal lama" | tidak ada pengecualian di skor; pengecualian di aksi | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |
| K-23 | Pola fraud relasi yang pernah terjadi | — (input Business Guard) | `LOCKED` — WK-05, BG-01 | WK-05 (titip uang sebagian) + BG-01 (money handoff anomaly, status `unverified` sampai direkonsiliasi, "tidak boleh menyimpulkan fraud hanya dari satu sinyal") |
| K-24 | Kewajiban sales melapor perubahan customer | wajib via laporan harian | `NOT_OBSERVED` | Tidak dinyatakan sebagai kewajiban eksplisit di Pack v1.0 |
| K-25 | Pelaksana penagihan (OD-3A-1) | — (belum ada default) | `NOT_OBSERVED` | Tidak dijawab — OD-3A-1 tetap terbuka (lihat §8) |
| K-26 | Sinyal awal kecurigaan terhadap sales | — (input Business Guard) | `NEEDS_PILOT_CALIBRATION` — terkait WK-10, BG-03, DC-01 | Sebagian sinyal asli (route deviation, diskon melebar) kini tercakup Pack; sinyal lain yang disebut asli (setoran telat, nota aneh) tidak disinggung |
| K-27 | Insentif kejujuran sales atas customer bermasalah | — (kandidat kebijakan) | `NOT_OBSERVED` | Kebijakan insentif, bukan sinyal data — tidak disinggung Pack v1.0 |
| K-28 | Isi 3 baris teratas briefing pagi | omzet vs target · piutang berbahaya · janji bayar hari ini | `NEEDS_PILOT_CALIBRATION` — terkait WK-11 | WK-11: prinsip briefing (risiko + alasan + bukti + rekomendasi) locked; urutan/isi 3-baris spesifik belum |
| K-29 | Batas eskalasi ke owner | Risiko Tinggi & janji bolos ≥ toleransi | `LOCKED` (kontrak) — §4.5 Owner Alert, WK-11; threshold pemicu `NEEDS_PILOT_CALIBRATION` | Kontrak isi alert (toko, jenis penyimpangan, nilai selisih, bukti, tingkat risiko, tindakan) locked di §4.5; ambang numerik label "Risiko Tinggi" sendiri masih tergantung K-04/05/06 |
| K-30 | Kanal & jam laporan eksekutif | WA jam 08:00 + dashboard | `LOCKED` (kanal) — WK-12, §4.5; jam spesifik `NEEDS_PILOT_CALIBRATION` | WK-12: owner/executive pakai WhatsApp — kanal terkonfirmasi; jam 08:00 tidak disebutkan di Pack v1.0 |
| K-31 | Anti-noise: yang tidak boleh dikirim | maksimal 3 item/hari, tanpa duplikat | `NOT_OBSERVED` | Tidak disinggung di Pack v1.0 |

**Ringkasan:** dari 31 parameter — **7 LOCKED** (sebagian/penuh: K-07, K-08,
K-09, K-12, K-23, K-29, K-30), **10 NEEDS_PILOT_CALIBRATION** (K-01, K-02,
K-04, K-05, K-06, K-10, K-15, K-16, K-26, K-28), **14 NOT_OBSERVED** (K-03,
K-11, K-13, K-14, K-17, K-18, K-19, K-20, K-21, K-22, K-24, K-25, K-27, K-31).

---

## 3. Business Rules Draft (v0 — menunggu kalibrasi)

> **Status per 16 Juli 2026:** draft ini tetap `v0`, angka dalam `[ ]` di
> bawah **belum diganti** — sesuai §2, seluruh threshold berlabel
> `NEEDS_PILOT_CALIBRATION`/`NOT_OBSERVED` tidak boleh diisi angka karangan.
> Aturan kualitatif yang sudah `LOCKED` di Knowledge Pack v1.0 (mis. PIC
> berganti sebagai sinyal non-blokir, tempo ~2 minggu sebagai baseline
> tenant) dijelaskan naratif di Pack §5 (Decision Rules DV-01–DC-01) dan
> §6 — dokumen ini tidak menduplikasinya. Rujuk Pack sebagai sumber kanonik
> untuk aturan yang sudah locked; draft di bawah hanya untuk parameter yang
> masih menunggu kalibrasi pilot.

Ditulis dalam bahasa bisnis; angka dalam `[ ]` diganti hasil matrix.

**Customer Health**
1. Customer berlabel **Perhatian** bila salah satu: tidak order > `[1,5×]` ritme
   normalnya · rata-rata bayar 3 nota terakhir > tempo + `[toleransi]` · PIC/nomor
   WA berganti · nilai order turun < `[70%]` baseline.
2. Customer berlabel **Risiko Tinggi** bila: ≥ `[2]` sinyal Perhatian aktif bersamaan ·
   atau janji bayar bolos ≥ `[1×]` · atau outstanding > credit limit · atau nota
   tertua > `[60]` hari.
3. Setiap label wajib menampilkan sinyal pemicunya dalam bahasa sehari-hari.
4. Label membaik otomatis bila perilaku kembali normal selama `[2 siklus order]`.

**Collection**
5. Reminder sopan otomatis `[H-3]` dan `[H0]`; setelahnya tindakan manusia
   berbekal konteks. *(menunggu K-20)*
6. Nota masuk daftar tagih aktif mulai `[H+3]`; prioritas diurutkan
   `[nilai × umur × health × janji bolos]`. *(menunggu K-13, K-15)*
7. Janji bayar dicatat wajib (tanggal + nominal); bolos `[1×]` → prioritas naik +
   eskalasi owner. *(menunggu K-16)*
8. Pembayaran parsial dialokasikan ke `[nota tertua]`. *(menunggu K-18)*
9. Nota "macet" = `[> 90 hari / 3× janji bolos]` → rekomendasi tahan pengiriman +
   keputusan di owner. *(menunggu K-14, K-17)*

**Executive**
10. Briefing pagi maksimal `[3]` item; urutan default: `[uang berisiko → janji bayar
    hari ini → pencapaian sales]`. *(menunggu K-28, K-31)*
11. Eskalasi langsung ke owner hanya untuk: `[Risiko Tinggi baru, janji bolos,
    over-limit]`. *(menunggu K-29)*

---

## 4. Customer DNA Validation (checklist saat interview)

Bacakan dan minta Pak Waluyo mengoreksi — ✅ setuju / ✏️ koreksi:

- [ ] "Customer yang mau bermasalah hampir selalu kelihatan dulu dari **cara bayarnya**, sebelum kelihatan dari ordernya."
- [ ] "**PIC ganti** itu perlu dicek, tapi tidak otomatis bahaya."
- [ ] "**Nomor WA baru** tanpa pemberitahuan itu patut dicurigai."
- [ ] "Order yang **mengecil pelan-pelan** lebih berbahaya daripada yang berhenti mendadak."
- [ ] "Tiap customer punya **ritme sendiri** — tidak bisa disamakan batas harinya."

## 5. Customer Health Validation

- [ ] Tiga label (Aman / Perhatian / Risiko Tinggi) cukup — tidak perlu lebih halus.
- [ ] Label harus selalu disertai **alasan** yang bisa dibaca sekilas.
- [ ] Skor dihitung **harian** sudah cukup cepat (tidak perlu realtime).
- [ ] Distribusi label hasil sistem masuk akal dibanding intuisi beliau (K-11).
- [ ] Perilaku bayar berbobot lebih besar daripada perilaku order. *(K-10)*

## 6. Collection Validation

- [ ] Aging dihitung dari **jatuh tempo**, bucket: belum jatuh tempo / 1–30 / 31–60 / 61–90 / >90.
- [ ] Daftar prioritas pagi berbentuk **kartu kerja bernarasi** (siapa, berapa, kenapa, saran cara).
- [ ] Janji bayar wajib tercatat di sistem, bukan di ingatan penagih.
- [ ] Tangga reminder H-3 → H0 → H+3 → H+7 sesuai (atau dikoreksi K-13/K-20).
- [ ] Keputusan tahan pengiriman & penagihan keras **selalu di manusia** — sistem hanya merekomendasikan.

## 7. Executive Intelligence Validation

*Tunjukkan langsung halaman Executive Intelligence yang sudah jalan (skor, briefing,
tindakan) — reaksi beliau adalah data kalibrasi.*

- [ ] Skor kesehatan bisnis satu angka (0–100) terasa berguna, bukan gimmick.
- [ ] Briefing pagi model sekarang (headline → penahan skor → perhatian → satu rekomendasi) enak dibaca.
- [ ] 3 hal yang ingin beliau lihat tiap pagi (K-28) sudah/belum terwakili.
- [ ] Kanal WA jam `[08:00]` untuk laporan harian sesuai kebiasaan beliau (K-30).
- [ ] Ada bagian yang beliau anggap **berlebihan/noise** → catat untuk dipangkas (K-31).

---

## 8. Open Discussion & Candidate Insights

**Status per 16 Juli 2026** (lihat §2 untuk detail mapping):

| # | Topik | Terkait | Status |
|---|---|---|---|
| OD-3A-1 | Pelaksana penagihan → RBAC daftar prioritas | K-25 | **Tetap terbuka** — `NOT_OBSERVED` di Pack v1.0, belum ada keputusan |
| OD-3A-4 | Batas otomasi reminder WA | K-20 | **Tetap terbuka** — `NOT_OBSERVED` di Pack v1.0, belum ada keputusan |

*(OD-3A-2 penundaan CollectionCase dan OD-3A-3 invoice otomatis dari sales_order
tetap menunggu keputusan Founder — tidak bergantung interview, statusnya tidak
berubah oleh pembaruan ini.)*

**Candidate Insights — status setelah Knowledge Pack v1.0:**

| # | Kandidat | Asal | Status |
|---|---|---|---|
| CI-1 | Deteksi perubahan **komposisi produk** sebagai sinyal health tambahan | D1 #5 (K-09) | **RESOLVED → LOCKED** — masuk Pack §6 Order Health ("perubahan mix produk") |
| CI-2 | Penanda **customer musiman** agar tidak salah alarm | D1 #7 (K-03) | Tetap terbuka — `NOT_OBSERVED` |
| CI-3 | Perlakuan khusus **customer relasi lama** di lapisan aksi (bukan skor) | D4 #24 (K-22) | Tetap terbuka — `NOT_OBSERVED` |
| CI-4 | Pemodelan **tukar faktur/TT** bila ternyata praktik inti | D3 #20 (K-19) | Tetap terbuka — `NOT_OBSERVED` |
| CI-5 | Mekanisme **insentif kejujuran sales** melaporkan customer bermasalah | D5 #29 (K-27) | Tetap terbuka — `NOT_OBSERVED` |
| CI-6 | Sinyal kecurigaan sales → umpan awal spec **Business Guard** (Phase 4) | D5 #28 (K-26) | **Sebagian resolved** — route deviation (WK-10/BG-03) & diskon (DC-01) kini locked; sinyal lain yang disebut asli (setoran telat, nota aneh) tetap `NOT_OBSERVED` |

Kandidat yang masih terbuka di atas dicatat di sini — bukan langsung masuk
backlog, dan tetap membutuhkan konfirmasi Design Partner sebelum jadi rule.

---

*Semua keputusan tunduk pada Product Constitution v1.2. Dokumen ini tidak
mengubah konstitusi; hasil kalibrasi menjadi business rules Phase 3B.
Sumber kanonik temuan locked: `AODP_WALUYO_LIVING_KNOWLEDGE_PACK_v1.0.md`
(`docs/knowledge/packs/waluyo/`, Pack ID `AODP-WALUYO-CORE-001` v1.0.0).*
