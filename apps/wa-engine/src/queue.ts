// Antrean kirim jadwal (SPEC §3.3, §8).
//
// File ini SENGAJA tidak mengimpor file worker lain (tidak ada import
// dari index.ts, koneksi Baileys, maupun @wa-tools/db): transport dan
// store berbentuk struktural, sehingga unit test bisa memakai mock dan
// koordinator yang wiring nanti cukup mengadaptasi Drizzle/Baileys ke
// interface di bawah. File ini juga TIDAK di-wire ke index.ts — wiring
// adalah tugas koordinator.
//
// Cara adaptasi untuk koordinator (Drizzle, tabel schedules):
// - listDue(nowMs): status = 'terjadwal' AND waktu_kirim <= nowMs,
//   ORDER BY waktu_kirim ASC.
// - countSentToday(dayStartMs): COUNT(*) status = 'terkirim' AND
//   waktu_kirim >= dayStartMs (waktu_kirim dipakai sebagai proksi waktu
//   terkirim karena tabel tidak punya kolom waktu-terkirim sendiri).
// - markSent(id): status = 'terkirim'.
// - recordFailure(id, attempts, lastError, status): percobaan = attempts,
//   error_terakhir = lastError, status = status.
//
// DEFAULT PENGAMAN (nomor utama user, SPEC §8 — konservatif, karena
// banned = kehilangan nomor harian):
// - delay_min_ms 30000, delay_max_ms 90000 (jeda acak antar kirim)
// - daily_limit 50 (maks jadwal terkirim per hari kalender lokal)
// - quiet_hours "22:00-07:00" (jam tenang, dukung rentang lewat tengah malam)
// - queue_paused: "1"/"true" = antrean berhenti total.
// Menaikkan batas di atas default adalah risiko user sendiri (Pengaturan).

export interface QueueSchedule {
  id: string;
  chatJid: string;
  body: string;
  sendAt: number; // epoch ms
  status: string;
  attempts: number;
  lastError: string | null;
}

/** Store minimal yang dibutuhkan runner (diadaptasi koordinator dari Drizzle). */
export interface QueueStore {
  listDue(nowMs: number): Promise<QueueSchedule[]>;
  countSentToday(dayStartMs: number): Promise<number>;
  markSent(id: string): Promise<void>;
  recordFailure(
    id: string,
    attempts: number,
    lastError: string,
    status: "terjadwal" | "gagal",
  ): Promise<void>;
}

/** Transport struktural (diadaptasi koordinator dari Baileys). */
export interface QueueTransport {
  isConnected(): boolean;
  sendMessage(jid: string, text: string): Promise<{ id: string }>;
}

/**
 * Settings bisa diberikan sebagai record polos (mudah di-test) atau
 * fungsi pembaca (mudah di-wire ke tabel settings: dibaca ulang tiap
 * item, jadi toggle pause langsung berlaku tanpa restart runner).
 * Nilai boleh string ("1", "30000", "22:00-07:00") atau number/boolean.
 */
export type QueueSettingsInput =
  | Record<string, string | number | boolean | undefined>
  | (() => Record<string, string | number | boolean | undefined> | Promise<Record<string, string | number | boolean | undefined>>)
  | undefined;

export interface CreateQueueRunnerOptions {
  db: QueueStore;
  transport: QueueTransport;
  /** Default: Date.now. Di-inject di test. */
  now?: () => number;
  /** Default: setTimeout. Di-inject di test (tanpa tidur beneran). */
  sleep?: (ms: number) => Promise<void>;
  /** Default: Math.random. Di-inject di test (jeda deterministik). */
  random?: () => number;
  settings?: QueueSettingsInput;
  /** Interval poll. Default 30 detik (SPEC: antrean kirim). */
  intervalMs?: number;
  /** Dipanggil bila runOnce gagal di luar kirim per-item (mis. DB down). */
  onError?: (error: unknown) => void;
}

export interface QueueRunSummary {
  sent: number;
  failed: number;
  skippedQuietHours: number;
  stopped: "paused" | "disconnected" | "daily-limit" | null;
}

export interface QueueRunner {
  /** Satu sapuan: proses semua jadwal jatuh tempo saat ini. */
  runOnce(): Promise<QueueRunSummary>;
  /** Mulai poll berkala (runOnce tiap intervalMs). Aman dipanggil 2x. */
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export const DEFAULT_QUEUE_SETTINGS = {
  delayMinMs: 30_000,
  delayMaxMs: 90_000,
  dailyLimit: 50,
  quietHours: "22:00-07:00",
} as const;

const MAX_FAILURES = 3;

/** Awal hari kalender lokal (batas hitung "terkirim hari ini"). */
export function startOfLocalDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

interface QuietRange {
  startMin: number;
  endMin: number;
}

/** Parse "22:00-07:00". null = format tidak dikenali. */
export function parseQuietHours(raw: string | undefined): QuietRange | null {
  if (raw === undefined) return null;
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const startH = Number(match[1]);
  const startM = Number(match[2]);
  const endH = Number(match[3]);
  const endM = Number(match[4]);
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;
  return { startMin: startH * 60 + startM, endMin: endH * 60 + endM };
}

/**
 * Apakah `nowMs` masuk jam tenang. Rentang lewat tengah malam didukung:
 * "22:00-07:00" berarti t >= 22:00 ATAU t < 07:00. Rentang normal
 * ("09:00-12:00") berarti start <= t < end.
 */
export function isInQuietHours(nowMs: number, raw: string | undefined): boolean {
  const range = parseQuietHours(raw);
  if (!range) return false;
  const date = new Date(nowMs);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  if (range.startMin < range.endMin) {
    return minuteOfDay >= range.startMin && minuteOfDay < range.endMin;
  }
  if (range.startMin > range.endMin) {
    return minuteOfDay >= range.startMin || minuteOfDay < range.endMin;
  }
  return false; // start == end: rentang kosong, tidak pernah tenang
}

interface ResolvedSettings {
  paused: boolean;
  quietHours: string;
  dailyLimit: number;
  delayMinMs: number;
  delayMaxMs: number;
}

async function readSettingsMap(
  input: QueueSettingsInput,
): Promise<Record<string, string | number | boolean | undefined>> {
  if (!input) return {};
  if (typeof input === "function") return (await input()) ?? {};
  return input;
}

function parseIntSetting(
  value: string | number | boolean | undefined,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

async function resolveSettings(input: QueueSettingsInput): Promise<ResolvedSettings> {
  const map = await readSettingsMap(input);
  const pausedRaw = map.queue_paused;
  const paused =
    pausedRaw === true ||
    (typeof pausedRaw === "string" && ["1", "true"].includes(pausedRaw.trim().toLowerCase())) ||
    (typeof pausedRaw === "number" && pausedRaw === 1);
  // quiet_hours: string kosong = opt-out eksplisit (tanpa jam tenang);
  // tidak diatur = default konservatif; format rusak = default (fail-safe).
  const quietRaw = map.quiet_hours;
  let quietHours: string;
  if (typeof quietRaw === "string" && quietRaw.trim() === "") {
    quietHours = "";
  } else if (typeof quietRaw === "string" && parseQuietHours(quietRaw) !== null) {
    quietHours = quietRaw.trim();
  } else {
    quietHours = DEFAULT_QUEUE_SETTINGS.quietHours;
  }
  const dailyLimitRaw = parseIntSetting(map.daily_limit, DEFAULT_QUEUE_SETTINGS.dailyLimit);
  const dailyLimit = dailyLimitRaw < 0 ? DEFAULT_QUEUE_SETTINGS.dailyLimit : dailyLimitRaw;
  let delayMinMs = parseIntSetting(map.delay_min_ms, DEFAULT_QUEUE_SETTINGS.delayMinMs);
  let delayMaxMs = parseIntSetting(map.delay_max_ms, DEFAULT_QUEUE_SETTINGS.delayMaxMs);
  if (delayMinMs < 0) delayMinMs = DEFAULT_QUEUE_SETTINGS.delayMinMs;
  if (delayMaxMs < 0) delayMaxMs = DEFAULT_QUEUE_SETTINGS.delayMaxMs;
  if (delayMinMs > delayMaxMs) [delayMinMs, delayMaxMs] = [delayMaxMs, delayMinMs];
  return { paused, quietHours, dailyLimit, delayMinMs, delayMaxMs };
}

export function createQueueRunner(options: CreateQueueRunnerOptions): QueueRunner {
  const nowFn = options.now ?? Date.now;
  const sleepFn =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomFn = options.random ?? Math.random;
  const intervalMs = options.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<QueueRunSummary> {
    // Guard global sekali di awal (gagal cepat sebelum menyentuh DB jadwal).
    const initial = await resolveSettings(options.settings);
    if (initial.paused) {
      return { sent: 0, failed: 0, skippedQuietHours: 0, stopped: "paused" };
    }
    if (!options.transport.isConnected()) {
      // Auto-pause: JANGAN tandai gagal, biarkan tetap terjadwal.
      return { sent: 0, failed: 0, skippedQuietHours: 0, stopped: "disconnected" };
    }

    const nowMs = nowFn();
    const due = await options.db.listDue(nowMs);
    let sentToday = await options.db.countSentToday(startOfLocalDay(nowMs));
    let sent = 0;
    let failed = 0;
    let skippedQuietHours = 0;
    let attempted = false;

    for (const item of due) {
      // Guard berurutan SEBELUM tiap kirim (settings dibaca ulang tiap
      // item supaya pause/disconnect langsung menghentikan antrean).
      const cfg = await resolveSettings(options.settings);
      if (cfg.paused) {
        return { sent, failed, skippedQuietHours, stopped: "paused" };
      }
      if (!options.transport.isConnected()) {
        // Auto-pause: sisa jadwal dibiarkan tetap terjadwal.
        return { sent, failed, skippedQuietHours, stopped: "disconnected" };
      }
      if (isInQuietHours(nowFn(), cfg.quietHours)) {
        // Lewati item ini saja (tetap terjadwal, dicoba lagi di sapuan
        // berikut); bukan gagal, bukan berhenti total.
        skippedQuietHours += 1;
        continue;
      }
      if (sentToday >= cfg.dailyLimit) {
        return { sent, failed, skippedQuietHours, stopped: "daily-limit" };
      }
      if (attempted) {
        // Jeda acak ANTARA kirim (bukan sebelum kirim pertama).
        const delay = Math.floor(
          cfg.delayMinMs + randomFn() * (cfg.delayMaxMs - cfg.delayMinMs + 1),
        );
        await sleepFn(delay);
      }
      attempted = true;
      try {
        await options.transport.sendMessage(item.chatJid, item.body);
        await options.db.markSent(item.id);
        sent += 1;
        sentToday += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        const status = attempts >= MAX_FAILURES ? "gagal" : "terjadwal";
        await options.db.recordFailure(item.id, attempts, lastError, status);
        failed += 1;
      }
    }
    return { sent, failed, skippedQuietHours, stopped: null };
  }

  function start(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      runOnce().catch((error: unknown) => {
        if (options.onError) options.onError(error);
      });
    }, intervalMs);
    // Jangan menahan proses engine tetap hidup hanya karena timer ini.
    const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") maybeUnref.call(timer);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { runOnce, start, stop, isRunning: () => timer !== null };
}
