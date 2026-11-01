// PATCH / DELETE /api/schedules/[id].
//
// PATCH {body?, sendAt?, status?} — ubah isi/waktu, atau batalkan.
//   Status yang sah lewat PATCH: draf, terjadwal, dibatalkan. Status
//   terkirim/gagal DITOLAK (hanya antrean kirim yang boleh menulisnya).
//   Bila status hasil akhir "terjadwal", sendAt hasil akhir harus masa depan.
//   Pause BUKAN lewat sini (lihat route.ts: settings key queue_paused).
// DELETE -> SOFT DELETE: set status "dibatalkan", baris TIDAK dihapus.

import { getDb } from "../../../../lib/db";
import { z } from "zod";


type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function mapScheduleRow(row: Row): Record<string, unknown> {
  return {
    id: asString(row.id),
    chatJid: asString(row.chat_jid),
    body: asString(row.isi),
    sendAt: asNumber(row.waktu_kirim),
    status: asString(row.status),
    attempts: asNumber(row.percobaan),
    lastError: row.error_terakhir == null ? null : asString(row.error_terakhir),
  };
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

const patchBodySchema = z
  .object({
    body: z.string().min(1, "body wajib diisi").optional(),
    sendAt: z.number().int("sendAt harus epoch ms (bilangan bulat)").optional(),
    status: z.enum(["draf", "terjadwal", "dibatalkan"]).optional(),
  })
  .refine((data) => data.body !== undefined || data.sendAt !== undefined || data.status !== undefined, {
    message: "Minimal satu dari body, sendAt, atau status harus diisi.",
  });

async function fetchSchedule(id: string): Promise<Row | undefined> {
  const { db } = await getDb();
  const result = await db.$client.execute(
    "SELECT id, chat_jid, isi, waktu_kirim, status, percobaan, error_terakhir FROM schedules WHERE id = ?",
    [id],
  );
  return result.rows[0] as Row | undefined;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { db } = await getDb();
    const { id } = await context.params;
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return jsonError("Body JSON tidak valid.", 400);
    }
    const body = patchBodySchema.safeParse(parsedBody);
    if (!body.success) {
      return jsonError(`Input tidak valid: ${body.error.issues[0]?.message ?? "body"}`, 400);
    }
    const existing = await fetchSchedule(id);
    if (!existing) return jsonError("Jadwal tidak ditemukan.", 404);
    const nextBody = body.data.body ?? asString(existing.isi);
    const nextSendAt = body.data.sendAt ?? asNumber(existing.waktu_kirim);
    const nextStatus = body.data.status ?? asString(existing.status);
    if (nextStatus === "terjadwal" && nextSendAt <= Date.now()) {
      return jsonError(
        "sendAt harus di masa depan untuk jadwal berstatus terjadwal (pakai status draf bila waktunya belum pasti).",
        400,
      );
    }
    await db.$client.execute(
      "UPDATE schedules SET isi = ?, waktu_kirim = ?, status = ? WHERE id = ?",
      [nextBody, nextSendAt, nextStatus, id],
    );
    const updated = await fetchSchedule(id);
    if (!updated) return jsonError("Jadwal tidak ditemukan.", 404);
    return Response.json({ schedule: mapScheduleRow(updated) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { db } = await getDb();
    const { id } = await context.params;
    // Soft delete: batalkan, jangan hapus baris (riwayat + audit tetap ada).
    const updated = await db.$client.execute(
      "UPDATE schedules SET status = 'dibatalkan' WHERE id = ?",
      [id],
    );
    if (updated.rowsAffected === 0) {
      return jsonError("Jadwal tidak ditemukan.", 404);
    }
    const row = await fetchSchedule(id);
    if (!row) return jsonError("Jadwal tidak ditemukan.", 404);
    return Response.json({ schedule: mapScheduleRow(row) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}
