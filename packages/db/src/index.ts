import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";

export * from "./schema.js";

// Re-export helper ORM supaya konsumen (mis. wa-engine) tidak perlu
// dependensi langsung ke drizzle-orm — cukup @wa-tools/db.
export { eq, sql } from "drizzle-orm";

// Klien SQLite lokal (file). DATABASE_URL di-resolve relatif terhadap
// working directory proses; di Windows pakai path absolut di .env.local,
// mis. file:C:/wa-tools/data/wa-tools.db. Klien dibuat di sini tapi
// koneksi file baru dibuka saat query pertama — scaffold ini tidak
// menjalankan query apa pun.
const client = createClient({
  url: process.env.DATABASE_URL ?? "file:./data/wa-tools.db",
});

export const db = drizzle(client, { schema });

export type WaDb = typeof db;

/**
 * Buka koneksi SQLite lain (mis. file temp untuk test) dengan schema
 * yang sama. Tidak mengubah koneksi default `db`.
 */
export function openDatabase(url: string): WaDb {
  const other = createClient({ url });
  return drizzle(other, { schema });
}

// CREATE TABLE IF NOT EXISTS yang mencerminkan schema.ts persis
// (nama tabel & kolom mengikuti definisi Drizzle di schema.ts).
// Idempotent: aman dipanggil tiap start engine; TIDAK menghapus data.
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    nama TEXT,
    avatar_path TEXT,
    terakhir_terlihat INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    judul TEXT NOT NULL,
    tipe TEXT NOT NULL,
    arsip INTEGER NOT NULL DEFAULT 0,
    pin INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    pengirim_jid TEXT NOT NULL,
    arah TEXT NOT NULL,
    tipe TEXT NOT NULL,
    teks TEXT,
    caption TEXT,
    timestamp INTEGER NOT NULL,
    status TEXT NOT NULL,
    balasan_ke TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_chat_time_idx
    ON messages (chat_jid, timestamp)`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    isi TEXT NOT NULL,
    waktu_kirim INTEGER NOT NULL,
    status TEXT NOT NULL,
    percobaan INTEGER NOT NULL DEFAULT 0,
    error_terakhir TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    nada TEXT NOT NULL,
    isi TEXT NOT NULL,
    sumber TEXT NOT NULL,
    status TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/**
 * Buat semua tabel Fase 1 bila belum ada. Parameter opsional `target`
 * memungkinkan test memakai koneksi SQLite temp tanpa menyentuh
 * database default; default-nya koneksi modul (`db`).
 */
export async function ensureSchema(target: WaDb = db): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await target.run(sql.raw(statement));
  }
}
