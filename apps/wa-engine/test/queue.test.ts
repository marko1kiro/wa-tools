// Test antrean kirim. Transport + store di-mock penuh: tidak ada
// koneksi WhatsApp sungguhan, tidak ada pesan sungguhan, tidak ada DB.
import { describe, expect, it, vi } from "vitest";
import {
  createQueueRunner,
  isInQuietHours,
  parseQuietHours,
  startOfLocalDay,
  type QueueSchedule,
  type QueueStore,
  type QueueTransport,
} from "../src/queue";

function makeSchedule(partial: Partial<QueueSchedule> & { id: string }): QueueSchedule {
  return {
    chatJid: "62812@s.whatsapp.net",
    body: "halo",
    sendAt: 1_000,
    status: "terjadwal",
    attempts: 0,
    lastError: null,
    ...partial,
  };
}

interface FakeStore extends QueueStore {
  rows: QueueSchedule[];
  sentToday: number;
  sentIds: string[];
}

function makeStore(rows: QueueSchedule[], sentToday = 0): FakeStore {
  const store: FakeStore = {
    rows: rows.map((r) => ({ ...r })),
    sentToday,
    sentIds: [],
    async listDue(nowMs: number) {
      return this.rows.filter((r) => r.status === "terjadwal" && r.sendAt <= nowMs);
    },
    async countSentToday() {
      return this.sentToday;
    },
    async markSent(id: string) {
      const row = this.rows.find((r) => r.id === id);
      if (row) row.status = "terkirim";
      this.sentIds.push(id);
      this.sentToday += 1;
    },
    async recordFailure(id: string, attempts: number, lastError: string, status: "terjadwal" | "gagal") {
      const row = this.rows.find((r) => r.id === id);
      if (row) {
        row.attempts = attempts;
        row.lastError = lastError;
        row.status = status;
      }
    },
  };
  return store;
}

function makeTransport(connected = true, failTimes = 0): QueueTransport & { sent: Array<{ jid: string; text: string }>; calls: number } {
  const transport = {
    sent: [] as Array<{ jid: string; text: string }>,
    calls: 0,
    connected,
    isConnected() {
      return this.connected;
    },
    async sendMessage(jid: string, text: string) {
      this.calls += 1;
      if (this.calls <= failTimes) throw new Error(`gagal kirim #${this.calls}`);
      this.sent.push({ jid, text });
      return { id: `wamid.${this.calls}` };
    },
  };
  return transport;
}

/** Senin 2026-11-02 12:00 lokal (di luar jam tenang default 22:00-07:00). */
const NOON = new Date(2026, 10, 2, 12, 0, 0).getTime();
/** Senin 2026-11-02 23:30 lokal (di dalam jam tenang default). */
const NIGHT = new Date(2026, 10, 2, 23, 30, 0).getTime();

const OPEN_SETTINGS = { queue_paused: "0", quiet_hours: "", daily_limit: 50, delay_min_ms: 30000, delay_max_ms: 90000 };

describe("parseQuietHours / isInQuietHours", () => {
  it("rentang lewat tengah malam: 23:30 tenang, 12:00 tidak, 06:59 tenang, 07:00 tidak", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ startMin: 1320, endMin: 420 });
    expect(isInQuietHours(new Date(2026, 10, 2, 23, 30).getTime(), "22:00-07:00")).toBe(true);
    expect(isInQuietHours(new Date(2026, 10, 2, 12, 0).getTime(), "22:00-07:00")).toBe(false);
    expect(isInQuietHours(new Date(2026, 10, 2, 6, 59).getTime(), "22:00-07:00")).toBe(true);
    expect(isInQuietHours(new Date(2026, 10, 2, 7, 0).getTime(), "22:00-07:00")).toBe(false);
  });

  it("rentang normal (tidak lewat tengah malam) bekerja", () => {
    expect(isInQuietHours(new Date(2026, 10, 2, 10, 0).getTime(), "09:00-12:00")).toBe(true);
    expect(isInQuietHours(new Date(2026, 10, 2, 13, 0).getTime(), "09:00-12:00")).toBe(false);
  });

  it("format rusak -> null (runner fallback ke default, bukan crash)", () => {
    expect(parseQuietHours("ngaco")).toBeNull();
    expect(parseQuietHours("25:00-07:00")).toBeNull();
  });
});

describe("createQueueRunner.runOnce", () => {
  it("sukses -> terkirim, summary sent=1", async () => {
    const store = makeStore([makeSchedule({ id: "s1" })]);
    const transport = makeTransport();
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    const summary = await runner.runOnce();
    expect(summary).toEqual({ sent: 1, failed: 0, skippedQuietHours: 0, stopped: null });
    expect(store.rows[0].status).toBe("terkirim");
    expect(transport.sent).toEqual([{ jid: "62812@s.whatsapp.net", text: "halo" }]);
  });

  it("jeda acak: random 0.5 dengan min 30000 max 90000 -> sleep 60000, hanya antar kirim", async () => {
    const store = makeStore([
      makeSchedule({ id: "s1" }),
      makeSchedule({ id: "s2", body: "kedua" }),
      makeSchedule({ id: "s3", body: "ketiga" }),
    ]);
    const transport = makeTransport();
    const sleeps: number[] = [];
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      settings: OPEN_SETTINGS,
    });
    await runner.runOnce();
    expect(transport.sent).toHaveLength(3);
    expect(sleeps).toEqual([60000, 60000]); // 3 kirim -> 2 jeda, tanpa jeda sebelum kirim pertama
  });

  it("jeda acak real: sleep selalu dalam [min, max]", async () => {
    const store = makeStore([makeSchedule({ id: "s1" }), makeSchedule({ id: "s2" })]);
    const transport = makeTransport();
    const sleeps: number[] = [];
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      settings: OPEN_SETTINGS, // random default = Math.random
    });
    await runner.runOnce();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(30000);
    expect(sleeps[0]).toBeLessThanOrEqual(90000);
  });

  it("batas harian: sudah 50 terkirim -> berhenti, tidak ada yang dikirim", async () => {
    const store = makeStore([makeSchedule({ id: "s1" })], 50);
    const transport = makeTransport();
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    const summary = await runner.runOnce();
    expect(summary.stopped).toBe("daily-limit");
    expect(transport.sent).toHaveLength(0);
    expect(store.rows[0].status).toBe("terjadwal");
  });

  it("batas harian di tengah antrean: kirim 1 lalu berhenti", async () => {
    const store = makeStore(
      [makeSchedule({ id: "s1" }), makeSchedule({ id: "s2" })],
      49,
    );
    const transport = makeTransport();
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    const summary = await runner.runOnce();
    expect(summary.sent).toBe(1);
    expect(summary.stopped).toBe("daily-limit");
    expect(store.rows[1].status).toBe("terjadwal");
  });

  it("jam tenang: item dilewati (tetap terjadwal), bukan gagal", async () => {
    const store = makeStore([makeSchedule({ id: "s1" })]);
    const transport = makeTransport();
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NIGHT,
      sleep: async () => {},
      settings: { queue_paused: "0", quiet_hours: "22:00-07:00" },
    });
    const summary = await runner.runOnce();
    expect(summary).toEqual({ sent: 0, failed: 0, skippedQuietHours: 1, stopped: null });
    expect(transport.sent).toHaveLength(0);
    expect(store.rows[0].status).toBe("terjadwal");
  });

  it("auto-pause saat disconnect: berhenti, jadwal tetap terjadwal (bukan gagal)", async () => {
    const store = makeStore([makeSchedule({ id: "s1" })]);
    const transport = makeTransport(false);
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    const summary = await runner.runOnce();
    expect(summary.stopped).toBe("disconnected");
    expect(transport.sent).toHaveLength(0);
    expect(store.rows[0].status).toBe("terjadwal");
    expect(store.rows[0].attempts).toBe(0);
  });

  it("disconnect di tengah antrean menghentikan sisa antrean", async () => {
    const store = makeStore([makeSchedule({ id: "s1" }), makeSchedule({ id: "s2" })]);
    const transport = makeTransport(true);
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: () => {
        // Putus setelah kirim pertama.
        if (transport.sent.length >= 1) transport.connected = false;
        return OPEN_SETTINGS;
      },
    });
    const summary = await runner.runOnce();
    expect(summary.sent).toBe(1);
    expect(summary.stopped).toBe("disconnected");
    expect(store.rows[1].status).toBe("terjadwal");
  });

  it("queue_paused=1 -> berhenti total tanpa kirim", async () => {
    const store = makeStore([makeSchedule({ id: "s1" })]);
    const transport = makeTransport();
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: { queue_paused: "1", quiet_hours: "" },
    });
    const summary = await runner.runOnce();
    expect(summary.stopped).toBe("paused");
    expect(transport.sent).toHaveLength(0);
  });

  it("gagal 1x/2x -> tetap terjadwal dengan attempts + lastError", async () => {
    const store = makeStore([makeSchedule({ id: "s1", attempts: 1 })]);
    const transport = makeTransport(true, 1);
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    const summary = await runner.runOnce();
    expect(summary.failed).toBe(1);
    expect(store.rows[0].status).toBe("terjadwal");
    expect(store.rows[0].attempts).toBe(2);
    expect(store.rows[0].lastError).toMatch(/gagal kirim/);
  });

  it("gagal 3x -> status gagal", async () => {
    const store = makeStore([makeSchedule({ id: "s1", attempts: 2 })]);
    const transport = makeTransport(true, 1);
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    await runner.runOnce();
    expect(store.rows[0].status).toBe("gagal");
    expect(store.rows[0].attempts).toBe(3);
  });

  it("jadwal belum jatuh tempo tidak ikut diproses", async () => {
    const store = makeStore([makeSchedule({ id: "s1", sendAt: NOON + 60_000 })]);
    const transport = makeTransport();
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async () => {},
      settings: OPEN_SETTINGS,
    });
    const summary = await runner.runOnce();
    expect(summary.sent).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it("default pengaman konservatif saat settings kosong", async () => {
    // Tanpa settings: delay 30-90 detik, limit 50, jam tenang 22:00-07:00.
    const store = makeStore([makeSchedule({ id: "s1" }), makeSchedule({ id: "s2" })]);
    const transport = makeTransport();
    const sleeps: number[] = [];
    const runner = createQueueRunner({
      db: store,
      transport,
      now: () => NOON,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      settings: undefined,
    });
    await runner.runOnce();
    expect(sleeps).toEqual([30000]); // random 0 -> batas bawah default
    expect(startOfLocalDay(NOON)).toBe(new Date(2026, 10, 2, 0, 0, 0).getTime());
  });

  it("start/stop: isRunning + stop menghentikan poll", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([]);
      const transport = makeTransport();
      const runner = createQueueRunner({
        db: store,
        transport,
        now: () => NOON,
        sleep: async () => {},
        settings: OPEN_SETTINGS,
        intervalMs: 1000,
      });
      expect(runner.isRunning()).toBe(false);
      runner.start();
      expect(runner.isRunning()).toBe(true);
      runner.start(); // idempotent, tidak dobel timer
      await vi.advanceTimersByTimeAsync(2500);
      runner.stop();
      expect(runner.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
