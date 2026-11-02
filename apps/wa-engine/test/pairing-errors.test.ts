import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, openDatabase } from "../../../packages/db/src/index";
import {
  baileysErrorDetail,
  createEngineServer,
  type EngineServerHandle,
} from "../src/server";
import type { EngineState } from "../src/transport";

// Test detail error /pairing-code (perbaikan Bug 3+4, SPEC §3.1).
// Transport stub yang melempar error spesifik; TIDAK PERNAH menyentuh
// WhatsApp sungguhan.
let handle: EngineServerHandle;
let base: string;
let tempDb: ReturnType<typeof openDatabase>;
let throwBehavior: "socket_not_ready" | "baileys_500" | "plain" = "plain";

const stubTransport = {
  isConnected: () => false,
  sendMessage: async () => ({ id: "x" }),
  getState: (): EngineState => "idle",
  getQr: () => null,
  getPhone: () => null,
  onMessage: () => {},
  requestPairingCode: async (_phone: string): Promise<string> => {
    if (throwBehavior === "socket_not_ready") {
      throw new Error("socket_not_ready");
    }
    if (throwBehavior === "baileys_500") {
      const err = new Error("Connection closed") as Error & {
        output?: { statusCode?: number };
      };
      err.output = { statusCode: 500 };
      throw err;
    }
    throw new Error("boom");
  },
};

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
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wa-pairing-err-"));
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

describe("baileysErrorDetail", () => {
  it("gabung pesan + statusCode, potong 300 karakter", () => {
    const err = new Error("Connection closed") as Error & {
      output?: { statusCode?: number };
    };
    err.output = { statusCode: 500 };
    expect(baileysErrorDetail(err)).toBe("Connection closed (status 500)");
    expect(baileysErrorDetail(new Error("boom"))).toBe("boom");
    expect(baileysErrorDetail(new Error("x".repeat(500)))).toHaveLength(300);
  });
});

describe("POST /pairing-code error detail", () => {
  it("socket_not_ready -> 502 dengan error + detail sendiri (bukan pairing_failed generik)", async () => {
    throwBehavior = "socket_not_ready";
    const r = await req("POST", "/pairing-code", { phone: "628123456789" });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("socket_not_ready");
    expect(typeof r.json.detail).toBe("string");
    expect((r.json.detail as string).length).toBeGreaterThan(0);
  });

  it("error Baileys lain -> 502 pairing_failed + detail berisi pesan dan status", async () => {
    throwBehavior = "baileys_500";
    const r = await req("POST", "/pairing-code", { phone: "628123456789" });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("pairing_failed");
    expect(r.json.detail).toBe("Connection closed (status 500)");
  });

  it("guard already_connected tetap 409 tanpa detail palsu", async () => {
    throwBehavior = "plain";
    const r = await req("POST", "/pairing-code", { phone: "628123456789" });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ error: "pairing_failed", detail: "boom" });
  });
});
