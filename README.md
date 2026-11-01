# WhatsApp Tools (local dashboard)

Dashboard local untuk membantu kerja dan aktivitas harian di WhatsApp.
Spesifikasi mengikat: [`SPEC.md`](./SPEC.md). Referensi UI: mockup
`preview-desain-ui-whatsapp-tools` (UI v1 APPROVED 2026-11-02).

> **Status: FASE 1 TERIMPLEMENTASI.** Koneksi WA (Baileys, default mode
> mock yang aman) — pairing QR + fallback kode pairing 8 digit,
> inbox/chat data asli, pesan terjadwal + antrean kirim,
> draf balasan AI (3 nada, selalu draft), Home data asli, dan Pengaturan.
> Deployment Windows ikut terimplementasi (SPEC §13): service NSSM,
> health endpoint, watchdog fail-fast, single-instance lock, dan tray
> companion (tray ditulis untuk Windows, belum teruji dari VM Linux).
> Yang diparkir (SPEC §4) belum dibangun: media handler, analisa, laporan,
> Studio Media — halamannya tampil "segera hadir".
> Implementasi mengikuti urutan SPEC §12.

## Struktur

```
wa-tools/
├── SPEC.md                 # spesifikasi Fase 1 (mengikat)
├── apps/
│   ├── web/                # dashboard Next.js (App Router + TS + Tailwind v4)
│   │   └── app/            # Home, Chat, Jadwal, AI, Media, Pengaturan + API routes
│   └── wa-engine/          # service Node Baileys (HTTP + queue runner)
│       ├── src/            # transport, sync, server, queue, store, lock, watchdog
│       └── scripts/        # install-service.ps1, uninstall-service.ps1, tray-companion.ps1
├── packages/
│   └── db/                 # schema Drizzle + klien libSQL (dipakai kedua apps)
│       ├── src/schema.ts   # tabel SPEC §7 (tanpa tabel media — media DIPARKIR)
│       └── test/           # smoke test schema (vitest)
├── data/                   # file SQLite + lock runtime (di-ignore git, dibuat saat jalan)
├── logs/                   # log service NSSM (di-ignore git, dibuat saat service jalan)
├── .env.example            # placeholder config (TANPA nilai rahasia)
└── package.json            # workspace pnpm
```

## Prasyarat (Windows 11)

- Node.js 20+ (diuji di VM dengan Node 24)
- pnpm 10: `npm install -g pnpm` (atau `corepack enable` bila tersedia)

## Cara jalanin

```powershell
# 1. Dari folder wa-tools, install semua dependensi:
pnpm install

# 2. Salin config contoh (isi sesuai mesin masing-masing, jangan commit):
copy .env.example apps\web\.env.local

# 3. Dashboard (terminal 1):
pnpm dev
# -> http://localhost:3000 (placeholder)

# 4. Service WA engine (terminal 2, mode dev):
pnpm dev:engine
# -> http://127.0.0.1:3101/health (mode MOCK default: bukan WA sungguhan)

# 5. Untuk pemakaian harian, install engine sebagai Windows Service
#    (auto-start, background, tahan banting) — lihat "Deployment Windows"
#    di bawah. Dashboard sendiri tetap jalan via `pnpm dev`.
```

## Koneksi: QR atau kode pairing

Di dashboard → Pengaturan → kartu Status WhatsApp:

- **QR (utama):** scan QR yang tampil di dashboard dari HP
  (WhatsApp → Perangkat Tertaut → Tautkan perangkat).
- **Kode pairing (fallback bila QR bermasalah):** klik "Gunakan kode
  pairing", isi nomor HP (digit dengan kode negara, tanpa `+`, mis.
  `62812xxxxxxx`), tekan "Minta kode" — kode 8 digit tampil besar di
  dashboard, masukkan di HP (WhatsApp → Perangkat Tertaut → Tautkan
  dengan nomor telepon). **Ini BUKAN SMS OTP** — tidak ada SMS yang
  dikirim; kodenya hanya jembatan pairing Baileys.
- Kode berlaku singkat; bila kedaluwarsa, tekan "Minta kode baru"
  (kode baru berbeda dari sebelumnya).
- Setelah tertaut (via QR maupun kode), sesi tersimpan di folder auth
  dan reconnect otomatis tanpa QR/kode lagi — sama persis lifecycle-nya.
- Bila engine sudah connected, tombol minta kode menolak (409):
  tidak perlu kode lagi.

## Deployment Windows (wa-engine sebagai service, SPEC §13)

Tujuan: engine hidup terus di PC, auto-start pas laptop nyala, jalan di
background, tahan banting — kayak 9Router. Bukan console yang harus
dibuka manual.

### Prasyarat

- Node.js 20+, pnpm, dan NSSM (`nssm.exe`, unduh dari
  https://nssm.cc/download bila belum ada).
- Engine sudah di-build (`pnpm --filter wa-engine build`); script install
  mencoba build otomatis bila `dist/` belum ada dan pnpm tersedia.
- Hak admin **sekali** saat install saja.

### Install service

```powershell
# Dari PowerShell elevated (Run as administrator), di folder wa-tools:
powershell -ExecutionPolicy Bypass -File apps\wa-engine\scripts\install-service.ps1
# Opsi: -Force (install ulang bila service sudah ada),
#       -WithTrayStartup (ikon tray otomatis tiap login),
#       -NssmPath <path-ke-nssm.exe> bila nssm tidak di PATH.
```

Yang dikonfigurasi script: service `wa-tools-engine`, Automatic
(Delayed Start) supaya start setelah network siap, restart otomatis saat
crash (jeda 10 detik), jalan sebagai akun user (BUKAN SYSTEM) supaya
file auth milik user, stdout/stderr ke `logs/wa-engine.{out,err}.log`
(rotasi: 1 file cadangan, maks 10 MB). Password akun hanya diteruskan ke
nssm (disimpan Windows SCM/LSA), tidak pernah ditulis ke file repo.
Environment service: `WA_ENGINE_MOCK=0` (mode real), `WA_ENGINE_PORT`,
`DATABASE_URL` absolut ke `data/wa-tools.db`, `WA_ENGINE_LOCK_FILE`
absolut ke `data/wa-engine.lock`.

### Tahan banting (sudah di kode engine)

- **Health endpoint** `GET /health`: `state`, `connected`, `phone`,
  `mock`, `queuePaused`, `uptimeSeconds`, `startedAt`,
  `lastDisconnectAt`. Dipakai dashboard (kartu Pengaturan menampilkan
  uptime + terakhir putus) dan tray companion.
- **Watchdog internal:** soket mati >120 detik tanpa reconnect sukses
  (env `WATCHDOG_DEAD_MS`, `0` = nonaktif; cek tiap 15 detik) → proses
  exit(1) sengaja supaya NSSM me-restart-nya. TIDAK memicu saat pairing
  awal (belum pernah connected) maupun stop manual.
- **Single-instance lock** `data/wa-engine.lock` (env
  `WA_ENGINE_LOCK_FILE`): proses kedua keluar dengan kode 2 bila satu
  sudah jalan; lock stale (PID sudah mati) diambil alih; isi bukan PID
  ditolak fail-closed. Kode exit 2 sengaja TIDAK di-restart NSSM.
- **Tray companion** (opsional, sesi login saja):
  `powershell -STA -File apps\wa-engine\scripts\tray-companion.ps1` —
  ikon tray + menu (status, Buka Dashboard, Restart Engine, Berhenti
  Engine, Keluar). Tray tidak menjalankan service; service jalan tanpa
  login, tray hanya pendamping saat user login. Restart/Berhenti dari
  tray memanggil Service Control Manager dan bisa ditolak bila akun
  tidak punya hak atas service — pakai shell elevated bila begitu.
  Catatan jujur: script tray ditulis untuk Windows dan **belum teruji
  dari VM Linux** — verifikasi di PC (ikon muncul, status berubah,
  menu bekerja) sebelum dipakai harian. Alternatif bila tray tidak
  dipakai: kelola dari Pengaturan dashboard + `services.msc` seperti
  biasa.
- **Fallback bila NSSM ditolak:** Task Scheduler "At log on" yang
  menjalankan `node apps\wa-engine\dist\index.js` (dengan env yang sama
  seperti di atas). Service tetap default karena jalan tanpa login.

### Update

```powershell
# Dari folder wa-tools:
git pull
Restart-Service -Name wa-tools-engine   # butuh shell elevated
```

### Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File apps\wa-engine\scripts\uninstall-service.ps1
# Data (data/), log (logs/), dan auth Baileys TIDAK dihapus.
```

### Troubleshooting

- Service tidak mau start: cek `logs/wa-engine.err.log`; pastikan
  ObjectName/password akun benar (akun harus punya password; akun
  tanpa password ditolak Windows untuk service).
- Engine menolak start dengan pesan lock: pastikan tidak ada proses
  wa-engine lain yang jalan; bila yakin tidak ada, hapus
  `data/wa-engine.lock` lalu start lagi.
- Dashboard menampilkan engine "tidak jalan": pastikan service berstatus
  Running (`Get-Service wa-tools-engine`) dan `WA_ENGINE_URL` di
  `apps\web\.env.local` mengarah ke `http://127.0.0.1:3101`.

## Verifikasi

```powershell
pnpm test        # vitest: semua test (engine, web, db)
pnpm build       # db build + Next.js production build + engine typecheck
pnpm typecheck   # typecheck semua package (setelah build pertama)
```

## Keamanan — baca sebelum pakai

- Baileys adalah jalur **TIDAK RESMI**. WhatsApp dapat mem-banned nomor
  yang terdeteksi automasi (SPEC §8). Pengaman default dibuat konservatif.
- Folder auth Baileys (`apps/wa-engine/auth/`) bersifat rahasia setara
  password dan sudah masuk `.gitignore` — jangan pernah di-share.
- Repo GitHub: `marko1kiro/wa-tools` (private). User tinggal `git pull`
  dari PC lokal untuk update.
- Media handler **DIPARKIR** (SPEC §4): belum ada tabel media, dan pesan
  media di Fase 1 tampil sebagai placeholder sampai dibuka lagi.
