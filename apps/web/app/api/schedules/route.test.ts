// Test handler jadwal. DB di-mock penuh lewat @wa-tools/db.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  schedulesList: [] as Array<Record<string, unknown>>,
  scheduleById: undefined as Record<string, unknown> | undefined,
  updateAffected: 1,
  insertedSchedules: [] as unknown[][],
  executedSql: [] as string[],
  ensureSchema: vi.fn(async () => {}),
}));

vi.mock("@wa-tools/db", () => ({
  db: {
    $client: {
      execute: vi.fn(async (sql: string, args: unknown[] = []) => {
        mockState.executedSql.push(sql);
        if (sql.startsWith("INSERT INTO schedules")) {
          mockState.insertedSchedules.push([...args]);
          return { rows: [], rowsAffected: 1 };
        }
        if (sql.startsWith("UPDATE schedules")) {
          return { rows: [], rowsAffected: mockState.updateAffected };
        }
        if (sql.includes("FROM schedules")) {
          if (sql.includes("WHERE id")) {
            return {
              rows: mockState.scheduleById ? [mockState.scheduleById] : [],
              rowsAffected: 0,
            };
          }
          return { rows: mockState.schedulesList, rowsAffected: 0 };
        }
        throw new Error(`SQL tak terduga di test: ${sql}`);
      }),
    },
  },
  ensureSchema: mockState.ensureSchema,
}));

import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[id]/route";

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 3_600_000;

beforeEach(() => {
  mockState.schedulesList = [];
  mockState.scheduleById = undefined;
  mockState.updateAffected = 1;
  mockState.insertedSchedules = [];
  mockState.executedSql = [];
  mockState.ensureSchema.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/schedules", () => {
  it("jadwal masa depan -> 201 berstatus terjadwal", async () => {
    const res = await POST(
      jsonReq("http://localhost/api/schedules", "POST", {
        chatJid: "62812@s.whatsapp.net",
        body: "halo",
        sendAt: FUTURE,
      }),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { schedule: Record<string, unknown> };
    expect(data.schedule.status).toBe("terjadwal");
    expect(data.schedule.sendAt).toBe(FUTURE);
    expect(mockState.insertedSchedules).toHaveLength(1);
    expect(mockState.ensureSchema).toHaveBeenCalled();
  });

  it("sendAt lampau + terjadwal -> 400, tidak tersimpan", async () => {
    const res = await POST(
      jsonReq("http://localhost/api/schedules", "POST", {
        chatJid: "c1",
        body: "halo",
        sendAt: PAST,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockState.insertedSchedules).toHaveLength(0);
  });

  it("sendAt lampau + status draf -> 201 (draf boleh belum pasti waktunya)", async () => {
    const res = await POST(
      jsonReq("http://localhost/api/schedules", "POST", {
        chatJid: "c1",
        body: "halo",
        sendAt: PAST,
        status: "draf",
      }),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { schedule: Record<string, unknown> };
    expect(data.schedule.status).toBe("draf");
  });

  it("body kosong / chatJid kosong -> 400", async () => {
    const res = await POST(
      jsonReq("http://localhost/api/schedules", "POST", { chatJid: "c1", body: "", sendAt: FUTURE }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/schedules", () => {
  it("daftar + filter status; status tak dikenal -> 400", async () => {
    mockState.schedulesList = [
      { id: "s1", chat_jid: "c1", isi: "halo", waktu_kirim: FUTURE, status: "terjadwal", percobaan: 0, error_terakhir: null },
    ];
    const res = await GET(new Request("http://localhost/api/schedules?status=terjadwal"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { schedules: Array<Record<string, unknown>> };
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules[0]).toMatchObject({ id: "s1", sendAt: FUTURE, attempts: 0, lastError: null });
    const bad = await GET(new Request("http://localhost/api/schedules?status=ngaco"));
    expect(bad.status).toBe(400);
  });
});

describe("PATCH /api/schedules/[id]", () => {
  beforeEach(() => {
    mockState.scheduleById = {
      id: "s1",
      chat_jid: "c1",
      isi: "lama",
      waktu_kirim: FUTURE,
      status: "terjadwal",
      percobaan: 0,
      error_terakhir: null,
    };
  });

  it("ubah body + sendAt -> 200", async () => {
    const res = await PATCH(
      jsonReq("http://localhost/api/schedules/s1", "PATCH", { body: "baru", sendAt: FUTURE + 1000 }),
      { params: Promise.resolve({ id: "s1" }) },
    );
    expect(res.status).toBe(200);
    const updateSql = mockState.executedSql.find((sql) => sql.startsWith("UPDATE schedules"));
    expect(updateSql).toContain("SET isi = ?, waktu_kirim = ?, status = ?");
  });

  it("batalkan lewat status dibatalkan -> 200", async () => {
    const res = await PATCH(jsonReq("http://localhost/api/schedules/s1", "PATCH", { status: "dibatalkan" }), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(200);
  });

  it("status terkirim/gagal lewat PATCH -> 400 (hanya antrean kirim yang boleh)", async () => {
    for (const status of ["terkirim", "gagal"]) {
      const res = await PATCH(jsonReq("http://localhost/api/schedules/s1", "PATCH", { status }), {
        params: Promise.resolve({ id: "s1" }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("hasil akhir terjadwal tapi sendAt lampau -> 400", async () => {
    const res = await PATCH(jsonReq("http://localhost/api/schedules/s1", "PATCH", { sendAt: PAST }), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(400);
  });

  it("id tak dikenal -> 404", async () => {
    mockState.scheduleById = undefined;
    const res = await PATCH(jsonReq("http://localhost/api/schedules/nope", "PATCH", { body: "x" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/schedules/[id]", () => {
  it("soft delete: UPDATE ke dibatalkan, TIDAK ADA statement DELETE", async () => {
    mockState.scheduleById = {
      id: "s1",
      chat_jid: "c1",
      isi: "halo",
      waktu_kirim: FUTURE,
      status: "dibatalkan",
      percobaan: 0,
      error_terakhir: null,
    };
    const res = await DELETE(jsonReq("http://localhost/api/schedules/s1", "DELETE"), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { schedule: Record<string, unknown> };
    expect(data.schedule.status).toBe("dibatalkan");
    expect(mockState.executedSql.some((sql) => sql.startsWith("DELETE FROM"))).toBe(false);
    expect(
      mockState.executedSql.some((sql) => sql.includes("SET status = 'dibatalkan'")),
    ).toBe(true);
  });

  it("id tak dikenal -> 404", async () => {
    mockState.updateAffected = 0;
    const res = await DELETE(jsonReq("http://localhost/api/schedules/nope", "DELETE"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
