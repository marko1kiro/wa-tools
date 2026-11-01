// AI layer — client OpenAI-compatible (SPEC §2.2, §9).
//
// Satu-satunya jalur pemanggilan AI dari dashboard web. Semua tool AI
// (Fase 1: draf balasan) lewat sini; tidak ada tool yang memanggil
// gateway langsung.
//
// Aturan yang dipegang file ini:
// - Base URL, model, dan API key dibaca dari tabel `settings` (didahulukan)
//   lalu env, lalu default — SELALU saat runtime, TIDAK PERNAH ditulis
//   ke file, dan TIDAK PERNAH dikirim ke klien.
// - Timeout 60 detik; error jelas (HTTP / timeout / respons malformed).
// - TIDAK ADA fallback diam-diam ke model lain: satu percobaan, gagal
//   berarti gagal (fail-closed, SPEC §2.5). Caller yang menampilkan error.
// - Output fungsi-fungsi di sini SELALU berupa draf. File ini tidak
//   mengirim pesan WhatsApp apa pun.
//
// Catatan teknis: paket `web` tidak mendeklarasikan `drizzle-orm`
// (pnpm strict: tidak bisa di-resolve dari apps/web), jadi pembacaan
// tabel settings memakai SQL berparameter lewat `db.$client` dari
// @wa-tools/db, bukan query builder Drizzle. Nama kolom mengikuti
// packages/db/src/schema.ts.

import { getDb } from "./db";

export const DEFAULT_GATEWAY_BASE_URL = "http://localhost:20128/v1";
// Model default gateway lokal user (9Router). Bukan konstanta magis yang
// mengunci: settings `ai_model_draft` / env AI_MODEL_DRAFT mengalahkan ini.
export const DEFAULT_DRAFT_MODEL = "xdirgalabs";
export const CHAT_COMPLETION_TIMEOUT_MS = 60_000;

export const DRAFT_TONES = ["formal", "santai", "tegas"] as const;
export type DraftTone = (typeof DRAFT_TONES)[number];

export interface GatewayConfig {
  baseUrl: string;
  /** undefined bila tidak dikonfigurasi — request dikirim tanpa header auth. */
  apiKey: string | undefined;
  draftModel: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Error gateway AI: HTTP non-2xx, timeout, atau respons tak berbentuk. */
export class AiGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiGatewayError";
  }
}

const SETTING_BASE_URL = "ai_gateway_base_url";
const SETTING_DRAFT_MODEL = "ai_model_draft";
const SETTING_API_KEY = "ai_gateway_api_key";

/**
 * Nilai settings disimpan sebagai JSON string (lihat schema settings),
 * tapi terima juga nilai mentah tanpa JSON — jangan sampai URL yang
 * tersimpan sebagai `"http://..."` (dengan kutip) lolos mentah ke fetch.
 */
function parseSettingValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : trimmed;
  } catch {
    return trimmed;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Baca konfigurasi gateway: settings > env > default.
 * Dipanggil per-request (bukan di-cache di level modul) supaya perubahan
 * di Pengaturan langsung berlaku tanpa restart.
 */
export async function getGatewayConfig(): Promise<GatewayConfig> {
  const { db } = await getDb();
  const result = await db.$client.execute(
    "SELECT key, value FROM settings WHERE key IN ('ai_gateway_base_url', 'ai_model_draft', 'ai_gateway_api_key')",
  );
  const byKey = new Map<string, string>();
  for (const row of result.rows) {
    const key = row.key;
    const value = row.value;
    if (typeof key === "string" && typeof value === "string") {
      byKey.set(key, parseSettingValue(value));
    }
  }
  const baseUrl =
    firstNonEmpty(byKey.get(SETTING_BASE_URL), process.env.AI_GATEWAY_BASE_URL) ??
    DEFAULT_GATEWAY_BASE_URL;
  const draftModel =
    firstNonEmpty(byKey.get(SETTING_DRAFT_MODEL), process.env.AI_MODEL_DRAFT) ??
    DEFAULT_DRAFT_MODEL;
  const apiKey = firstNonEmpty(byKey.get(SETTING_API_KEY), process.env.AI_GATEWAY_API_KEY);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, draftModel };
}

export interface ChatCompletionInput {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
}

/**
 * Satu pemanggilan POST {baseUrl}/chat/completions. Satu percobaan saja:
 * tidak ada retry, tidak ada fallback model. Gagal -> AiGatewayError.
 */
export async function chatCompletion(input: ChatCompletionInput): Promise<string> {
  const timeoutMs = input.timeoutMs ?? CHAT_COMPLETION_TIMEOUT_MS;
  const url = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new AiGatewayError(
          `Gateway AI timeout setelah ${timeoutMs} ms (${url}). Tidak ada fallback ke model lain.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: input.model, messages: input.messages }),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AiGatewayError(
        `Gateway AI error HTTP ${response.status} (${url}, model ${input.model}): ${detail.slice(0, 500)}`,
      );
    }
    const data: unknown = await response.json();
    const content =
      typeof data === "object" &&
      data !== null &&
      Array.isArray((data as { choices?: unknown }).choices) &&
      (data as { choices: Array<{ message?: { content?: unknown } }> }).choices.length > 0
        ? (data as { choices: Array<{ message?: { content?: unknown } }> }).choices[0].message
            ?.content
        : undefined;
    if (typeof content !== "string" || content.trim() === "") {
      throw new AiGatewayError(
        `Respons gateway AI tidak berisi teks balasan (${url}, model ${input.model}). Tidak ada fallback ke model lain.`,
      );
    }
    return content.trim();
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AiGatewayError(
        `Gateway AI timeout setelah ${timeoutMs} ms (${url}). Tidak ada fallback ke model lain.`,
      );
    }
    throw new AiGatewayError(
      `Gagal menghubungi gateway AI (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Template prompt draf balasan (Bahasa Indonesia, per nada)
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM_PROMPTS: Record<DraftTone, string> = {
  formal:
    "Kamu adalah asisten yang menulis draf balasan WhatsApp dalam Bahasa Indonesia formal dan sopan. " +
    "Gunakan sapaan yang santun, kalimat lengkap, dan struktur yang jelas. " +
    "Tulis HANYA isi balasan, tanpa pembuka, penjelasan, atau tanda kutip pembungkus.",
  santai:
    "Kamu adalah asisten yang menulis draf balasan WhatsApp dalam Bahasa Indonesia santai dan akrab, " +
    "seperti chat sehari-hari, tapi tetap sopan dan tidak kasar. " +
    "Tulis HANYA isi balasan, tanpa pembuka, penjelasan, atau tanda kutip pembungkus.",
  tegas:
    "Kamu adalah asisten yang menulis draf balasan WhatsApp dalam Bahasa Indonesia yang tegas, singkat, dan jelas. " +
    "Sampaikan maksud tanpa basa-basi, tetap sopan dan tidak menyerang. " +
    "Tulis HANYA isi balasan, tanpa pembuka, penjelasan, atau tanda kutip pembungkus.",
};

export interface DraftPrompt {
  system: string;
  user: string;
}

/** Bangun prompt draf dari konteks percakapan (sudah terurut kronologis). */
export function buildDraftPrompt(tone: DraftTone, contextText: string): DraftPrompt {
  return {
    system: DRAFT_SYSTEM_PROMPTS[tone],
    user:
      `Konteks percakapan terakhir:\n${contextText}\n\n` +
      `Buat satu draf balasan untuk pesan terakhir di atas dengan nada ${tone}. ` +
      `Balasan harus nyambung dengan konteks, bukan karangan di luar percakapan.`,
  };
}

export interface ContextMessage {
  direction: string; // 'masuk' | 'keluar'
  senderJid: string;
  text: string;
}

/** Format pesan-pesan konteks menjadi teks prompt (satu baris per pesan). */
export function formatChatContext(messages: ContextMessage[]): string {
  return messages
    .map((m) =>
      m.direction === "keluar" ? `Pesan keluar (saya): ${m.text}` : `Pesan masuk: ${m.text}`,
    )
    .join("\n");
}

export interface DraftReply {
  tone: DraftTone;
  body: string;
  model: string;
  /** Disimpan ke drafts.sumber: model + template prompt yang dipakai. */
  source: string;
}

/** Satu draf balasan untuk satu nada (memakai config gateway yang diberikan). */
export async function generateDraftReply(
  tone: DraftTone,
  contextText: string,
  config: GatewayConfig,
): Promise<DraftReply> {
  const prompt = buildDraftPrompt(tone, contextText);
  const body = await chatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.draftModel,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  });
  return { tone, body, model: config.draftModel, source: `${config.draftModel}:draft-${tone}` };
}
