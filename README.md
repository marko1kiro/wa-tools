# WhatsApp Tools (local dashboard)

Dashboard local untuk membantu kerja dan aktivitas harian di WhatsApp.
Spesifikasi mengikat: [`SPEC.md`](./SPEC.md). Referensi UI: mockup
`preview-desain-ui-whatsapp-tools` (UI v1 APPROVED 2026-11-02).

> **Status: FASE 1 TERIMPLEMENTASI.** Koneksi WA (Baileys, default mode
> mock yang aman), inbox/chat data asli, pesan terjadwal + antrean kirim,
> draf balasan AI (3 nada, selalu draft), Home data asli, dan Pengaturan.
> Yang diparkir (SPEC §4) belum dibangun: media handler, analisa, laporan,
> Studio Media — halamannya tampil "segera hadir".
> Implementasi mengikuti urutan SPEC §12.

## Struktur

```
wa-tools/
├── SPEC.md                 # spesifikasi Fase 1 (mengikat)
├── apps/
│   ├── web/                # dashboard Next.js (App Router + TS + Tailwind v4)
│   │   └── app/            # placeholder Home (rute nyata menyusul)
│   └── wa-engine/          # service Node Baileys (placeholder, tanpa koneksi)
│       └── src/index.ts
├── packages/
│   └── db/                 # schema Drizzle + klien libSQL (dipakai kedua apps)
│       ├── src/schema.ts   # tabel SPEC §7 (tanpa tabel media — media DIPARKIR)
│       └── test/           # smoke test schema (vitest)
├── data/                   # file SQLite runtime (di-ignore git, dibuat saat jalan)
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

# 4. Service WA engine (terminal 2, saat ini hanya placeholder):
pnpm dev:engine
```

## Verifikasi

```powershell
pnpm test        # vitest: smoke test schema
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
