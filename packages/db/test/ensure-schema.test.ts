import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Test ensureSchema() terhadap file SQLite TEMP (bukan data/wa-tools.db).
// DATABASE_URL harus diset SEBELUM modul src/index di-import, karena
// klien libSQL dibuat di level modul.
describe("ensureSchema", () => {
  it("membuat semua tabel + index Fase 1 dan idempotent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wa-db-"));
    const file = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${file}`;

    const { ensureSchema, db, contacts } = await import("../src/index");

    await ensureSchema();
    await ensureSchema(); // kedua kali: tidak error, tidak reset

    const tables = await db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = (tables.rows as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      "contacts",
      "chats",
      "messages",
      "schedules",
      "drafts",
      "settings",
    ]) {
      expect(names).toContain(t);
    }

    const indexes = await db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    );
    const indexNames = (indexes.rows as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(indexNames).toContain("messages_chat_time_idx");

    // ensureSchema tidak menghapus data yang sudah ada.
    await db.insert(contacts).values({ jid: "62812@s.whatsapp.net" });
    await ensureSchema();
    const rows = await db.select().from(contacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jid).toBe("62812@s.whatsapp.net");
  });
});
