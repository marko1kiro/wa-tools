import { describe, expect, it } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import {
  BaileysTransport,
  baileysMessageToIncoming,
  MockTransport,
} from "../src/transport";

describe("MockTransport state machine", () => {
  it("mulai idle, tidak connected, kirim gagal tertutup", async () => {
    const t = new MockTransport();
    expect(t.getState()).toBe("idle");
    expect(t.isConnected()).toBe(false);
    await expect(t.sendMessage("62812@s.whatsapp.net", "halo")).rejects.toThrow(
      /not_connected/,
    );
    expect(t.sent).toHaveLength(0);
  });

  it("connect -> connected -> kirim tercatat -> disconnect", async () => {
    const t = new MockTransport();
    await t.connect();
    expect(t.getState()).toBe("connected");
    expect(t.isConnected()).toBe(true);
    const sent = await t.sendMessage("62812@s.whatsapp.net", "halo");
    expect(sent.id).toBe("mock-1");
    expect(t.sent).toEqual([
      { jid: "62812@s.whatsapp.net", text: "halo", id: "mock-1" },
    ]);
    await t.disconnect();
    expect(t.getState()).toBe("disconnected");
    expect(t.isConnected()).toBe(false);
    await expect(t.sendMessage("62812@s.whatsapp.net", "x")).rejects.toThrow(
      /not_connected/,
    );
  });

  it("simulateIncoming meneruskan pesan ke handler", async () => {
    const t = new MockTransport();
    const received: unknown[] = [];
    t.onMessage((m) => received.push(m));
    t.simulateIncoming({
      id: "msg-1",
      chatJid: "62812@s.whatsapp.net",
      senderJid: "62812@s.whatsapp.net",
      fromMe: false,
      type: "teks",
      text: "hai",
      timestamp: 1700000000000,
    });
    expect(received).toHaveLength(1);
  });
});

describe("BaileysTransport", () => {
  it("constructor TIDAK auto-connect (tanpa jaringan, tanpa auth)", () => {
    const t = new BaileysTransport({ authDir: "/tmp/wa-engine-test-auth" });
    expect(t.getState()).toBe("idle");
    expect(t.isConnected()).toBe(false);
    expect(t.getQr()).toBeNull();
    expect(t.getPhone()).toBeNull();
  });
});

describe("baileysMessageToIncoming", () => {
  it("mengekstrak teks + timestamp detik -> ms", () => {
    const msg = {
      key: { remoteJid: "62812@s.whatsapp.net", id: "wamid-1" },
      pushName: "Budi",
      messageTimestamp: 1700000000,
      message: { conversation: "halo" },
    } as unknown as WAMessage;
    const out = baileysMessageToIncoming(msg);
    expect(out).toMatchObject({
      id: "wamid-1",
      chatJid: "62812@s.whatsapp.net",
      senderJid: "62812@s.whatsapp.net",
      senderName: "Budi",
      fromMe: false,
      type: "teks",
      text: "halo",
      timestamp: 1700000000000,
    });
  });

  it("mendeteksi media gambar + grup", () => {
    const msg = {
      key: {
        remoteJid: "120207@g.us",
        participant: "62812@s.whatsapp.net",
        id: "wamid-2",
      },
      messageTimestamp: 1700000000,
      message: { imageMessage: { caption: "lihat ini" } },
    } as unknown as WAMessage;
    const out = baileysMessageToIncoming(msg);
    expect(out?.type).toBe("gambar");
    expect(out?.caption).toBe("lihat ini");
    expect(out?.senderJid).toBe("62812@s.whatsapp.net");
  });

  it("mengembalikan null bila remoteJid/id hilang", () => {
    const msg = {
      key: {},
      message: { conversation: "x" },
    } as unknown as WAMessage;
    expect(baileysMessageToIncoming(msg)).toBeNull();
  });
});
