import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../../packages/db/src/schema";
import { ensureSchema, openDatabase } from "../../../packages/db/src/index";
import {
  MEDIA_PLACEHOLDER,
  saveOutgoingMessage,
  syncIncomingMessage,
} from "../src/sync";

// DB temp (bukan data/wa-tools.db). ensureSchema diimpor dari source
// packages/db agar tidak bergantung pada dist yang sudah di-rebuild;
// sync menerima koneksi temp via parameter target.
function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-sync-"));
  return openDatabase(`file:${path.join(dir, "test.db")}`);
}

type TempDb = ReturnType<typeof openTempDb>;
let tempDb: TempDb;

beforeAll(async () => {
  tempDb = openTempDb();
  await ensureSchema(tempDb);
});

afterAll(async () => {
  // @ts-expect-error $client hanya ada di drizzle libsql
  await tempDb.$client.close();
});

describe("sync pesan masuk", () => {
  it("menulis contacts, chats, messages + unread naik", async () => {
    await syncIncomingMessage(
      {
        id: "sync-1",
        chatJid: "62812@s.whatsapp.net",
        senderJid: "62812@s.whatsapp.net",
        senderName: "Budi",
        fromMe: false,
        type: "teks",
        text: "halo bos",
        timestamp: 1700000000000,
      },
      tempDb,
    );
    const contacts = await tempDb.select().from(schema.contacts);
    expect(contacts.find((c) => c.jid === "62812@s.whatsapp.net")).toMatchObject({
      name: "Budi",
    });
    const chats = await tempDb.select().from(schema.chats);
    expect(
      chats.find((c) => c.jid === "62812@s.whatsapp.net"),
    ).toMatchObject({ title: "Budi", type: "pribadi", unreadCount: 1 });
    const msgs = await tempDb.select().from(schema.messages);
    expect(msgs.find((m) => m.id === "sync-1")).toMatchObject({
      direction: "masuk",
      text: "halo bos",
      type: "teks",
    });
  });

  it("pesan media -> placeholder, tanpa download (SPEC §4 PARKIR)", async () => {
    await syncIncomingMessage(
      {
        id: "sync-media-1",
        chatJid: "62812@s.whatsapp.net",
        senderJid: "62812@s.whatsapp.net",
        fromMe: false,
        type: "gambar",
        caption: "lihat ini",
        timestamp: 1700000001000,
      },
      tempDb,
    );
    const msgs = await tempDb.select().from(schema.messages);
    expect(msgs.find((m) => m.id === "sync-media-1")).toMatchObject({
      type: "gambar",
      text: MEDIA_PLACEHOLDER,
      caption: "lihat ini",
    });
  });

  it("id pesan sama tidak terduplikasi", async () => {
    const msg = {
      id: "sync-dup-1",
      chatJid: "62899@s.whatsapp.net",
      senderJid: "62899@s.whatsapp.net",
      fromMe: false,
      type: "teks",
      text: "sekali saja",
      timestamp: 1700000002000,
    };
    await syncIncomingMessage(msg, tempDb);
    await syncIncomingMessage(msg, tempDb);
    const msgs = await tempDb.select().from(schema.messages);
    expect(msgs.filter((m) => m.id === "sync-dup-1")).toHaveLength(1);
  });

  it("pesan keluar tidak menaikkan unread", async () => {
    await saveOutgoingMessage(
      {
        id: "sync-out-1",
        chatJid: "62812@s.whatsapp.net",
        senderJid: "me",
        text: "siap bos",
      },
      tempDb,
    );
    const msgs = await tempDb.select().from(schema.messages);
    expect(msgs.find((m) => m.id === "sync-out-1")).toMatchObject({
      direction: "keluar",
      text: "siap bos",
    });
    const chats = await tempDb.select().from(schema.chats);
    const chat = chats.find((c) => c.jid === "62812@s.whatsapp.net");
    // unread tetap 2 (dari 2 pesan masuk sebelumnya), tidak +1.
    expect(chat?.unreadCount).toBe(2);
  });
});
