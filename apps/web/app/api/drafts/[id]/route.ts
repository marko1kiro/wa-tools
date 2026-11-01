// PATCH /api/drafts/[id] — ubah status draf hasil review user.
// Hanya dua status akhir yang sah: "dipakai" (mengisi composer, BUKAN
// mengirim) dan "dibuang". Endpoint ini TIDAK PERNAH mengirim pesan.

import { z } from "zod";
import { getDb } from "../../../../lib/db";
import type { DraftTone } from "../../../../lib/ai";

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

const patchBodySchema = z.object({
  status: z.enum(["dipakai", "dibuang"]),
});

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
      return jsonError(
        `Input tidak valid: ${body.error.issues[0]?.message ?? "status"}. Status yang sah: dipakai, dibuang.`,
        400,
      );
    }
    const updated = await db.$client.execute("UPDATE drafts SET status = ? WHERE id = ?", [
      body.data.status,
      id,
    ]);
    if (updated.rowsAffected === 0) {
      return jsonError("Draf tidak ditemukan.", 404);
    }
    const result = await db.$client.execute(
      "SELECT id, chat_jid, nada, isi, sumber, status FROM drafts WHERE id = ?",
      [id],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return jsonError("Draf tidak ditemukan.", 404);
    return Response.json({
      draft: {
        id: asString(row.id),
        chatJid: asString(row.chat_jid),
        tone: asString(row.nada) as DraftTone,
        body: asString(row.isi),
        source: asString(row.sumber),
        status: asString(row.status),
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}
