// Helper tampilan murni (aman dipakai komponen server maupun client).

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

// SPEC §7: pesan media Fase 1 tampil sebagai placeholder, bukan error.
export function displayMessageText(msg: {
  type: string;
  text: string | null;
  caption: string | null;
}): string {
  if (msg.type === "teks") return msg.text ?? "";
  const base = "[media belum didukung]";
  return msg.caption ? `${base} — ${msg.caption}` : base;
}

export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  draf: "Draf",
  terjadwal: "Terjadwal",
  terkirim: "Terkirim",
  gagal: "Gagal",
  dibatalkan: "Dibatalkan",
};

export const DRAFT_TONE_LABEL: Record<string, string> = {
  formal: "Formal",
  santai: "Santai",
  tegas: "Tegas",
};
