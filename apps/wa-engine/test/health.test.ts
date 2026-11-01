import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, openDatabase } from "../../../packages/db/src/index";
import { createEngineServer, type EngineServerHandle } from "../src/server";
import { MockTransport } from "../src/transport";

// Test GET /health yang diperkaya (SPEC §13.2) + bookkeeping
// disconnect transport. Server di port ephemeral, transport MOCK,
// DB temp. TIDAK PERNAH menyentuh WhatsApp sungguhan.
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
  const dir = mkdtempSync(path.join(tmpdir(), "wa-health-"));
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

describe("GET /health (SPEC §13.2)", () => {
  it("awal: ok + idle + uptime angka + startedAt ISO + lastDisconnect null", async () => {
    const r = await req("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      service: "wa-engine",
      state: "idle",
      connected: false,
      mock: true,
    });
    expect(typeof r.json.uptimeSeconds).toBe("number");
    expect(r.json.uptimeSeconds as number).toBeGreaterThanOrEqual(0);
    expect(Date.parse(r.json.startedAt as string)).not.toBeNaN();
    expect(r.json.lastDisconnectAt).toBeNull();
  });

  it("setelah connect: connected + watchdog bersenjata", async () => {
    await req("POST", "/start");
    const r = await req("GET", "/health");
    expect(r.json).toMatchObject({ state: "connected", connected: true });
    expect(transport.isWatchdogArmed()).toBe(true);
  });

  it("putus tak terduga: state disconnected + lastDisconnect terisi + watchdog tetap bersenjata", async () => {
    transport.simulateUnexpectedDisconnect();
    const r = await req("GET", "/health");
    expect(r.json).toMatchObject({ state: "disconnected", connected: false });
    expect(r.json.lastDisconnectAt).not.toBeNull();
    expect(Date.parse(r.json.lastDisconnectAt as string)).not.toBeNaN();
    expect(transport.getLastDisconnectAt()).not.toBeNull();
    expect(transport.isWatchdogArmed()).toBe(true);
  });

  it("stop manual: lastDisconnect tetap terisi tapi watchdog dilucuti", async () => {
    await req("POST", "/stop");
    const r = await req("GET", "/health");
    expect(r.json).toMatchObject({ state: "disconnected", connected: false });
    expect(r.json.lastDisconnectAt).not.toBeNull();
    expect(transport.isWatchdogArmed()).toBe(false);
  });
});
