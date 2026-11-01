import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/lock";

// Test single-instance lock (SPEC §13.4). Tidak menyentuh WA sungguhan;
// hanya file lock di folder temp.

function tempLockPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wa-lock-")), "wa-engine.lock");
}

/** PID yang dijamin sudah mati: proses yang langsung exit. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (r.status !== 0 || r.pid === undefined) throw new Error("gagal membuat proses mati");
  return r.pid;
}

describe("single-instance lock", () => {
  it("akuisisi pertama berhasil, kedua ditolak dengan PID pemilik", () => {
    const p = tempLockPath();
    const first = acquireLock(p);
    expect(first.acquired).toBe(true);
    const second = acquireLock(p);
    expect(second.acquired).toBe(false);
    expect(second.holderPid).toBe(process.pid);
    releaseLock(p);
  });

  it("setelah release, akuisisi berhasil lagi", () => {
    const p = tempLockPath();
    expect(acquireLock(p).acquired).toBe(true);
    releaseLock(p);
    expect(acquireLock(p).acquired).toBe(true);
    releaseLock(p);
  });

  it("lock stale (PID sudah mati) diambil alih", () => {
    const p = tempLockPath();
    writeFileSync(p, String(deadPid()));
    const r = acquireLock(p);
    expect(r.acquired).toBe(true);
    releaseLock(p);
  });

  it("isi lock bukan PID -> ditolak fail-closed", () => {
    const p = tempLockPath();
    writeFileSync(p, "bukan-pid");
    const r = acquireLock(p);
    expect(r.acquired).toBe(false);
    expect(r.reason).toMatch(/bukan PID valid/);
  });

  it("release tidak menghapus lock milik proses lain", () => {
    const p = tempLockPath();
    writeFileSync(p, String(deadPid() + 1_000_000));
    // deadPid()+1jt hampir pasti bukan PID proses ini; release harus
    // diam (tidak menghapus) karena isi != PID sendiri.
    releaseLock(p);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8").trim()).not.toBe(String(process.pid));
  });
});
