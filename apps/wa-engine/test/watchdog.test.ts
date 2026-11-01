import { describe, expect, it } from "vitest";
import {
  resolveWatchdogThresholdMs,
  shouldExitWatchdog,
  WATCHDOG_DEFAULT_THRESHOLD_MS,
} from "../src/watchdog";

// Test predikat watchdog (SPEC §13.3) — murni, tanpa timer/proses.

const BASE = {
  armed: true,
  state: "disconnected",
  lastDisconnectAtMs: 1_000_000,
  nowMs: 1_000_000 + 120_000,
  thresholdMs: 120_000,
};

describe("shouldExitWatchdog", () => {
  it("mati melewati ambang setelah pernah connected -> exit", () => {
    expect(shouldExitWatchdog(BASE)).toBe(true);
  });

  it("tepat di ambang -> exit (>=)", () => {
    expect(shouldExitWatchdog({ ...BASE, nowMs: 1_000_000 + 119_999 })).toBe(false);
    expect(shouldExitWatchdog({ ...BASE, nowMs: 1_000_000 + 120_000 })).toBe(true);
  });

  it("masih connected -> tidak exit", () => {
    expect(shouldExitWatchdog({ ...BASE, state: "connected" })).toBe(false);
  });

  it("belum pernah connected (belum bersenjata, mis. pairing awal) -> tidak exit", () => {
    expect(shouldExitWatchdog({ ...BASE, armed: false })).toBe(false);
  });

  it("belum pernah putus (lastDisconnect null) -> tidak exit", () => {
    expect(shouldExitWatchdog({ ...BASE, lastDisconnectAtMs: null })).toBe(false);
  });

  it("threshold 0 (nonaktif) -> tidak pernah exit", () => {
    expect(shouldExitWatchdog({ ...BASE, thresholdMs: 0 })).toBe(false);
  });

  it("state pairing (belum connected, tapi bersenjata?) -> tidak exit bila connected? pairing bukan connected", () => {
    // Pairing setelah satu koneksi sukses lalu putus: state "pairing"
    // bukan "connected" -> watchdog tetap boleh exit bila ambang lewat.
    expect(shouldExitWatchdog({ ...BASE, state: "pairing" })).toBe(true);
  });
});

describe("resolveWatchdogThresholdMs", () => {
  it("undefined -> default 120000", () => {
    expect(resolveWatchdogThresholdMs(undefined)).toBe(WATCHDOG_DEFAULT_THRESHOLD_MS);
  });

  it("angka valid dipakai apa adanya", () => {
    expect(resolveWatchdogThresholdMs("30000")).toBe(30000);
  });

  it("'0' -> nonaktif", () => {
    expect(resolveWatchdogThresholdMs("0")).toBe(0);
  });

  it("tidak valid / negatif -> default", () => {
    expect(resolveWatchdogThresholdMs("abc")).toBe(WATCHDOG_DEFAULT_THRESHOLD_MS);
    expect(resolveWatchdogThresholdMs("-5")).toBe(WATCHDOG_DEFAULT_THRESHOLD_MS);
  });
});
