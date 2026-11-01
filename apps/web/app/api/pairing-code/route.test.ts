import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Test proxy /api/pairing-code -> engine POST /pairing-code.
// Fetch global di-stub; tidak ada koneksi engine sungguhan.
const ENGINE = "http://127.0.0.1:3101";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/pairing-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.WA_ENGINE_URL = ENGINE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WA_ENGINE_URL;
});

describe("POST /api/pairing-code", () => {
  it("sukses: teruskan kode engine apa adanya", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { code: "12345678", phone: "628123456789", state: "pairing" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(postReq({ phone: "+62 812-3456-789" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      code: "12345678",
      phone: "628123456789",
      state: "pairing",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${ENGINE}/pairing-code`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("engine 409 -> 409 dengan error engine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, { error: "already_connected" }),
    ));
    const res = await POST(postReq({ phone: "628123456789" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_connected" });
  });

  it("engine tidak bisa dihubungi -> 503, tanpa kode palsu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("conn refused");
    }));
    const res = await POST(postReq({ phone: "628123456789" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "engine_unreachable" });
  });

  it("phone kosong -> 400 tanpa memanggil engine", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(postReq({ phone: "" }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("engine tidak terkonfigurasi -> 503", async () => {
    delete process.env.WA_ENGINE_URL;
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(postReq({ phone: "628123456789" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "engine_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
