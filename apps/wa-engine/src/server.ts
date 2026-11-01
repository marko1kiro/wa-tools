import http from "node:http";
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
}

export interface EngineStatus {
  state: EngineState;
  connected: boolean;
  phone: string | null;
  mock: boolean;
  queuePaused: boolean;
}

export interface EngineServerHandle {
  server: http.Server;
  getStatus(): EngineStatus;
}

const SendBodySchema = z.object({
  jid: z.string().min(1, "jid wajib diisi"),
  body: z.string().min(1, "body wajib diisi").max(65536),
});

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
          sendJson(res, 200, { ok: true, service: "wa-engine" });
          return;
        }

        if (method === "GET" && url.pathname === "/status") {
          sendJson(res, 200, getStatus());
          return;
        }

        if (method === "GET" && url.pathname === "/qr") {
          const status = getStatus();
          sendJson(res, 200, {
            state: status.state,
            qr: transport.getQr?.() ?? null,
            mock,
            phone: status.phone,
          });
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

  return { server, getStatus };
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
