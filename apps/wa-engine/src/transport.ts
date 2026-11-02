import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";

// Transport WA untuk wa-engine (SPEC §3.1, §5).
//
// ATURAN KERAS:
// - Meng-import modul ini TIDAK PERNAH membuka koneksi WhatsApp.
//   Koneksi hanya jalan saat method connect() dipanggil eksplisit
//   (oleh endpoint POST /start di server.ts).
// - Tidak ada kredensial/session yang ditulis di kode; session Baileys
//   tinggal di folder auth (sudah di .gitignore, SPEC §8).

export type EngineState = "idle" | "pairing" | "connected" | "disconnected";

export interface WaTransport {
  isConnected(): boolean;
  sendMessage(jid: string, text: string): Promise<{ id: string }>;
}

/** Pesan masuk yang sudah dinormalisasi (bentuk yang dimakan sync.ts). */
export interface IncomingMessage {
  id: string;
  chatJid: string;
  senderJid: string;
  senderName?: string;
  fromMe: boolean;
  /** 'teks' | 'gambar' | 'video' | 'audio' | 'dokumen' | 'stiker' | 'lainnya' */
  type: string;
  text?: string;
  caption?: string;
  /** epoch ms */
  timestamp: number;
}

export type MessageHandler = (msg: IncomingMessage) => void;
export type StateHandler = (state: EngineState) => void;

/** Kontrol siklus hidup + observasi state; diimplementasi kedua transport. */
export interface TransportControl {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): EngineState;
  getQr(): string | null;
  getPhone(): string | null;
  onMessage(handler: MessageHandler): void;
  onStateChange(handler: StateHandler): void;
  /** epoch ms disconnect terakhir (apa pun penyebabnya), null bila belum pernah. */
  getLastDisconnectAt?(): number | null;
  /**
   * true bila watchdog boleh fail-fast: pernah connected sejak proses
   * jalan dan belum ada stop manual. Opsional supaya fake transport
   * di test lama tetap kompatibel.
   */
  isWatchdogArmed?(): boolean;
  /**
   * Minta kode pairing 8 digit (Baileys requestPairingCode, SPEC §3.1).
   * Dipakai bila QR bermasalah. `phone` sudah dinormalisasi server:
   * digit dengan kode negara, tanpa `+`. Hanya valid bila BELUM
   * terdaftar (creds.registered false); bila sudah terdaftar, throw
   * Error("already_registered"); bila sudah connected, throw
   * Error("already_connected"). Setelah user memasukkan kode di HP,
   * lifecycle SAMA seperti via QR (sesi tersimpan, reconnect otomatis).
   */
  requestPairingCode?(phone: string): Promise<string>;
}

/** Timeout tunggu socket Baileys ready sebelum requestPairingCode. */
export const PAIRING_READY_TIMEOUT_MS = 15_000;

/**
 * Sinyal readiness socket (perbaikan race requestPairingCode, SPEC §3.1).
 * `connection.update` pertama adalah bukti handshake berjalan — channel
 * sudah hidup dan bisa menerima query pairing. Tanpa sinyal ini,
 * requestPairingCode yang ditembak langsung setelah makeWASocket akan
 * gagal karena handshake WebSocket belum selesai.
 */
export class ReadySignal {
  private seen = false;
  private waiters: Array<() => void> = [];

  isSeen(): boolean {
    return this.seen;
  }

  markSeen(): void {
    if (this.seen) return;
    this.seen = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Socket baru = handshake baru; sinyal di-reset tiap doConnect. */
  reset(): void {
    this.seen = false;
    this.waiters = [];
  }

  /**
   * true bila sinyal sudah terlihat (langsung bila sudah seen);
   * false bila timeout habis tanpa sinyal. Satu wait = satu percobaan,
   * tanpa retry tanpa batas.
   */
  wait(timeoutMs: number): Promise<boolean> {
    if (this.seen) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const resolveTrue = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((w) => w !== resolveTrue);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(resolveTrue);
    });
  }
}

function emitState(
  handlers: StateHandler[],
  state: EngineState,
): void {
  for (const h of handlers) {
    try {
      h(state);
    } catch {
      // Handler observer tidak boleh meruntuhkan transport.
    }
  }
}

/**
 * Jeda reconnect otomatis (skill whatsapp-baileys: hindari loop reconnect
 * rapat): mulai 3 detik, backoff eksponensial, mentok 60 detik. Pure,
 * bisa di-unit-test.
 */
export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 0) return 3000;
  return Math.min(3000 * 2 ** attempt, 60000);
}

// ---------------------------------------------------------------------------
// Konversi WAMessage Baileys -> IncomingMessage (pure, bisa di-unit-test).
// Media TIDAK di-download di sini (media handler DIPARKIR, SPEC §4);
// pesan media hanya dikenali tipenya, isi teksnya placeholder di sync.ts.
// ---------------------------------------------------------------------------

type RawMessageContent = Record<string, unknown> | undefined | null;

function nestedMessage(obj: unknown): Record<string, unknown> | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const m = (obj as Record<string, unknown>).message;
  return typeof m === "object" && m !== null
    ? (m as Record<string, unknown>)
    : undefined;
}

function unwrapMessage(content: RawMessageContent): Record<string, unknown> {
  let cur: Record<string, unknown> = content ?? {};
  // Ephemeral / view-once / edited membungkus pesan asli satu lapis.
  for (let i = 0; i < 3; i++) {
    const inner =
      nestedMessage(cur.ephemeralMessage) ??
      nestedMessage(cur.viewOnceMessage) ??
      nestedMessage(cur.viewOnceMessageV2) ??
      nestedMessage(cur.editedMessage);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function messageTypeOf(content: Record<string, unknown>): string {
  if (typeof content.conversation === "string") return "teks";
  if (content.extendedTextMessage) return "teks";
  if (content.imageMessage) return "gambar";
  if (content.videoMessage) return "video";
  if (content.audioMessage) return "audio";
  if (content.documentMessage) return "dokumen";
  if (content.stickerMessage) return "stiker";
  return "lainnya";
}

function messageTextOf(content: Record<string, unknown>): string | undefined {
  if (typeof content.conversation === "string") return content.conversation;
  const ext = content.extendedTextMessage as
    | { text?: unknown }
    | undefined;
  if (ext && typeof ext.text === "string") return ext.text;
  const captionOf = (key: string): string | undefined => {
    const m = content[key] as { caption?: unknown } | undefined;
    return m && typeof m.caption === "string" ? m.caption : undefined;
  };
  return (
    captionOf("imageMessage") ??
    captionOf("videoMessage") ??
    captionOf("documentMessage")
  );
}

function toEpochMs(ts: unknown): number {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  // Baileys memberi detik; kalau sudah ms, jangan dikali lagi.
  return n < 1e12 ? n * 1000 : n;
}

export function baileysMessageToIncoming(
  msg: WAMessage,
  fallbackName?: string,
): IncomingMessage | null {
  const remoteJid = msg.key.remoteJid;
  const id = msg.key.id;
  if (!remoteJid || !id) return null;
  const content = unwrapMessage(
    msg.message as RawMessageContent,
  );
  const type = messageTypeOf(content);
  const senderJid =
    msg.key.participant ?? (msg.key.fromMe ? "" : remoteJid);
  return {
    id,
    chatJid: remoteJid,
    senderJid: senderJid || remoteJid,
    senderName: msg.pushName ?? fallbackName,
    fromMe: msg.key.fromMe ?? false,
    type,
    text: messageTextOf(content),
    caption: messageTextOf(content),
    timestamp: toEpochMs(
      (msg.messageTimestamp as unknown) ?? Date.now() / 1000,
    ),
  };
}

// ---------------------------------------------------------------------------
// BaileysTransport — koneksi WhatsApp asli.
// ---------------------------------------------------------------------------

export interface BaileysTransportOptions {
  /** Folder session. Default: apps/wa-engine/auth (di .gitignore). */
  authDir?: string;
}

const DEFAULT_AUTH_DIR = path.dirname(
  fileURLToPath(new URL("../auth/.keep", import.meta.url)),
);

export class BaileysTransport implements WaTransport, TransportControl {
  private sock: WASocket | null = null;
  private state: EngineState = "idle";
  private qr: string | null = null;
  private phone: string | null = null;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly authDir: string;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly stateHandlers: StateHandler[] = [];
  /** epoch ms disconnect terakhir (untuk /health + watchdog). */
  private lastDisconnectAt: number | null = null;
  /**
   * true sejak satu koneksi sukses, dilucuti oleh stop manual.
   * Dipakai watchdog (SPEC §13.3): hanya proses yang pernah hidup
   * lalu mati yang boleh di-restart paksa.
   */
  private watchdogArmed = false;
  /**
   * null = belum diketahui (connect belum pernah jalan);
   * true = sesi sudah terdaftar (QR/kode tidak diperlukan lagi).
   */
  private registered: boolean | null = null;
  /** Sinyal connection.update pertama dari socket aktif. */
  private readonly readySignal = new ReadySignal();

  constructor(options: BaileysTransportOptions = {}) {
    // Sengaja TIDAK connect di sini. connect() eksplisit saja.
    this.authDir = options.authDir ?? DEFAULT_AUTH_DIR;
  }

  isConnected(): boolean {
    return this.state === "connected" && this.sock !== null;
  }

  getState(): EngineState {
    return this.state;
  }

  getQr(): string | null {
    return this.qr;
  }

  getPhone(): string | null {
    return this.phone;
  }

  getLastDisconnectAt(): number | null {
    return this.lastDisconnectAt;
  }

  isWatchdogArmed(): boolean {
    return this.watchdogArmed;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onStateChange(handler: StateHandler): void {
    this.stateHandlers.push(handler);
  }

  private setState(next: EngineState): void {
    if (this.state === next) return;
    this.state = next;
    emitState(this.stateHandlers, next);
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async doConnect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    // Socket baru = handshake baru; sinyal readiness di-reset.
    this.readySignal.reset();
    // Catat status registrasi: menentukan apakah pairing code valid.
    this.registered = state.creds.registered === true;
    // Opsi socket per skill whatsapp-baileys (anti 405/408): versi
    // terbaru dari server, tanpa full history sync, tanpa mark online,
    // timeout longgar. Fetch versi gagal (offline) -> fallback ke
    // default library, koneksi tetap dicoba.
    let version:
      | Awaited<ReturnType<typeof fetchLatestBaileysVersion>>["version"]
      | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined;
    }
    const sock = makeWASocket({
      auth: state,
      version,
      // QR tidak di-print ke terminal; UI mengambilnya via GET /qr.
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      browser: Browsers.windows("WhatsApp Tools"),
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      // Update pertama = bukti handshake berjalan (channel hidup).
      this.readySignal.markSeen();
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        this.qr = qr;
        this.setState("pairing");
      }
      if (connection === "open") {
        this.qr = null;
        // Koneksi sukses: reset backoff + batalkan timer reconnect sisa.
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // user.id berbentuk "628xx@s.whatsapp.net" (atau "xxx:yy@lid").
        const rawId = sock.user?.id ?? null;
        this.phone = rawId
          ? rawId.split("@")[0]?.split(":")[0] ?? rawId
          : null;
        // Koneksi sukses (lagi) -> watchdog bersenjata kembali.
        this.watchdogArmed = true;
        this.setState("connected");
      }
      if (connection === "close") {
        this.sock = null;
        this.qr = null;
        const code = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        // Catat untuk /health + watchdog, SEBELUM setState.
        this.lastDisconnectAt = Date.now();
        // Stop manual melucuti watchdog; putus tak terduga mempersenjatai.
        this.watchdogArmed = !this.stopped;
        this.setState("disconnected");
        // Reconnect otomatis (SPEC §3.1), kecuali logout eksplisit
        // atau stop() sudah dipanggil. Backoff eksponensial (skill
        // whatsapp-baileys: hindari loop reconnect rapat) + timer
        // dilacak supaya stop manual bisa membatalkannya.
        if (!loggedOut && !this.stopped) {
          const delay = reconnectDelayMs(this.reconnectAttempts);
          this.reconnectAttempts += 1;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Stop manual yang datang setelah timer dijadwalkan harus
            // tetap dihormati (timer basi tidak boleh menghidupkan lagi).
            if (this.stopped) return;
            void this.connect().catch(() => {
              // Gagal reconnect: state tetap disconnected sampai
              // /start berikutnya; tidak ada throw yang tak tertangani.
            });
          }, delay);
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages) {
        const incoming = baileysMessageToIncoming(m);
        if (!incoming) continue;
        for (const h of this.messageHandlers) {
          try {
            h(incoming);
          } catch {
            // Handler sync gagal tidak boleh meruntuhkan socket.
          }
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    // Batalkan timer reconnect yang mungkin masih pending supaya
    // stop manual benar-benar menghentikan koneksi.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    this.qr = null;
    // Stop manual: catat waktu putus untuk /health, tapi LUCUTI
    // watchdog (penghentian disengaja bukan crash).
    this.lastDisconnectAt = Date.now();
    this.watchdogArmed = false;
    try {
      sock?.end(undefined);
    } catch {
      // Socket sudah mati: abaikan.
    }
    this.setState("disconnected");
  }

  /**
   * Jalur fallback bila QR bermasalah (SPEC §3.1). `phone` = digit
   * dengan kode negara, tanpa `+` (sudah dinormalisasi server).
   * Bila socket belum ada, connect() dulu (membuat socket + mulai
   * pairing); bila socket sudah ada (QR sedang menunggu), pakai
   * socket itu — jangan buat socket kedua.
   * SEBELUM menembak requestPairingCode, socket WAJIB ready: tunggu
   * connection.update pertama (maks PAIRING_READY_TIMEOUT_MS). Tanpa
   * ini, query ditembak ke socket yang handshake-nya belum selesai
   * dan Baileys throw -> 502 pairing_failed. Bila socket sudah punya
   * QR (state pairing), anggap ready tanpa menunggu. Timeout ->
   * throw Error("socket_not_ready"). Satu percobaan setelah ready,
   * tanpa retry tanpa batas.
   */
  async requestPairingCode(phone: string): Promise<string> {
    if (this.isConnected()) {
      throw new Error("already_connected");
    }
    if (!this.sock) {
      await this.connect();
    }
    if (this.registered === true) {
      throw new Error("already_registered");
    }
    if (!this.sock) {
      throw new Error("not_started");
    }
    if (this.getState() !== "pairing" && !this.readySignal.isSeen()) {
      const ready = await this.readySignal.wait(PAIRING_READY_TIMEOUT_MS);
      if (!ready) {
        throw new Error("socket_not_ready");
      }
      if (!this.sock) {
        throw new Error("not_started");
      }
    }
    const code = await this.sock.requestPairingCode(phone);
    // Kode diminta -> user sedang dalam proses pairing, sama seperti
    // menunggu scan QR; event "open" nanti yang mengubah ke connected.
    if (!this.isConnected()) {
      this.setState("pairing");
    }
    return code;
  }

  async sendMessage(jid: string, text: string): Promise<{ id: string }> {
    if (!this.sock || !this.isConnected()) {
      throw new Error("not_connected: wa-engine belum terhubung");
    }
    const sent = await this.sock.sendMessage(jid, { text });
    const id = sent?.key?.id;
    if (!id) throw new Error("send_failed: Baileys tidak mengembalikan id");
    return { id };
  }
}

// ---------------------------------------------------------------------------
// MockTransport — in-memory, untuk test & mode default yang aman.
// Tidak pernah menyentuh jaringan WhatsApp.
// ---------------------------------------------------------------------------

export interface MockSentMessage {
  jid: string;
  text: string;
  id: string;
}

export class MockTransport implements WaTransport, TransportControl {
  private state: EngineState = "idle";
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly stateHandlers: StateHandler[] = [];
  readonly sent: MockSentMessage[] = [];
  private counter = 0;
  private lastDisconnectAt: number | null = null;
  private watchdogArmed = false;
  private pairingCodeCounter = 0;

  isConnected(): boolean {
    return this.state === "connected";
  }

  getState(): EngineState {
    return this.state;
  }

  getQr(): string | null {
    // Mock tidak punya QR asli; pairing mock langsung connected.
    return null;
  }

  getPhone(): string | null {
    // Mock tidak terikat nomor sungguhan.
    return null;
  }

  getLastDisconnectAt(): number | null {
    return this.lastDisconnectAt;
  }

  isWatchdogArmed(): boolean {
    return this.watchdogArmed;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onStateChange(handler: StateHandler): void {
    this.stateHandlers.push(handler);
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return;
    this.state = "connected";
    this.watchdogArmed = true;
    emitState(this.stateHandlers, "connected");
  }

  async disconnect(): Promise<void> {
    // Stop manual: lucuti watchdog (sama seperti BaileysTransport).
    this.state = "disconnected";
    this.lastDisconnectAt = Date.now();
    this.watchdogArmed = false;
    emitState(this.stateHandlers, "disconnected");
  }

  /**
   * Simulasikan putus TAK TERDUGA (bukan stop manual): watchdog tetap
   * bersenjata. Dipakai test watchdog; tidak ada efek jaringan.
   */
  simulateUnexpectedDisconnect(): void {
    this.state = "disconnected";
    this.lastDisconnectAt = Date.now();
    this.watchdogArmed = true;
    emitState(this.stateHandlers, "disconnected");
  }

  /**
   * Mock requestPairingCode: dari idle langsung ke "pairing" (tidak
   * ke "connected") supaya alur test mirrors Baileys asli — user
   * memasukkan kode di HP dulu, baru connected via
   * simulatePairingComplete(). Kode 8 digit deterministik per
   * permintaan (10000001, 10000002, ...) supaya "minta kode baru"
   * bisa dites (kode berubah).
   */
  async requestPairingCode(_phone: string): Promise<string> {
    if (this.isConnected()) {
      throw new Error("already_connected");
    }
    this.pairingCodeCounter += 1;
    const code = String(10_000_000 + this.pairingCodeCounter);
    this.state = "pairing";
    emitState(this.stateHandlers, "pairing");
    return code;
  }

  /** Simulasikan user memasukkan kode di HP -> koneksi open. */
  simulatePairingComplete(): void {
    if (this.state !== "pairing") return;
    this.state = "connected";
    this.watchdogArmed = true;
    emitState(this.stateHandlers, "connected");
  }

  async sendMessage(jid: string, text: string): Promise<{ id: string }> {
    if (!this.isConnected()) {
      throw new Error("not_connected: mock transport belum connected");
    }
    this.counter += 1;
    const id = `mock-${this.counter}`;
    this.sent.push({ jid, text, id });
    return { id };
  }

  /** Simulasikan pesan masuk untuk test (tanpa jaringan). */
  simulateIncoming(msg: IncomingMessage): void {
    for (const h of this.messageHandlers) {
      h(msg);
    }
  }
}
