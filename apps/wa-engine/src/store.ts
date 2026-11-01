import { db, eq, schedules, settings, sql } from "@wa-tools/db";
import type { QueueSchedule, QueueStore } from "./queue.js";

// Adapter koordinator: Drizzle/libSQL -> QueueStore + pembaca settings.
// Dipakai wiring queue runner di index.ts. Query ditulis dengan sql``
// berparameter (bukan string concat) dan hanya memakai export
// @wa-tools/db (tanpa menambah dependensi drizzle-orm ke wa-engine).

export type SettingsMap = Record<
  string,
  string | number | boolean | undefined
>;

/** Nilai settings disimpan sebagai JSON string atau string mentah. */
export function parseSettingValue(raw: string): string | number | boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
    ) {
      return parsed;
    }
  } catch {
    // Bukan JSON valid -> pakai mentah (mis. "22:00-07:00").
  }
  return raw;
}

export async function readSettingsMap(): Promise<SettingsMap> {
  const rows = await db.select().from(settings);
  const out: SettingsMap = {};
  for (const row of rows) {
    out[row.key] = parseSettingValue(row.value);
  }
  return out;
}

export function createDrizzleQueueStore(): QueueStore {
  return {
    async listDue(nowMs: number): Promise<QueueSchedule[]> {
      const rows = await db
        .select()
        .from(schedules)
        .where(sql`status = 'terjadwal' AND waktu_kirim <= ${nowMs}`)
        .orderBy(schedules.sendAt);
      return rows.map((r) => ({
        id: r.id,
        chatJid: r.chatJid,
        body: r.body,
        sendAt: r.sendAt,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
      }));
    },

    async countSentToday(dayStartMs: number): Promise<number> {
      // waktu_kirim dipakai sebagai proksi waktu terkirim (tabel tidak
      // punya kolom waktu-terkirim sendiri) — sesuai header queue.ts.
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(schedules)
        .where(sql`status = 'terkirim' AND waktu_kirim >= ${dayStartMs}`);
      return Number(rows[0]?.n ?? 0);
    },

    async markSent(id: string): Promise<void> {
      await db
        .update(schedules)
        .set({ status: "terkirim" })
        .where(eq(schedules.id, id));
    },

    async recordFailure(
      id: string,
      attempts: number,
      lastError: string,
      status: "terjadwal" | "gagal",
    ): Promise<void> {
      await db
        .update(schedules)
        .set({ attempts, lastError, status })
        .where(eq(schedules.id, id));
    },
  };
}
