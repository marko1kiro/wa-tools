import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../../packages/db/src/schema";
import { ensureSchema, openDatabase } from "../../../packages/db/src/index";
import { createEngineServer, type EngineServerHandle } from "../src/server";
import { MockTransport } from "../src/transport";

// Test endpoint HTTP di port ephemeral, transport MOCK, DB temp.
// TIDAK PERNAH menyentuh WhatsApp sungguhan.
let handle: EngineServerHandle;
let base: string;
let transport: MockTransport;
let tempDb: ReturnType<typeof openTempDb>;

function openTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-server-"));
  return openDatabase(`file:${path.join(dir, "test.db")}`);
}

async function req(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function pollForMessage(id: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const rows = await tempDb.select().from(schema.messages);
    if (rows.some((m) => m.id === id)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

beforeAll(async () => {
  tempDb = openTempDb();
  await ensureSchema(tempDb);
  transport = new MockTransport();
  handle = createEngineServer({ transport, mock: true, db: tempDb });
  await new Promise<void>((resolve) => {
    handle.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = handle.server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
  });
  // @ts-expect-error $client hanya ada di drizzle libsql
  await tempDb.$client.close();
});

describe("endpoint wa-engine (mock)", () => {
  it("GET /health OK", async () => {
    const r = await req("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, service: "wa-engine" });
  });

  it("GET /status awal: idle, mock, queuePaused fail-closed", async () => {
    const r = await req("GET", "/status");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      state: "idle",
      connected: false,
      mock: true,
      queuePaused: true,
    });
  });

  it("POST /send sebelum connected -> 503, tanpa sukses palsu", async () => {
    const r = await req("POST", "/send", {
      jid: "62812@s.whatsapp.net",
      body: "halo",
    });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ error: "not_connected" });
    expect(transport.sent).toHaveLength(0);
  });

  it("POST /start -> connected; /qr tanpa QR -> 404 no_qr (bukan JSON pura-pura gambar)", async () => {
    const start = await req("POST", "/start");
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ state: "connected", connected: true });
    const qr = await req("GET", "/qr");
    expect(qr.status).toBe(404);
    expect(qr.json).toMatchObject({ error: "no_qr" });
    const status = await req("GET", "/status");
    expect(status.json).toMatchObject({ queuePaused: false });
  });

  it("POST /send saat connected -> 200 + tersimpan arah keluar", async () => {
    const r = await req("POST", "/send", {
      jid: "62812@s.whatsapp.net",
      body: "siap bos",
    });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe("mock-1");
    const rows = await tempDb.select().from(schema.messages);
    expect(rows.find((m) => m.id === "mock-1")).toMatchObject({
      chatJid: "62812@s.whatsapp.net",
      direction: "keluar",
      text: "siap bos",
    });
  });

  it("POST /send body invalid -> 400", async () => {
    const r = await req("POST", "/send", { jid: "62812@s.whatsapp.net" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "validation_failed" });
  });

  it("pesan masuk via mock tersinkron ke DB (autoSync)", async () => {
    transport.simulateIncoming({
      id: "srv-in-1",
      chatJid: "62812@s.whatsapp.net",
      senderJid: "62812@s.whatsapp.net",
      senderName: "Budi",
      fromMe: false,
      type: "teks",
      text: "balasan",
      timestamp: 1700000003000,
    });
    expect(await pollForMessage("srv-in-1")).toBe(true);
  });

  it("POST /stop -> disconnected; /send kembali 503", async () => {
    const stop = await req("POST", "/stop");
    expect(stop.status).toBe(200);
    expect(stop.json).toMatchObject({
      state: "disconnected",
      connected: false,
      queuePaused: true,
    });
    const r = await req("POST", "/send", {
      jid: "62812@s.whatsapp.net",
      body: "x",
    });
    expect(r.status).toBe(503);
  });

  it("route tak dikenal -> 404", async () => {
    const r = await req("GET", "/tidak-ada");
    expect(r.status).toBe(404);
  });
});
