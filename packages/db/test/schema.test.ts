import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
  chats,
  contacts,
  drafts,
  messages,
  schedules,
  settings,
} from "../src/schema";

// Smoke test scaffold: memastikan semua tabel SPEC §7 terdefinisi
// dengan nama yang benar, tanpa perlu koneksi database.
describe("schema SPEC §7", () => {
  it("mendefinisikan semua tabel Fase 1", () => {
    expect(getTableConfig(contacts).name).toBe("contacts");
    expect(getTableConfig(chats).name).toBe("chats");
    expect(getTableConfig(messages).name).toBe("messages");
    expect(getTableConfig(schedules).name).toBe("schedules");
    expect(getTableConfig(drafts).name).toBe("drafts");
    expect(getTableConfig(settings).name).toBe("settings");
  });

  it("punya kolom kunci", () => {
    // Akses kolom langsung via properti tabel (tahan terhadap perbedaan
    // bentuk internal getTableConfig antar versi drizzle-orm).
    expect(messages.chatJid).toBeDefined();
    expect(messages.timestamp).toBeDefined();
    expect(schedules.sendAt).toBeDefined();
    expect(drafts.tone).toBeDefined();
    expect(settings.key).toBeDefined();
  });
});
