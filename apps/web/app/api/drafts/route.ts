// API draf balasan AI (SPEC §3.4, §2.4).
//
// POST {chatJid} -> baca maks 30 pesan terakhir chat, panggil AI 3x
//   (satu per nada: formal/santai/tegas), simpan 3 draf berstatus
//   "menunggu review", kembalikan ketiganya.
// GET ?status= -> daftar draf (filter status opsional).
//
// ATURAN KERAS: endpoint ini TIDAK PERNAH mengirim pesan WhatsApp.
// Output AI selalu draf; pengiriman hanya terjadi lewat aksi manual user
// (tombol "Pakai draf" mengisi composer, bukan mengirim) dan lewat
// antrean jadwal yang sudah direview.
//
// Akses DB lewat getDb() (lib/db.ts): import dinamis runtime-only
// supaya bundel webpack tidak menarik binding native libSQL; getDb()
// juga memastikan skema sudah ada.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../../lib/db";
import {
  DRAFT_TONES,
  formatChatContext,
  generateDraftReply,
  getGatewayConfig,
  type DraftTone,
} from "../../../lib/ai";


const DRAFT_STATUSES = ["menunggu review", "dipakai", "dibuang"] as const;

const postBodySchema = z.object({
  chatJid: z.string().min(1, "chatJid wajib diisi"),
});

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

interface DraftJson {
  id: string;
  chatJid: string;
  tone: DraftTone;
  body: string;
  source: string;
  status: string;
}

function mapDraftRow(row: Row): DraftJson {
  return {
    id: asString(row.id),
    chatJid: asString(row.chat_jid),
    tone: asString(row.nada) as DraftTone,
    body: asString(row.isi),
    source: asString(row.sumber),
    status: asString(row.status),
  };
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
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
      return jsonError(`Input tidak valid: ${body.error.issues[0]?.message ?? "chatJid"}`, 400);
    }
    const { chatJid } = body.data;

    // Maks 30 pesan terakhir, lalu dibalik ke urutan kronologis untuk konteks.
    const messagesResult = await db.$client.execute(
      "SELECT pengirim_jid, arah, tipe, teks, caption, timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 30",
      [chatJid],
    );
    const chronological = [...messagesResult.rows].reverse();
    if (chronological.length === 0) {
      return jsonError(
        "Chat belum memiliki pesan untuk dijadikan konteks draf balasan.",
        400,
      );
    }
    const contextText = formatChatContext(
      chronological.map((row) => {
        const text = asString(row.teks) || asString(row.caption);
        return {
          direction: asString(row.arah),
          senderJid: asString(row.pengirim_jid),
          text: text === "" ? "[media belum didukung]" : text,
        };
      }),
    );

    // Generate dulu SEMUA nada; kalau satu gagal, tidak ada draf yang
    // disimpan (fail-closed, bukan 2 draf + 1 error diam-diam).
    const config = await getGatewayConfig();
    const replies = [];
    for (const tone of DRAFT_TONES) {
      replies.push(await generateDraftReply(tone, contextText, config));
    }

    const placeholders = replies.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const args: string[] = [];
    const drafts: DraftJson[] = replies.map((reply) => {
      const draft: DraftJson = {
        id: randomUUID(),
        chatJid,
        tone: reply.tone,
        body: reply.body,
        source: reply.source,
        status: "menunggu review",
      };
      args.push(draft.id, draft.chatJid, draft.tone, draft.body, draft.source, draft.status);
      return draft;
    });
    await db.$client.execute(
      `INSERT INTO drafts (id, chat_jid, nada, isi, sumber, status) VALUES ${placeholders}`,
      args,
    );
    return Response.json({ drafts }, { status: 201 });
  } catch (error) {
    // AiGatewayError dari lib/ai sudah membawa pesan yang jelas; teruskan
    // sebagai 502 (gateway hulu gagal), bukan 500 generik.
    const message = error instanceof Error ? error.message : String(error);
    const isGateway = error instanceof Error && error.name === "AiGatewayError";
    return jsonError(message, isGateway ? 502 : 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { db } = await getDb();
    const status = new URL(request.url).searchParams.get("status");
    if (status !== null && !(DRAFT_STATUSES as readonly string[]).includes(status)) {
      return jsonError(
        `Status tidak valid. Yang sah: ${DRAFT_STATUSES.join(", ")}.`,
        400,
      );
    }
    const result = await db.$client.execute(
      status === null
        ? "SELECT id, chat_jid, nada, isi, sumber, status FROM drafts ORDER BY rowid DESC LIMIT 200"
        : "SELECT id, chat_jid, nada, isi, sumber, status FROM drafts WHERE status = ? ORDER BY rowid DESC LIMIT 200",
      status === null ? [] : [status],
    );
    return Response.json({
      drafts: (result.rows as Row[]).map(mapDraftRow),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}
