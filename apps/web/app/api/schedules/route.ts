// API pesan terjadwal (SPEC §3.3).
//
// GET ?status= -> daftar jadwal (filter status opsional).
// POST {chatJid, body, sendAt, status?} -> status default "terjadwal".
//   sendAt (epoch ms) HARUS di masa depan, kecuali status "draf".
//
// Pause TIDAK diimplementasi di sini: pause adalah settings key
// `queue_paused` yang dibaca antrean kirim (apps/wa-engine/src/queue.ts),
// bukan status jadwal — supaya pause berlaku global, bukan per jadwal.
// Status "terkirim"/"gagal" hanya ditulis antrean kirim, bukan API ini.
//
// Akses DB lewat getDb() (lib/db.ts): import dinamis runtime-only
// supaya bundel webpack tidak menarik binding native libSQL; getDb()
// juga memastikan skema sudah ada.

import { randomUUID } from "node:crypto";
import { getDb } from "../../../lib/db";
import { z } from "zod";


const SCHEDULE_STATUSES = ["draf", "terjadwal", "terkirim", "gagal", "dibatalkan"] as const;

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

const postBodySchema = z.object({
  chatJid: z.string().min(1, "chatJid wajib diisi"),
  body: z.string().min(1, "body wajib diisi"),
  sendAt: z.number().int("sendAt harus epoch ms (bilangan bulat)"),
  status: z.enum(["draf", "terjadwal"]).optional().default("terjadwal"),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const { db } = await getDb();
    const status = new URL(request.url).searchParams.get("status");
    if (status !== null && !(SCHEDULE_STATUSES as readonly string[]).includes(status)) {
      return jsonError(
        `Status tidak valid. Yang sah: ${SCHEDULE_STATUSES.join(", ")}.`,
        400,
      );
    }
    const result = await db.$client.execute(
      status === null
        ? "SELECT id, chat_jid, isi, waktu_kirim, status, percobaan, error_terakhir FROM schedules ORDER BY waktu_kirim ASC LIMIT 500"
        : "SELECT id, chat_jid, isi, waktu_kirim, status, percobaan, error_terakhir FROM schedules WHERE status = ? ORDER BY waktu_kirim ASC LIMIT 500",
      status === null ? [] : [status],
    );
    return Response.json({
      schedules: (result.rows as Row[]).map(mapScheduleRow),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { db } = await getDb();
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return jsonError("Body JSON tidak valid.", 400);
    }
    const body = postBodySchema.safeParse(parsedBody);
    if (!body.success) {
      return jsonError(`Input tidak valid: ${body.error.issues[0]?.message ?? "body"}`, 400);
    }
    const { chatJid, body: text, sendAt, status } = body.data;
    if (status === "terjadwal" && sendAt <= Date.now()) {
      return jsonError(
        "sendAt harus di masa depan untuk jadwal berstatus terjadwal (pakai status draf bila waktunya belum pasti).",
        400,
      );
    }
    const id = randomUUID();
    await db.$client.execute(
      "INSERT INTO schedules (id, chat_jid, isi, waktu_kirim, status, percobaan, error_terakhir) VALUES (?, ?, ?, ?, ?, 0, NULL)",
      [id, chatJid, text, sendAt, status],
    );
    return Response.json(
      {
        schedule: {
          id,
          chatJid,
          body: text,
          sendAt,
          status,
          attempts: 0,
          lastError: null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}
