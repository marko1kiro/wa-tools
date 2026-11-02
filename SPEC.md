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

1. **Koneksi WA** — pairing QR (Baileys) + **fallback kode pairing
   8 digit** (`requestPairingCode`) bila QR bermasalah: user memasukkan
   nomor HP (kode negara, tanpa `+`) di dashboard → engine meminta kode
   pairing → kode tampil di dashboard → user memasukkannya di HP
   (WhatsApp → Perangkat Tertaut → Tautkan dengan nomor telepon).
   Setelah tertaut (via QR maupun kode), sesi tersimpan sama dan
   reconnect otomatis tanpa QR/kode lagi. Status koneksi realtime,
   reconnect otomatis, tampilkan nomor yang terhubung.
   Konfigurasi socket mengikuti skill whatsapp-baileys: versi terbaru
   via `fetchLatestBaileysVersion` (fallback default bila fetch gagal),
   `syncFullHistory: false`, `markOnlineOnConnect: false`,
   `connectTimeoutMs: 60000`, `keepAliveIntervalMs: 30000`,
   browser `WhatsApp Tools`; reconnect backoff 3 detik eksponensial
   (mentok 60 detik); dashboard me-refresh QR + status tiap 5 detik
   selama belum connected.
   - **Auto-connect mode real (perbaikan 2026-11-02):** engine mode real
     (`WA_ENGINE_MOCK=0`) auto-connect saat boot — habis laptop restart,
     engine langsung jaga koneksi tanpa menunggu dashboard memanggil
     `/start` (mode mock tetap manual via `/start`). Gagal auto-connect
     awal hanya di-log, tanpa restart loop.
   - **QR sebagai PNG (perbaikan 2026-11-02):** `GET /qr` engine
     mengembalikan PNG beneran (render string QR Baileys via library
     `qrcode`); tanpa QR aktif -> 404 `{error:"no_qr"}`.
   - **Readiness pairing code (perbaikan 2026-11-02):**
     `requestPairingCode` menunggu connection.update pertama (bukti
     handshake berjalan, timeout 15 detik); bila socket sudah punya QR
     (state pairing), anggap ready. Timeout -> error `socket_not_ready`
     (502 + detail), bukan `pairing_failed` generik.
   - **Detail error (perbaikan 2026-11-02):** respons error
     `/pairing-code` menyertakan `detail` aman (pesan Baileys +
     statusCode bila ada, tanpa kredensial/session); dashboard
     menampilkannya di bawah pesan gagal.
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
   3. wa-engine: koneksi QR + kode pairing fallback + sync pesan → 4. Inbox/Chat data asli →
   5. Jadwal + antrean kirim → 6. Draf AI + Pengaturan →
   7. Home data asli → 8. Uji end-to-end di PC user → 9. Serah terima.

## 13. Deployment Windows (kayak 9Router — keputusan user 2026-11-02, SEMUA LAPISAN APPROVED user 2026-11-02)

Target: wa-engine hidup terus di PC user, auto-start pas laptop nyala,
jalan di background, tahan banting. Bukan console yang harus dibuka manual.

1. **Windows Service via NSSM (utama).** Service `wa-tools-engine`:
   Automatic (Delayed Start) agar start setelah network siap; restart
   otomatis saat crash (dengan jeda + throttle); jalan sebagai akun user
   (BUKAN SYSTEM) supaya file auth milik user dan dashboard bisa
   mengontrolnya; stdout/stderr ke file log berotasi.
2. **Health endpoint.** `GET /health` di wa-engine: status koneksi,
   uptime, disconnect terakhir. Dipakai dashboard + watchdog.
3. **Watchdog internal (fail-fast).** Kalau soket mati melewati ambang
   tanpa reconnect sukses, proses exit sengaja → NSSM me-restart-nya.
   Jangan gantung hidup tapi mati suri.
4. **Single-instance lock.** Proses kedua dilarang start kalau satu sudah
   jalan — cegah dua proses rebutan satu sesi Baileys.
5. **Tray companion.** Ikon di system tray taskbar + menu: status koneksi,
   buka dashboard, restart engine, berhenti. Engine juga terlihat di
   Services/Task Manager sebagai service biasa.
6. **Install & update.** Script install service (PowerShell) + README.
   Install butuh hak admin SEKALI; setelah itu jalan tanpa admin.
   Update: `git pull` lalu restart service (tombol di dashboard / menu
   tray).
7. **Fallback bila NSSM ditolak user:** Task Scheduler "At log on" +
   script start. Service tetap default karena jalan tanpa login.

### Implementasi (2026-11-02, sudah di repo)

- **Lock:** `apps/wa-engine/src/lock.ts` — file `data/wa-engine.lock`
  (env `WA_ENGINE_LOCK_FILE`); proses kedua exit kode 2; lock stale
  (PID mati) diambil alih; isi bukan PID ditolak fail-closed.
- **Watchdog:** `apps/wa-engine/src/watchdog.ts` — ambang default 120
  detik (env `WATCHDOG_DEAD_MS`, `0` = nonaktif), cek tiap 15 detik;
  hanya bersenjata setelah satu koneksi sukses; stop manual melucuti;
  exit(1) supaya NSSM restart.
- **Health:** `GET /health` mengembalikan `state`, `connected`,
  `phone`, `mock`, `queuePaused`, `uptimeSeconds`, `startedAt`,
  `lastDisconnectAt` (dipakai dashboard via `/api/status` → kartu
  Pengaturan menampilkan uptime + terakhir putus).
- **Service:** `apps/wa-engine/scripts/install-service.ps1` (butuh admin
  sekali; akun user via ObjectName, bukan SYSTEM; Delayed Start;
  restart delay 10 detik; log `logs/wa-engine.{out,err}.log` rotasi
  10 MB; exit 2 tidak di-restart) + `uninstall-service.ps1`.
- **Tray:** `apps/wa-engine/scripts/tray-companion.ps1` (PowerShell +
  WinForms, polling `/health` 10 detik; menu: status, Buka Dashboard,
  Restart Engine, Berhenti Engine, Keluar). Ditulis untuk Windows,
  BELUM teruji dari VM Linux — verifikasi di PC user; alternatif:
  dashboard Pengaturan + `services.msc`.
- **Update:** `git pull` dari root repo lalu
  `Restart-Service -Name wa-tools-engine` (butuh shell elevated).

### Perbaikan koneksi (2026-11-02, sudah di repo)

- **Auto-connect mode real:** engine `WA_ENGINE_MOCK=0` auto-connect
  saat boot (gagal awal hanya di-log); mode mock tetap manual via
  `/start`.
- **QR PNG:** `GET /qr` mengembalikan `image/png` (no-store); tanpa QR
  -> 404 `{error:"no_qr"}`; qr-proxy meneruskan body + content-type
  dengan header no-cache; dashboard memakai cache-buster tiap load.
- **Readiness pairing:** `requestPairingCode` menunggu connection.update
  pertama (timeout 15 detik, konstanta `PAIRING_READY_TIMEOUT_MS`);
  timeout -> `socket_not_ready` (502 + detail).
- **Detail error:** `/pairing-code` mengembalikan `detail` aman
  (pesan + statusCode Baileys); proxy + dashboard meneruskan dan
  menampilkannya.
