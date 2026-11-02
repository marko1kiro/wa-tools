import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../src/transport.js";

// Backoff reconnect (skill whatsapp-baileys): mulai 3 detik,
// eksponensial, mentok 60 detik — supaya putus berulang tidak
// berubah jadi loop reconnect rapat.
describe("reconnectDelayMs", () => {
  it("percobaan 0/negatif -> 3000", () => {
    expect(reconnectDelayMs(0)).toBe(3000);
    expect(reconnectDelayMs(-1)).toBe(3000);
  });

  it("backoff eksponensial", () => {
    expect(reconnectDelayMs(1)).toBe(6000);
    expect(reconnectDelayMs(2)).toBe(12000);
    expect(reconnectDelayMs(3)).toBe(24000);
    expect(reconnectDelayMs(4)).toBe(48000);
  });

  it("mentok di 60000", () => {
    expect(reconnectDelayMs(5)).toBe(60000);
    expect(reconnectDelayMs(10)).toBe(60000);
  });
});
