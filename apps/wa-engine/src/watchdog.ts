// Watchdog internal wa-engine (SPEC §13.3): fail-fast, bukan mati suri.
//
// Aturan (predikat murni, bisa di-unit-test tanpa timer/proses):
// - Watchdog HANYA bersenjata setelah satu koneksi sukses (armed).
//   State pairing awal (QR belum discan) TIDAK PERNAH memicu exit —
//   kalau tidak, proses akan restart loop selamanya sebelum pairing.
// - Setelah bersenjata, bila state bukan "connected" DAN waktu sejak
//   disconnect terakhir melewati ambang, watchdog memerintahkan exit.
//   Di index.ts, exit ini ditangkap NSSM (AppExit Default Restart)
//   sehingga proses lahir baru dan Baileys reconnect dari awal.
// - Stop disengaja (POST /stop) MELUCUTI senjata (armed=false) —
//   penghentian manual bukan crash dan tidak boleh di-restart.
// - Threshold 0 = watchdog nonaktif (opt-out eksplisit).
//
// Default ambang: 120 detik. Alasan: backoff reconnect Baileys bisa
// puluhan detik; 120 detik cukup longgar untuk reconnect transient,
// tapi cukup cepat supaya service tidak menggantung berjam-jam.
// Override: env WATCHDOG_DEAD_MS. Interval cek di index.ts: 15 detik.

export const WATCHDOG_DEFAULT_THRESHOLD_MS = 120_000;
export const WATCHDOG_CHECK_INTERVAL_MS = 15_000;

export interface WatchdogState {
  /** true bila pernah connected sejak proses jalan & belum stop manual. */
  armed: boolean;
  /** state transport saat ini ("connected" | "disconnected" | ...). */
  state: string;
  /** epoch ms disconnect terakhir, atau null bila belum pernah putus. */
  lastDisconnectAtMs: number | null;
}

export function shouldExitWatchdog(
  input: WatchdogState & { nowMs: number; thresholdMs: number },
): boolean {
  if (input.thresholdMs <= 0) return false;
  if (!input.armed) return false;
  if (input.state === "connected") return false;
  if (input.lastDisconnectAtMs === null) return false;
  return input.nowMs - input.lastDisconnectAtMs >= input.thresholdMs;
}

/** Baca ambang dari env: angka ms; tidak valid -> default; "0" -> nonaktif. */
export function resolveWatchdogThresholdMs(
  envValue: string | undefined,
): number {
  if (envValue === undefined) return WATCHDOG_DEFAULT_THRESHOLD_MS;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n < 0) return WATCHDOG_DEFAULT_THRESHOLD_MS;
  return Math.floor(n);
}
