// Test handler draf. Gateway TIDAK PERNAH dipanggil sungguhan (fetch
// di-stub); DB di-mock penuh lewat @wa-tools/db.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  settings: [] as Array<Record<string, unknown>>,
  draftsList: [] as Array<Record<string, unknown>>,
  draftById: undefined as Record<string, unknown> | undefined,
  updateAffected: 1,
  insertedDrafts: [] as unknown[][],
  executedSql: [] as string[],
  ensureSchema: vi.fn(async () => {}),
}));

vi.mock("@wa-tools/db", () => ({
  db: {
    $client: {
      execute: vi.fn(async (sql: string, args: unknown[] = []) => {
        mockState.executedSql.push(sql);
        if (sql.includes("FROM settings")) {
          return { rows: mockState.settings, rowsAffected: 0 };
        }
        if (sql.includes("FROM messages")) {
          return { rows: mockState.messages, rowsAffected: 0 };
        }
        if (sql.startsWith("INSERT INTO drafts")) {
          mockState.insertedDrafts = [];
          for (let i = 0; i < args.length; i += 6) {
            mockState.insertedDrafts.push(args.slice(i, i + 6));
          }
          return { rows: [], rowsAffected: mockState.insertedDrafts.length };
        }
        if (sql.startsWith("UPDATE drafts")) {
          return { rows: [], rowsAffected: mockState.updateAffected };
        }
        if (sql.includes("FROM drafts")) {
          if (sql.includes("WHERE id")) {
            return {
              rows: mockState.draftById ? [mockState.draftById] : [],
              rowsAffected: 0,
            };
          }
          return { rows: mockState.draftsList, rowsAffected: 0 };
        }
        throw new Error(`SQL tak terduga di test: ${sql}`);
      }),
    },
  },
  ensureSchema: mockState.ensureSchema,
}));

import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

function jsonReq(url: string, method: string, body: unknown): Request {
  return req(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function aiFetch(contents: string[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: contents[i++] ?? "" } }] }),
    text: async () => "",
  }) as Response);
}

beforeEach(() => {
  mockState.messages = [
    { pengirim_jid: "62812@s.whatsapp.net", arah: "masuk", tipe: "teks", teks: "halo, ready?", caption: null, timestamp: 100 },
    { pengirim_jid: "me", arah: "keluar", tipe: "teks", teks: "ready dong", caption: null, timestamp: 200 },
  ];
  mockState.settings = [
    { key: "ai_gateway_base_url", value: '"https://gw.test/v1"' },
    { key: "ai_model_draft", value: '"model-test"' },
  ];
  mockState.draftsList = [];
  mockState.draftById = undefined;
  mockState.updateAffected = 1;
  mockState.insertedDrafts = [];
  mockState.executedSql = [];
  mockState.ensureSchema.mockClear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/drafts", () => {
  it("menghasilkan 3 draf (formal/santai/tegas) berstatus menunggu review", async () => {
    vi.stubGlobal("fetch", aiFetch(["draf formal", "draf santai", "draf tegas"]));
    const res = await POST(jsonReq("http://localhost/api/drafts", "POST", { chatJid: "62812@s.whatsapp.net" }));
    expect(res.status).toBe(201);
    const data = (await res.json()) as { drafts: Array<Record<string, unknown>> };
    expect(data.drafts.map((d) => d.tone)).toEqual(["formal", "santai", "tegas"]);
    expect(data.drafts.map((d) => d.body)).toEqual(["draf formal", "draf santai", "draf tegas"]);
    expect(data.drafts.every((d) => d.status === "menunggu review")).toBe(true);
    expect(data.drafts.every((d) => d.source === "model-test:draft-" + String(d.tone))).toBe(true);
    expect(mockState.insertedDrafts).toHaveLength(3);
    expect(mockState.ensureSchema).toHaveBeenCalled();
  });

  it("TIDAK PERNAH mengirim pesan: hanya 3 panggilan AI, tanpa panggilan lain", async () => {
    const fetchMock = aiFetch(["a", "b", "c"]);
    vi.stubGlobal("fetch", fetchMock);
    await POST(jsonReq("http://localhost/api/drafts", "POST", { chatJid: "62812@s.whatsapp.net" }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("/chat/completions");
    }
  });

  it("chat tanpa pesan -> 400 dan AI tidak dipanggil", async () => {
    mockState.messages = [];
    const fetchMock = aiFetch(["a", "b", "c"]);
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(jsonReq("http://localhost/api/drafts", "POST", { chatJid: "62812@s.whatsapp.net" }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockState.insertedDrafts).toHaveLength(0);
  });

  it("AI gagal di nada ke-2 -> 502 dan TIDAK ADA draf yang disimpan", async () => {
    const fetchMock = vi.fn(async () => {
      const call = fetchMock.mock.calls.length;
      if (call === 2) throw new Error("gateway down");
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "draf" } }] }),
        text: async () => "",
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(jsonReq("http://localhost/api/drafts", "POST", { chatJid: "62812@s.whatsapp.net" }));
    expect(res.status).toBe(502);
    expect(mockState.insertedDrafts).toHaveLength(0);
  });

  it("chatJid kosong -> 400", async () => {
    const res = await POST(jsonReq("http://localhost/api/drafts", "POST", { chatJid: "" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/drafts", () => {
  it("mengembalikan daftar dan memfilter status", async () => {
    mockState.draftsList = [
      { id: "d1", chat_jid: "c1", nada: "formal", isi: "x", sumber: "m:draft-formal", status: "menunggu review" },
    ];
    const res = await GET(req("http://localhost/api/drafts?status=menunggu%20review"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { drafts: Array<Record<string, unknown>> };
    expect(data.drafts).toHaveLength(1);
    expect(data.drafts[0]).toMatchObject({ id: "d1", tone: "formal", status: "menunggu review" });
    expect(mockState.executedSql.some((sql) => sql.includes("WHERE status = ?"))).toBe(true);
  });

  it("status tak dikenal -> 400", async () => {
    const res = await GET(req("http://localhost/api/drafts?status=ngaco"));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/drafts/[id]", () => {
  it("dipakai -> 200 dengan draf terbarui; dibuang juga sah", async () => {
    mockState.draftById = { id: "d1", chat_jid: "c1", nada: "formal", isi: "x", sumber: "m:draft-formal", status: "dipakai" };
    const res = await PATCH(jsonReq("http://localhost/api/drafts/d1", "PATCH", { status: "dipakai" }), {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { draft: Record<string, unknown> };
    expect(data.draft.status).toBe("dipakai");
  });

  it("status selain dipakai/dibuang -> 400", async () => {
    const res = await PATCH(jsonReq("http://localhost/api/drafts/d1", "PATCH", { status: "menunggu review" }), {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(res.status).toBe(400);
  });

  it("id tak dikenal -> 404", async () => {
    mockState.updateAffected = 0;
    const res = await PATCH(jsonReq("http://localhost/api/drafts/nope", "PATCH", { status: "dibuang" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
