import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export * from "./schema.js";

// Klien SQLite lokal (file). DATABASE_URL di-resolve relatif terhadap
// working directory proses; di Windows pakai path absolut di .env.local,
// mis. file:C:/wa-tools/data/wa-tools.db. Klien dibuat di sini tapi
// koneksi file baru dibuka saat query pertama — scaffold ini tidak
// menjalankan query apa pun.
const client = createClient({
  url: process.env.DATABASE_URL ?? "file:./data/wa-tools.db",
});

export const db = drizzle(client, { schema });
