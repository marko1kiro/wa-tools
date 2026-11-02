import http from "node:http";
import QRCode from "qrcode";
import { z } from "zod";
import { db } from "@wa-tools/db";
import { saveOutgoingMessage, syncIncomingMessage } from "./sync.js";
import type {
  EngineState,
  IncomingMessage,
  TransportControl,
  WaTransport,
} from "./transport.js";

// HTTP server wa-engine (SPEC §5): TANPA framework baru, Node bawaan.
// Queue runner TIDAK di-wire di sini (modul queue dibuat worker lain;
// koordinator yang akan wiring). queuePaused di /status default-nya
// fail-closed: true saat WA tidak connected (SPEC §2.5: jadwal
// auto-pause saat WA putus), kecuali opsi queuePaused diberikan.

export interface EngineServerOptions {
  transport: WaTransport & Partial<TransportControl>;
  /** true bila transport adalah mock (mode default yang aman). */
  mock?: boolean;
  /** Koneksi DB untuk persistensi pesan; default koneksi modul @wa-tools/db. */
  db?: typeof db;
  /** Sinkronkan pesan masuk ke SQLite (default true). */
  autoSync?: boolean;
  /** Override queuePaused: boolean atau getter (mis. dari modul queue). */
  queuePaused?: boolean | (() => boolean);
  /** epoch ms proses mulai (untuk uptime); default saat server dibuat. */
  startedAt?: number;
}

export interface EngineStatus {
  state: EngineState;
  connected: boolean;
  phone: string | null;
  mock: boolean;
  queuePaused: boolean;
}

/**
 * Payload GET /health (SPEC §13.2): dipakai dashboard (via /api/status)
 * dan watchdog eksternal. Kompatibel ke belakang: field lama
 * {ok, service} tetap ada, field baru hanya ditambahkan.
 */
export interface EngineHealth {
  ok: boolean;
  service: "wa-engine";
  state: EngineState;
  connected: boolean;
  phone: string | null;
  mock: boolean;
  queuePaused: boolean;
  /** detik sejak proses mulai (bilangan bulat). */
  uptimeSeconds: number;
  /** ISO 8601 saat proses mulai. */
  startedAt: string;
  /** ISO 8601 disconnect terakhir, null bila belum pernah putus. */
  lastDisconnectAt: string | null;
}

export interface EngineServerHandle {
  server: http.Server;
  getStatus(): EngineStatus;
  getHealth(): EngineHealth;
}

const SendBodySchema = z.object({
  jid: z.string().min(1, "jid wajib diisi"),
  body: z.string().min(1, "body wajib diisi").max(65536),
});

const PairingCodeBodySchema = z.object({
  phone: z.string().min(1, "phone wajib diisi"),
});

/**
 * Normalisasi nomor HP untuk requestPairingCode (SPEC §3.1): buang
 * `+`, spasi, strip, titik, kurung, lalu validasi digit dengan kode
 * negara (8-15 digit, batas E.164). Gagal -> null (bukan throw).
 * Contoh: "+62 812-3456-789" -> "628123456789".
 */
export function normalizePairingPhone(input: string): string | null {
  const digits = input.replace(/[+\s\-().]/g, "");
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendPng(res: http.ServerResponse, png: Buffer): void {
  res.writeHead(200, {
    "content-type": "image/png",
    "content-length": png.length,
    "cache-control": "no-store",
  });
  res.end(png);
}

/**
 * Detail error yang aman untuk UI: pesan Baileys + statusCode bila ada,
 * dipotong 300 karakter. TIDAK PERNAH berisi kredensial/session — pesan
 * error Baileys hanya kelas kegagalan (mis. socket tertutup, timeout).
 */
export function baileysErrorDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  const code = (
    err as { output?: { statusCode?: number } } | null | undefined
  )?.output?.statusCode;
  const base = msg ? msg : "Baileys error tanpa pesan";
  const withCode =
    typeof code === "number" ? `${base} (status ${code})` : base;
  return withCode.slice(0, 300);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function createEngineServer(
  options: EngineServerOptions,
): EngineServerHandle {
  const { transport } = options;
  const dbTarget = options.db ?? db;
  const mock = options.mock ?? false;

  const getStatus = (): EngineStatus => {
    const connected = transport.isConnected();
    const state: EngineState =
      transport.getState?.() ?? (connected ? "connected" : "idle");
    const queuePaused =
      typeof options.queuePaused === "function"
        ? options.queuePaused()
        : (options.queuePaused ?? !connected);
    return {
      state,
      connected,
      phone: transport.getPhone?.() ?? null,
      mock,
      queuePaused,
    };
  };

  const startedAtMs = options.startedAt ?? Date.now();
  const getHealth = (): EngineHealth => {
    const status = getStatus();
    const lastMs = transport.getLastDisconnectAt?.() ?? null;
    return {
      ok: true,
      service: "wa-engine",
      ...status,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
      startedAt: new Date(startedAtMs).toISOString(),
      lastDisconnectAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    };
  };

  // Pesan masuk -> SQLite (SPEC §3.2). Gagal sync hanya di-log,
  // tidak meruntuhkan server maupun transport.
  if (options.autoSync !== false && transport.onMessage) {
    transport.onMessage((msg: IncomingMessage) => {
      void syncIncomingMessage(msg, dbTarget).catch((err: unknown) => {
        console.error(
          "[wa-engine] sync pesan masuk gagal:",
          err instanceof Error ? err.message : err,
        );
      });
    });
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      try {
        if (method === "GET" && url.pathname === "/health") {
          sendJson(res, 200, getHealth());
          return;
        }

        if (method === "GET" && url.pathname === "/status") {
          sendJson(res, 200, getStatus());
          return;
        }

        if (method === "GET" && url.pathname === "/qr") {
          // QR sebagai PNG beneran (SPEC §3.1): string QR mentah Baileys
          // BUKAN gambar — dashboard lama memasang JSON ini ke <img>
          // sehingga QR tidak pernah tampil. Tanpa QR aktif -> 404
          // {error:"no_qr"} supaya <img onError> dashboard menampilkan
          // pesan qrBroken yang sudah ada.
          const qr = transport.getQr?.() ?? null;
          if (!qr) {
            sendJson(res, 404, { error: "no_qr" });
            return;
          }
          try {
            const png = await QRCode.toBuffer(qr, {
              type: "png",
              width: 512,
              margin: 2,
            });
            sendPng(res, png);
          } catch {
            sendJson(res, 500, { error: "qr_render_failed" });
          }
          return;
        }

        if (method === "POST" && url.pathname === "/start") {
          if (transport.isConnected()) {
            sendJson(res, 200, getStatus());
            return;
          }
          if (!transport.connect) {
            sendJson(res, 500, { error: "transport_cannot_start" });
            return;
          }
          await transport.connect();
          sendJson(res, 200, getStatus());
          return;
        }

        if (method === "POST" && url.pathname === "/stop") {
          if (transport.disconnect) await transport.disconnect();
          sendJson(res, 200, getStatus());
          return;
        }

        if (method === "POST" && url.pathname === "/pairing-code") {
          // Jalur fallback bila QR bermasalah (SPEC §3.1).
          // FAIL-CLOSED seperti /send: sudah connected -> 409.
          if (transport.isConnected()) {
            sendJson(res, 409, { error: "already_connected" });
            return;
          }
          let raw: string;
          try {
            raw = await readBody(req);
          } catch {
            sendJson(res, 413, { error: "body_too_large" });
            return;
          }
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            sendJson(res, 400, { error: "invalid_json" });
            return;
          }
          const result = PairingCodeBodySchema.safeParse(parsed);
          if (!result.success) {
            sendJson(res, 400, {
              error: "validation_failed",
              issues: result.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            });
            return;
          }
          const phone = normalizePairingPhone(result.data.phone);
          if (phone === null) {
            sendJson(res, 400, {
              error: "invalid_phone",
              hint: "nomor harus digit dengan kode negara, tanpa + (mis. 62812xxxxxxx)",
            });
            return;
          }
          if (!transport.requestPairingCode) {
            sendJson(res, 501, { error: "pairing_code_unsupported" });
            return;
          }
          try {
            const code = await transport.requestPairingCode(phone);
            sendJson(res, 200, { code, phone, state: getStatus().state });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "";
            if (msg === "already_connected" || msg === "already_registered") {
              sendJson(res, 409, { error: msg });
              return;
            }
            console.error(
              "[wa-engine] requestPairingCode gagal:",
              err instanceof Error ? err.message : err,
            );
            // Detail aman diteruskan ke UI (bukan pairing_failed generik
            // saja): socket_not_ready punya error sendiri; sisanya tetap
            // 502 pairing_failed tapi dengan detail Baileys.
            if (msg === "socket_not_ready") {
              sendJson(res, 502, {
                error: "socket_not_ready",
                detail:
                  "Socket WhatsApp belum siap (handshake belum selesai dalam 15 detik). Coba lagi.",
              });
              return;
            }
            sendJson(res, 502, {
              error: "pairing_failed",
              detail: baileysErrorDetail(err),
            });
            return;
          }
          return;
        }

        if (method === "POST" && url.pathname === "/send") {
          // FAIL-CLOSED: tidak connected -> 503, jangan pernah klaim
          // sukses palsu (SPEC §2.5).
          if (!transport.isConnected()) {
            sendJson(res, 503, { error: "not_connected" });
            return;
          }
          let raw: string;
          try {
            raw = await readBody(req);
          } catch {
            sendJson(res, 413, { error: "body_too_large" });
            return;
          }
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            sendJson(res, 400, { error: "invalid_json" });
            return;
          }
          const result = SendBodySchema.safeParse(parsed);
          if (!result.success) {
            sendJson(res, 400, {
              error: "validation_failed",
              issues: result.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            });
            return;
          }
          const { jid, body } = result.data;
          const sent = await transport.sendMessage(jid, body);
          // Simpan pesan arah=keluar. Bila persistensi gagal, laporkan
          // 500 (pesan sudah terkirim) — bukan sukses penuh.
          try {
            const phone = transport.getPhone?.() ?? null;
            await saveOutgoingMessage(
              {
                id: sent.id,
                chatJid: jid,
                senderJid: phone ? `${phone}@s.whatsapp.net` : "me",
                text: body,
              },
              dbTarget,
            );
          } catch (err) {
            console.error(
              "[wa-engine] simpan pesan keluar gagal:",
              err instanceof Error ? err.message : err,
            );
            sendJson(res, 500, { error: "persist_failed", id: sent.id });
            return;
          }
          sendJson(res, 200, { id: sent.id, jid });
          return;
        }

        sendJson(res, 404, { error: "not_found" });
      } catch (err) {
        console.error(
          "[wa-engine] handler gagal:",
          err instanceof Error ? err.message : err,
        );
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error" });
        }
      }
    })();
  });

  return { server, getStatus, getHealth };
}

/** Buat + listen server; port 0 = ephemeral (dipakai test). */
export function startEngineServer(
  options: EngineServerOptions,
  port: number,
): Promise<{ handle: EngineServerHandle; port: number }> {
  const handle = createEngineServer(options);
  return new Promise((resolve, reject) => {
    handle.server.once("error", reject);
    handle.server.listen(port, "127.0.0.1", () => {
      const address = handle.server.address();
      const actual =
        address && typeof address === "object" ? address.port : port;
      resolve({ handle, port: actual });
    });
  });
}
