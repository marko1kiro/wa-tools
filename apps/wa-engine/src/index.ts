import { ensureSchema } from "@wa-tools/db";
import { BaileysTransport, MockTransport } from "./transport.js";
import { startEngineServer } from "./server.js";
import { createQueueRunner } from "./queue.js";
import {
  createDrizzleQueueStore,
  readSettingsMap,
} from "./store.js";

// Entry point wa-engine (SPEC §5): HTTP server + queue runner.
// - Mode DEFAULT = MOCK (aman): tidak ada koneksi WhatsApp sungguhan,
//   tidak ada QR asli, tidak ada pesan sungguhan.
// - Transport real (Baileys) hanya dipakai bila WA_ENGINE_MOCK=0, DAN
//   koneksi baru jalan saat endpoint POST /start dipanggil — modul ini
//   sendiri TIDAK PERNAH auto-connect.
// - Queue runner di-wire di sini (koordinator): membaca settings dari
//   tabel settings tiap item (toggle pause berlaku tanpa restart),
//   dan /status melaporkan queuePaused dari cache + status koneksi.

const PORT = Number(process.env.WA_ENGINE_PORT ?? 3101);
const MOCK = process.env.WA_ENGINE_MOCK !== "0";

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
    },
    Number.isFinite(PORT) ? PORT : 3101,
  );
  runner.start();
  const cacheTimer = setInterval(() => {
    void refreshSettingsCache();
  }, 15_000);
  cacheTimer.unref();

  const shutdown = (): void => {
    runner.stop();
    clearInterval(cacheTimer);
    handle.server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[wa-engine] listening on 127.0.0.1:${port} (mock=${MOCK ? "on" : "off"})`,
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
  process.exit(1);
});
