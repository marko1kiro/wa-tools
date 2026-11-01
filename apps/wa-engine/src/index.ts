import path from "node:path";
import { ensureSchema } from "@wa-tools/db";
import { BaileysTransport, MockTransport } from "./transport.js";
import { startEngineServer } from "./server.js";
import { createQueueRunner } from "./queue.js";
import {
  createDrizzleQueueStore,
  readSettingsMap,
} from "./store.js";
import { acquireLock, releaseLock } from "./lock.js";
import {
  resolveWatchdogThresholdMs,
  shouldExitWatchdog,
  WATCHDOG_CHECK_INTERVAL_MS,
} from "./watchdog.js";

// Entry point wa-engine (SPEC §5 + §13 deployment).
// - Mode DEFAULT = MOCK (aman): tidak ada koneksi WhatsApp sungguhan,
//   tidak ada QR asli, tidak ada pesan sungguhan.
// - Transport real (Baileys) hanya dipakai bila WA_ENGINE_MOCK=0, DAN
//   koneksi baru jalan saat endpoint POST /start dipanggil — modul ini
//   sendiri TIDAK PERNAH auto-connect.
// - Queue runner di-wire di sini: membaca settings dari tabel settings
//   tiap item (toggle pause berlaku tanpa restart), dan /status
//   melaporkan queuePaused dari cache + status koneksi.
// - Single-instance lock (SPEC §13.4) diakuisisi SEBELUM apa pun:
//   proses kedua keluar dengan kode 2 bila satu sudah jalan.
// - Watchdog internal (SPEC §13.3): soket mati melewati ambang tanpa
//   reconnect sukses -> exit(1) sengaja supaya NSSM me-restart-nya.
//   TIDAK PERNAH memicu saat pairing awal (belum pernah connected)
//   maupun saat stop manual (POST /stop melucuti senjata).

const PORT = Number(process.env.WA_ENGINE_PORT ?? 3101);
const MOCK = process.env.WA_ENGINE_MOCK !== "0";
const STARTED_AT = Date.now();
const LOCK_PATH = path.resolve(
  process.env.WA_ENGINE_LOCK_FILE ?? "./data/wa-engine.lock",
);
const WATCHDOG_THRESHOLD_MS = resolveWatchdogThresholdMs(
  process.env.WATCHDOG_DEAD_MS,
);

// Cache untuk /status (getter-nya sinkron). Default fail-closed: true.
// Runner sendiri membaca settings segar dari DB tiap item, jadi cache
// ini hanya memengaruhi tampilan status, bukan keputusan kirim.
let cachedQueuePaused = true;

async function refreshSettingsCache(): Promise<void> {
  try {
    const map = await readSettingsMap();
    const raw = map.queue_paused;
    cachedQueuePaused =
      raw === "1" || raw === "true" || raw === true;
  } catch {
    // Pertahankan nilai terakhir (fail-closed bila belum pernah terbaca).
  }
}

async function main(): Promise<void> {
  // Lock dulu, sebelum schema/server/queue: dua proses tidak boleh
  // berbagi satu sesi Baileys sedetik pun.
  const lock = acquireLock(LOCK_PATH);
  if (!lock.acquired) {
    console.error(
      `[wa-engine] tidak bisa start: ${lock.reason ?? "lock ditahan proses lain"}` +
        `. Lock: ${LOCK_PATH}. Bila yakin tidak ada wa-engine jalan, ` +
        "hapus file lock itu lalu start lagi.",
    );
    process.exit(2);
  }

  await ensureSchema();
  await refreshSettingsCache();

  const transport = MOCK ? new MockTransport() : new BaileysTransport();
  const store = createDrizzleQueueStore();
  const runner = createQueueRunner({
    db: store,
    transport,
    settings: () => readSettingsMap(),
    onError: (err: unknown) => {
      console.error(
        "[wa-engine] queue error:",
        err instanceof Error ? err.message : err,
      );
    },
  });

  const { handle, port } = await startEngineServer(
    {
      transport,
      mock: MOCK,
      queuePaused: () => cachedQueuePaused || !transport.isConnected(),
      startedAt: STARTED_AT,
    },
    Number.isFinite(PORT) ? PORT : 3101,
  );
  runner.start();
  const cacheTimer = setInterval(() => {
    void refreshSettingsCache();
  }, 15_000);
  cacheTimer.unref();

  // Watchdog: cek berkala, exit(1) bila soket mati melewati ambang.
  // Timer di-unref supaya tidak menahan proses sendirian.
  const watchdogTimer = setInterval(() => {
    if (WATCHDOG_THRESHOLD_MS <= 0) return;
    const fire = shouldExitWatchdog({
      armed: transport.isWatchdogArmed?.() ?? false,
      state: transport.getState?.() ?? "idle",
      lastDisconnectAtMs: transport.getLastDisconnectAt?.() ?? null,
      nowMs: Date.now(),
      thresholdMs: WATCHDOG_THRESHOLD_MS,
    });
    if (!fire) return;
    console.error(
      `[wa-engine] watchdog: soket mati >${WATCHDOG_THRESHOLD_MS}ms tanpa ` +
        "reconnect sukses — exit sengaja supaya service manager me-restart.",
    );
    releaseLock(LOCK_PATH);
    process.exit(1);
  }, WATCHDOG_CHECK_INTERVAL_MS);
  watchdogTimer.unref();

  const shutdown = (): void => {
    runner.stop();
    clearInterval(cacheTimer);
    clearInterval(watchdogTimer);
    releaseLock(LOCK_PATH);
    handle.server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[wa-engine] listening on 127.0.0.1:${port} (mock=${MOCK ? "on" : "off"})`,
  );
  console.log(`[wa-engine] lock: ${LOCK_PATH}`);
  console.log(
    `[wa-engine] watchdog: ${
      WATCHDOG_THRESHOLD_MS <= 0
        ? "nonaktif (WATCHDOG_DEAD_MS=0)"
        : `ambang ${WATCHDOG_THRESHOLD_MS}ms, cek tiap ${WATCHDOG_CHECK_INTERVAL_MS}ms`
    }`,
  );
  if (MOCK) {
    console.log(
      "[wa-engine] mode MOCK: POST /start hanya mengaktifkan mock, " +
        "bukan koneksi WhatsApp sungguhan.",
    );
  }
}

main().catch((err: unknown) => {
  console.error(
    "[wa-engine] fatal:",
    err instanceof Error ? err.message : err,
  );
  releaseLock(LOCK_PATH);
  process.exit(1);
});
