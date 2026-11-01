# SPEC — WhatsApp Tools (local dashboard)

Status: SPEC Fase 1 — ditulis 2026-11-02 setelah UI v1 APPROVED user.
Referensi UI yang mengikat: mockup interaktif `preview-desain-ui-whatsapp-tools`
(icon-only sidebar 70px, layout compact, Inbox full-screen replika WhatsApp
Desktop/Web lengkap dengan Omnibox perintah `/`, panel AI overlay di HP,
navigasi bawah di HP, tanpa teks keterangan).

## 1. Tujuan

Dashboard local untuk membantu kerja dan aktivitas harian user di WhatsApp.
Bukan chatbot baru, bukan pengganti WhatsApp: ini meja kerja di atas akun
WhatsApp user sendiri. Semua data tinggal di PC user, tidak keluar ke server
pihak ketiga (kecuali gateway AI yang user tunjuk sendiri).

## 2. Prinsip desain (mengikat)

1. **WA itu mesin, bukan UI.** Koneksi WhatsApp jalan sebagai service
   terpisah yang hidup terus. UI restart tidak boleh memutus koneksi WA.
2. **AI itu lapisan, bukan fitur tempel.** Semua tools AI memanggil satu
   AI layer ber-client OpenAI-compatible. Base URL, key, dan model bisa
   diganti dari Pengaturan tanpa bongkar fitur.
3. **Konteks dipilih, bukan ditebak.** Semua tools AI bekerja dari konteks
   yang sama: pilih chat → pilih rentang tanggal → tool jalan di atas data
   itu.
4. **AI tidak pernah kirim langsung.** Semua output AI (draf balasan,
   laporan, jadwal) masuk antrean review. User cek/edit, baru kirim manual.
5. **Fail-closed.** Kalau WA putus, jadwal auto-pause (bukan gagal diam-diam
   atau kirim setengah-setengah). Kalau AI gagal, tool menampilkan error,
   bukan hasil karangan.

## 3. Scope Fase 1 (yang dibangun sekarang)

1. **Koneksi WA** — pairing QR (Baileys), status koneksi realtime,
   reconnect otomatis, tampilkan nomor yang terhubung.
2. **Inbox + Chat** — daftar chat + isi percakapan dari data asli,
   mengikuti layout mockup yang sudah di-approve (replica WA Web +
   Omnibox `/` di composer).
3. **Pesan terjadwal** — buat/edit/pause/batal; status: draf, terjadwal,
   terkirim, gagal; antrean kirim dengan jeda acak + batas harian.
4. **Draf balasan AI** — dari chat aktif, 3 opsi nada (formal, santai,
   tegas); tombol "Pakai draf" hanya mengisi composer, tidak mengirim.
5. **Home / Hari ini** — terhubung ke data asli: jadwal hari ini, chat
   belum dibalas, antrean review AI.
6. **Pengaturan** — koneksi WA, gateway AI (base URL, key, model per tool),
   batas kirim (jeda antar pesan, batas harian, jam tenang).

## 4. Di luar scope Fase 1 (PARKIR — jangan dibangun dulu)

- **Media handler** (download/simpan/preview media kiriman orang lain) —
  DIPARKIR atas perintah user 2026-11-02, fokus UI dulu. Desain pipeline
  sudah dibahas (download+dekripsi saat pesan masuk, simpan lokal per
  chat/tanggal, thumbnail, auto-download <16 MB, view-once ditandai,
  retensi + dedupe hash) dan tinggal diimplementasi saat dibuka lagi.
- **Fase 2:** analisa chat, laporan dari chat/history, Studio Media
  (generate gambar), template pesan, auto-reply ringan.
- Jalur resmi WhatsApp Cloud API (Meta) — bukan scope; mesin Fase 1 adalah
  Baileys (jalur tidak resmi, lihat §8).

## 5. Arsitektur

```
┌─────────────────────────┐     HTTP/SSE      ┌─────────────────────────┐
│  wa-engine (Node svc)   │ ◄──────────────► │  Next.js UI (dashboard) │
│  - Baileys connection   │                    │  - App Router + TS      │
│  - QR pairing           │     SQLite       │  - Tailwind + shadcn/ui   │
│  - terima/kirim pesan   │ ◄──── shared ───► │  - SSE status/pesan masuk │
│  - sender queue (jitter)│     (Drizzle)     │  - AI layer client        │
└─────────────────────────┘                    └─────────────────────────┘
        │                                                  │
        └─────────────── AI gateway lokal ─────────────────┘
                    (OpenAI-compatible, default
                     http://localhost:20128/v1)
```

- Dua proses terpisah: `wa-engine` (jaga koneksi WA) + `apps/web`
  (dashboard Next.js). Berbagi satu database SQLite.
- Runtime target: PC user (Windows 11), Node 20+, pnpm.
- Serah terima & version control: **GitHub (keputusan user 2026-11-02)**.
  Repo dibuat saat scaffold selesai, lalu user tinggal `git pull` dari
  PC lokal. Tidak ada kode yang di-push sebelum user memerintahkan.

## 6. Stack

- Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui
- Baileys (`@whiskeysockets/baileys`) — mesin WhatsApp
- Drizzle ORM + libSQL (file SQLite lokal) — tanpa Docker, tanpa
  native-build drama di Windows
- p-queue — antrean kirim (jeda acak, batas rate)
- SSE — status koneksi + pesan masuk realtime
- qrcode — render QR pairing di UI
- Zod — validasi input; Vitest — unit test

## 7. Model data (SQLite, Drizzle)

- `contacts` — jid, nama, avatar_path, terakhir_terlihat
- `chats` — jid, judul, tipe (pribadi/grup), arsip, pin, unread_count
- `messages` — id, chat_jid, pengirim_jid, arah, tipe, teks, caption,
  timestamp, status (terkirim/dibaca/gagal), balasan_ke
- `schedules` — id, chat_jid, isi, waktu_kirim, status
  (draf/terjadwal/terkirim/gagal/dibatalkan), percobaan, error_terakhir
- `drafts` — id, chat_jid, nada, isi, sumber (model + prompt template),
  status (menunggu review/dipakai/dibuang)
- `settings` — key/value: gateway (base_url, key_ref, model per tool),
  batas kirim (jeda_min_ms, jeda_max_ms, batas_harian, jam_tenang)
- Catatan: media (file kiriman) BELUM ada tabelnya di Fase 1 karena
  media handler diparkir. Pesan media di Fase 1 tampil sebagai placeholder
  "media belum didukung" sampai media handler dibuka lagi.

## 8. Keamanan & risiko (wajib dibaca user)

- Baileys adalah jalur TIDAK RESMI. WhatsApp dapat mem-banned nomor yang
  terdeteksi automasi, terutama untuk kirim massal/agresif.
- Default yang dipakai: **nomor utama user (keputusan user 2026-11-02)**.
  Konsekuensinya serius: kalau nomor terdeteksi automasi dan di-banned,
  user kehilangan nomor hariannya. Karena itu default pengaman untuk nomor
  utama dibuat KONSERVATIF: jeda antar pesan lebih panjang, batas harian
  rendah, tanpa blast agresif, dan pemanasan bertahap untuk nomor yang
  baru dipakai automasi. Setting ini bisa diubah di Pengaturan, tapi
  menaikkan batas di atas default adalah risiko user sendiri.
- Pengaman bawaan: jeda acak antar pesan, batas harian default, jam tenang,
  auto-pause semua jadwal saat WA putus, log setiap pengiriman.
- Session WA (auth folder Baileys) bersifat rahasia setara password:
  jangan di-share, jangan masuk repo, masuk .gitignore.
- Data chat & media (nanti) hanya di PC user. Gateway AI lokal default
  berarti isi chat tidak keluar PC; kalau user mengganti gateway ke
  layanan online, itu keputusan user sendiri.

## 9. AI layer

- Client OpenAI-compatible; konfigurasi: base_url, key, model.
- Routing model per tool (dapat diubah di Pengaturan):
  - Draf balasan → model cepat/murah
  - (Fase 2) Analisa/laporan → model kuat
  - (Fase 2) Media → model image
- Prompt template per tool tersimpan sebagai config yang bisa diedit user.
- Timeout + error jelas; tidak ada fallback diam-diam ke model lain.
- Output AI selalu berstatus draft sampai user memakai/mengirim manual.

## 10. Pemetaan UI (mockup → rute nyata)

- Home / Hari ini → `/` (data asli)
- Inbox / Chat (full-screen, replica WA Web, Omnibox `/`) → `/chat`
- Jadwal → `/jadwal` (filter status: draf/terjadwal/terkirim/gagal)
- AI Tools → `/ai` (Fase 1: hanya draf balasan; tool lain tampil
  sebagai "segera hadir" sampai Fase 2, bukan halaman kosong)
- Studio Media → `/media` (Fase 2; di Fase 1 tampil sebagai "segera
  hadir")
- Pengaturan → `/pengaturan`

## 11. Keputusan yang masih terbuka (butuh jawaban user)

1. **Nomor WA: DIPUTUSKAN user 2026-11-02 → nomor utama.** Default
   pengaman dibuat konservatif (lihat §8). User dapat beralih ke nomor
   khusus kapan pun lewat Pengaturan.
2. **Serah terima kode: DIPUTUSKAN user 2026-11-02 → GitHub.**
   Repo dibuat saat scaffold selesai; user tinggal `git pull` dari PC
   lokal untuk update. Default yang dipakai: repo private
   `marko1kiro/wa-tools` kecuali user meminta nama/visibilitas lain.
3. **Nama final proyek** (sementara: "WhatsApp Tools" / folder `wa-tools`).

## 12. Urutan implementasi

1. SPEC ini (selesai) → 2. Scaffold proyek + verifikasi build →
   3. wa-engine: koneksi QR + sync pesan → 4. Inbox/Chat data asli →
   5. Jadwal + antrean kirim → 6. Draf AI + Pengaturan →
   7. Home data asli → 8. Uji end-to-end di PC user → 9. Serah terima.
