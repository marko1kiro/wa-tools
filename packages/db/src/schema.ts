import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Model data sesuai SPEC §7 (Fase 1).
// Catatan: TIDAK ada tabel media di Fase 1 — media handler DIPARKIR
// (SPEC §4). Pesan media tampil sebagai placeholder sampai dibuka lagi.

export const contacts = sqliteTable("contacts", {
  jid: text("jid").primaryKey(),
  name: text("nama"),
  avatarPath: text("avatar_path"),
  lastSeen: integer("terakhir_terlihat"), // epoch ms, nullable
});

export const chats = sqliteTable("chats", {
  jid: text("jid").primaryKey(),
  title: text("judul").notNull(),
  type: text("tipe").notNull(), // 'pribadi' | 'grup'
  archived: integer("arsip").notNull().default(0),
  pinned: integer("pin").notNull().default(0),
  unreadCount: integer("unread_count").notNull().default(0),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatJid: text("chat_jid").notNull(),
    senderJid: text("pengirim_jid").notNull(),
    direction: text("arah").notNull(), // 'masuk' | 'keluar'
    type: text("tipe").notNull(), // teks/gambar/video/audio/dokumen/dll (Fase 1: placeholder media)
    text: text("teks"),
    caption: text("caption"),
    timestamp: integer("timestamp").notNull(), // epoch ms
    status: text("status").notNull(), // terkirim/dibaca/gagal
    replyTo: text("balasan_ke"),
  },
  (t) => [index("messages_chat_time_idx").on(t.chatJid, t.timestamp)],
);

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  chatJid: text("chat_jid").notNull(),
  body: text("isi").notNull(),
  sendAt: integer("waktu_kirim").notNull(), // epoch ms
  status: text("status").notNull(), // draf/terjadwal/terkirim/gagal/dibatalkan
  attempts: integer("percobaan").notNull().default(0),
  lastError: text("error_terakhir"),
});

export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey(),
  chatJid: text("chat_jid").notNull(),
  tone: text("nada").notNull(), // formal/santai/tegas
  body: text("isi").notNull(),
  source: text("sumber").notNull(), // model + prompt template
  status: text("status").notNull(), // menunggu review/dipakai/dibuang
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON string
});
