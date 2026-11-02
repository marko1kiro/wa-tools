import { describe, expect, it } from "vitest";
import {
  PAIRING_READY_TIMEOUT_MS,
  ReadySignal,
} from "../src/transport";

// Test unit ReadySignal (perbaikan race requestPairingCode, SPEC §3.1).
// Murni in-memory, tanpa socket Baileys sungguhan.
describe("ReadySignal", () => {
  it("timeout default 15 detik", () => {
    expect(PAIRING_READY_TIMEOUT_MS).toBe(15_000);
  });

  it("wait langsung true bila sudah seen", async () => {
    const sig = new ReadySignal();
    sig.markSeen();
    expect(sig.isSeen()).toBe(true);
    await expect(sig.wait(50)).resolves.toBe(true);
  });

  it("wait false bila timeout tanpa sinyal", async () => {
    const sig = new ReadySignal();
    await expect(sig.wait(20)).resolves.toBe(false);
    expect(sig.isSeen()).toBe(false);
  });

  it("markSeen membangunkan waiter yang menunggu", async () => {
    const sig = new ReadySignal();
    const pending = sig.wait(5_000);
    setTimeout(() => sig.markSeen(), 10);
    await expect(pending).resolves.toBe(true);
    expect(sig.isSeen()).toBe(true);
  });

  it("reset menghapus seen sehingga wait berikutnya timeout lagi", async () => {
    const sig = new ReadySignal();
    sig.markSeen();
    sig.reset();
    expect(sig.isSeen()).toBe(false);
    await expect(sig.wait(20)).resolves.toBe(false);
  });
});
