import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, openDatabase } from "../../../packages/db/src/index";
import {
  createEngineServer,
  normalizePairingPhone,
  type EngineServerHandle,
} from "../src/server";
import { MockTransport } from "../src/transport";

// Test fallback kode pairing (SPEC §3.1). Server di port ephemeral,
// transport MOCK, DB temp. TIDAK PERNAH menyentuh WhatsApp sungguhan;
// kode yang dikembalikan mock adalah 8 digit deterministik.
let handle: EngineServerHandle;
let base: string;
let transport: MockTransport;
let tempDb: ReturnType<typeof openDatabase>;

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

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-pairing-"));
  tempDb = openDatabase(`file:${path.join(dir, "test.db")}`);
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

describe("normalizePairingPhone", () => {
  it("buang +, spasi, strip, kurung", () => {
    expect(normalizePairingPhone("+62 812-3456-789")).toBe("628123456789");
    expect(normalizePairingPhone("(62) 812 345 678")).toBe("62812345678");
    expect(normalizePairingPhone("628123456789")).toBe("628123456789");
  });

  it("tolak huruf, terlalu pendek, terlalu panjang", () => {
    expect(normalizePairingPhone("abc")).toBeNull();
    expect(normalizePairingPhone("62812")).toBeNull();
    expect(normalizePairingPhone("62812345678901234")).toBeNull();
    expect(normalizePairingPhone("")).toBeNull();
  });
});

describe("POST /pairing-code (mock)", () => {
  it("nomor invalid -> 400 invalid_phone", async () => {
    const r = await req("POST", "/pairing-code", { phone: "abc" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "invalid_phone" });
  });

  it("body tanpa phone -> 400 validation_failed", async () => {
    const r = await req("POST", "/pairing-code", {});
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "validation_failed" });
  });

  it("nomor valid -> 200 kode 8 digit + state pairing", async () => {
    const r = await req("POST", "/pairing-code", { phone: "+62 812-3456-789" });
    expect(r.status).toBe(200);
    expect(r.json.phone).toBe("628123456789");
    expect(r.json.code).toMatch(/^\d{8}$/);
    expect(r.json.state).toBe("pairing");
    expect(transport.getState()).toBe("pairing");
  });

  it("minta kode baru -> kode BERBEDA (kedaluwarsa bisa diganti)", async () => {
    const first = await req("POST", "/pairing-code", { phone: "628123456789" });
    const second = await req("POST", "/pairing-code", { phone: "628123456789" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.code).not.toBe(first.json.code);
    expect(second.json.code).toMatch(/^\d{8}$/);
  });

  it("setelah pairing complete: connected, lalu /pairing-code -> 409", async () => {
    transport.simulatePairingComplete();
    const status = await req("GET", "/status");
    expect(status.json).toMatchObject({ state: "connected", connected: true });
    const r = await req("POST", "/pairing-code", { phone: "628123456789" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "already_connected" });
  });
});
