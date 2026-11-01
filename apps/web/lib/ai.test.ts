// Test AI layer. Gateway TIDAK PERNAH dipanggil sungguhan: fetch di-stub
// di tiap test. DB juga di-mock (hanya untuk getGatewayConfig).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  settingsRows: [] as Array<{ key: string; value: string }>,
}));

vi.mock("@wa-tools/db", () => ({
  db: {
    $client: {
      execute: vi.fn(async () => ({ rows: mockState.settingsRows })),
    },
  },
  ensureSchema: async () => {},
}));

import {
  buildDraftPrompt,
  chatCompletion,
  formatChatContext,
  generateDraftReply,
  getGatewayConfig,
  DEFAULT_DRAFT_MODEL,
  DEFAULT_GATEWAY_BASE_URL,
  DRAFT_TONES,
  AiGatewayError,
} from "./ai";

function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  } as Response;
}

beforeEach(() => {
  mockState.settingsRows = [];
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("template prompt draf", () => {
  it("menyediakan tepat 3 nada", () => {
    expect([...DRAFT_TONES].sort()).toEqual(["formal", "santai", "tegas"]);
  });

  it("ketiga system prompt berbahasa Indonesia dan saling berbeda", () => {
    const systems = DRAFT_TONES.map((tone) => buildDraftPrompt(tone, "konteks").system);
    expect(new Set(systems).size).toBe(3);
    for (const system of systems) {
      expect(system).toMatch(/Bahasa Indonesia/);
      expect(system).toMatch(/HANYA isi balasan/);
    }
    expect(buildDraftPrompt("formal", "x").system).toMatch(/formal dan sopan/);
    expect(buildDraftPrompt("santai", "x").system).toMatch(/santai dan akrab/);
    expect(buildDraftPrompt("tegas", "x").system).toMatch(/tegas, singkat, dan jelas/);
  });

  it("prompt user memuat konteks dan nada yang diminta", () => {
    const prompt = buildDraftPrompt("tegas", "Pesan masuk: halo");
    expect(prompt.user).toContain("Pesan masuk: halo");
    expect(prompt.user).toContain("tegas");
  });

  it("formatChatContext mengurutkan masuk/keluar dengan label jelas", () => {
    const text = formatChatContext([
      { direction: "masuk", senderJid: "62812@s.whatsapp.net", text: "halo" },
      { direction: "keluar", senderJid: "me", text: "hai juga" },
    ]);
    expect(text).toBe("Pesan masuk: halo\nPesan keluar (saya): hai juga");
  });
});

describe("getGatewayConfig", () => {
  it("settings mengalahkan env", async () => {
    mockState.settingsRows = [
      { key: "ai_gateway_base_url", value: '"https://gw.internal/v1"' },
      { key: "ai_model_draft", value: '"model-settings"' },
    ];
    vi.stubEnv("AI_GATEWAY_BASE_URL", "https://env.example/v1");
    vi.stubEnv("AI_MODEL_DRAFT", "model-env");
    const config = await getGatewayConfig();
    expect(config.baseUrl).toBe("https://gw.internal/v1");
    expect(config.draftModel).toBe("model-settings");
  });

  it("nilai settings mentah (bukan JSON) tetap dipakai", async () => {
    mockState.settingsRows = [{ key: "ai_gateway_base_url", value: "https://plain.example/v1" }];
    const config = await getGatewayConfig();
    expect(config.baseUrl).toBe("https://plain.example/v1");
  });

  it("fallback env lalu default bila settings kosong", async () => {
    vi.stubEnv("AI_GATEWAY_BASE_URL", "https://env.example/v1");
    vi.stubEnv("AI_MODEL_DRAFT", "model-env");
    const fromEnv = await getGatewayConfig();
    expect(fromEnv.baseUrl).toBe("https://env.example/v1");
    expect(fromEnv.draftModel).toBe("model-env");
    vi.unstubAllEnvs();
    const fromDefault = await getGatewayConfig();
    expect(fromDefault.baseUrl).toBe(DEFAULT_GATEWAY_BASE_URL);
    expect(fromDefault.draftModel).toBe(DEFAULT_DRAFT_MODEL);
    expect(fromDefault.apiKey).toBeUndefined();
  });

  it("api key dibaca dari settings, bukan ditulis ke mana pun", async () => {
    mockState.settingsRows = [{ key: "ai_gateway_api_key", value: '"sekrit"' }];
    const config = await getGatewayConfig();
    expect(config.apiKey).toBe("sekrit");
  });
});

describe("chatCompletion", () => {
  it("POST ke {baseUrl}/chat/completions dengan model + messages + auth", async () => {
    const fetchMock = vi.fn(async () => okResponse("  halo bos  "));
    vi.stubGlobal("fetch", fetchMock);
    const content = await chatCompletion({
      baseUrl: "https://gw.example/v1/",
      apiKey: "kunci",
      model: "model-x",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(content).toBe("halo bos");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0];
    expect(url).toBe("https://gw.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer kunci");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "model-x",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("tanpa api key: tidak ada header authorization", async () => {
    const fetchMock = vi.fn(async () => okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletion({
      baseUrl: "https://gw.example/v1",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const init = calls[0][1];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("HTTP non-2xx -> AiGatewayError, SATU percobaan saja (tanpa fallback model)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid key",
      json: async () => ({}),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion({ baseUrl: "https://gw.example/v1", model: "m", messages: [] }),
    ).rejects.toBeInstanceOf(AiGatewayError);
    await expect(
      chatCompletion({ baseUrl: "https://gw.example/v1", model: "m", messages: [] }),
    ).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 2 pemanggilan test, masing-masing 1x
  });

  it("timeout -> AiGatewayError walau fetch mengabaikan signal", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion({
        baseUrl: "https://gw.example/v1",
        model: "m",
        messages: [],
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timeout/);
  });

  it("respons tanpa choices -> AiGatewayError", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "",
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion({ baseUrl: "https://gw.example/v1", model: "m", messages: [] }),
    ).rejects.toThrow(/tidak berisi teks balasan/);
  });

  it("generateDraftReply memakai template nada + model dari config", async () => {
    const fetchMock = vi.fn(async () => okResponse("draf tegas"));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await generateDraftReply("tegas", "Pesan masuk: halo", {
      baseUrl: "https://gw.example/v1",
      apiKey: undefined,
      draftModel: "model-draf",
    });
    expect(reply).toEqual({
      tone: "tegas",
      body: "draf tegas",
      model: "model-draf",
      source: "model-draf:draft-tegas",
    });
  });
});
