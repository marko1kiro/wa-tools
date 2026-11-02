import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, openDatabase } from "../../../packages/db/src/index";
import { createEngineServer, type EngineServerHandle } from "../src/server";
import type { EngineState } from "../src/transport";

// Test GET /qr sebagai PNG beneran (perbaikan Bug 1, SPEC §3.1).
// Transport stub dengan QR string mentah; server di port ephemeral.
// TIDAK PERNAH menyentuh WhatsApp sungguhan.
let handle: EngineServerHandle;
let base: string;
let tempDb: ReturnType<typeof openDatabase>;
let qrValue: string | null = "BAILEYS-QR-STRING-UNTUK-TEST";

const stubTransport = {
  isConnected: () => false,
  sendMessage: async () => ({ id: "x" }),
  getState: (): EngineState => "pairing",
  getQr: () => qrValue,
  getPhone: () => null,
  onMessage: () => {},
};

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-qr-"));
  tempDb = openDatabase(`file:${path.join(dir, "test.db")}`);
  await ensureSchema(tempDb);
  handle = createEngineServer({
    transport: stubTransport,
    mock: false,
    db: tempDb,
  });
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

describe("GET /qr (PNG)", () => {
  it("QR ada -> 200 image/png dengan signature PNG + no-store", async () => {
    qrValue = "BAILEYS-QR-STRING-UNTUK-TEST";
    const res = await fetch(`${base}/qr`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const buf = Buffer.from(await res.arrayBuffer());
    // Signature PNG: 89 50 4E 47 0D 0A 1A 0A.
    expect([...buf.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(buf.length).toBeGreaterThan(100);
  });

  it("QR tidak ada -> 404 no_qr (bukan gambar palsu)", async () => {
    qrValue = null;
    const res = await fetch(`${base}/qr`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no_qr" });
  });
});
