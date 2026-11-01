import { chats, contacts, db, eq, messages, sql } from "@wa-tools/db";
import type { IncomingMessage } from "./transport.js";

// Tipe koneksi DB struktural (typeof db) — sengaja tidak mengimpor
// tipe baru dari @wa-tools/db supaya typecheck engine tidak bergantung
// pada dist db yang sudah di-rebuild.
export type SyncDb = typeof db;

// Sinkronisasi pesan ke SQLite (SPEC §7).
//
// - Pesan MEDIA tidak di-download (media handler DIPARKIR, SPEC §4):
//   teks disimpan sebagai placeholder "[media belum didukung]",
//   caption asli (bila ada) tetap disimpan di kolom caption.
// - Idempotent per id pesan: pesan yang sama tidak terduplikasi.
// - Pesan masuk menaikkan unread_count chat; pesan keluar tidak.

// Placeholder persis seperti yang ditulis SPEC §7.
export const MEDIA_PLACEHOLDER = "[media belum didukung]";

export interface SyncMessage {
  id: string;
  chatJid: string;
  senderJid: string;
  senderName?: string;
  direction: "masuk" | "keluar";
  /** 'teks' | 'gambar' | 'video' | 'audio' | 'dokumen' | 'stiker' | 'lainnya' */
  type: string;
  text?: string;
  caption?: string;
  /** epoch ms */
  timestamp: number;
  replyTo?: string;
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** Konversi pesan transport -> bentuk yang disimpan sync. */
export function toSyncMessage(incoming: IncomingMessage): SyncMessage {
  const isMedia = incoming.type !== "teks";
  return {
    id: incoming.id,
    chatJid: incoming.chatJid,
    senderJid: incoming.senderJid,
    senderName: incoming.senderName,
    direction: incoming.fromMe ? "keluar" : "masuk",
    type: incoming.type,
    text: isMedia ? MEDIA_PLACEHOLDER : (incoming.text ?? ""),
    caption: isMedia ? incoming.caption : undefined,
    timestamp: incoming.timestamp,
  };
}

/**
 * Simpan satu pesan + upsert contact & chat-nya. `target` opsional
 * memungkinkan test memakai koneksi SQLite temp.
 */
export async function saveMessage(
  msg: SyncMessage,
  target: SyncDb = db,
): Promise<void> {
  const chatTitle = msg.senderName ?? msg.chatJid;

  await target
    .insert(contacts)
    .values({
      jid: msg.senderJid,
      name: msg.senderName ?? null,
      lastSeen: msg.timestamp,
    })
    .onConflictDoUpdate({
      target: contacts.jid,
      set: {
        ...(msg.senderName ? { name: msg.senderName } : {}),
        lastSeen: msg.timestamp,
      },
    });

  await target
    .insert(chats)
    .values({
      jid: msg.chatJid,
      title: chatTitle,
      type: isGroupJid(msg.chatJid) ? "grup" : "pribadi",
      // Chat baru dari pesan masuk langsung unread=1; pesan keluar 0.
      // (Jalur onConflictDoUpdate di bawah hanya jalan untuk chat lama.)
      unreadCount: msg.direction === "masuk" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: chats.jid,
      set: {
        title: chatTitle,
        ...(msg.direction === "masuk"
          ? { unreadCount: sql`${chats.unreadCount} + 1` }
          : {}),
      },
    });

  await target
    .insert(messages)
    .values({
      id: msg.id,
      chatJid: msg.chatJid,
      senderJid: msg.senderJid,
      direction: msg.direction,
      type: msg.type,
      text: msg.text ?? null,
      caption: msg.caption ?? null,
      timestamp: msg.timestamp,
      status: "terkirim",
      replyTo: msg.replyTo ?? null,
    })
    .onConflictDoNothing();
}

/** Sinkronisasi satu pesan MASUK dari transport ke SQLite. */
export async function syncIncomingMessage(
  incoming: IncomingMessage,
  target: SyncDb = db,
): Promise<void> {
  await saveMessage(toSyncMessage(incoming), target);
}

/** Simpan satu pesan KELUAR (dipakai endpoint POST /send). */
export async function saveOutgoingMessage(
  input: {
    id: string;
    chatJid: string;
    senderJid: string;
    text: string;
    timestamp?: number;
  },
  target: SyncDb = db,
): Promise<void> {
  await saveMessage(
    {
      id: input.id,
      chatJid: input.chatJid,
      senderJid: input.senderJid,
      direction: "keluar",
      type: "teks",
      text: input.text,
      timestamp: input.timestamp ?? Date.now(),
    },
    target,
  );
}

/** Helper baca untuk test / pemakaian lain: cari pesan berdasarkan id. */
export async function findMessageById(id: string, target: SyncDb = db) {
  const rows = await target
    .select()
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1);
  return rows[0] ?? null;
}
