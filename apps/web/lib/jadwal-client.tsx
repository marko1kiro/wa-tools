"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDateTime, SCHEDULE_STATUS_LABEL } from "@/lib/format";

type ScheduleView = {
  id: string;
  chatJid: string;
  body: string;
  sendAt: number;
  status: string;
  attempts?: number;
  lastError?: string | null;
};

type ChatView = { jid: string; title: string };

const FILTERS = ["semua", "draf", "terjadwal", "terkirim", "gagal"] as const;

// Normalisasi balasan /api/schedules (kontrak dibuat worker lain).
function normalizeSchedules(data: unknown): ScheduleView[] {
  const toItem = (r: Record<string, unknown>): ScheduleView | null => {
    if (typeof r.id !== "string" || typeof r.chatJid !== "string") return null;
    const body = typeof r.body === "string" ? r.body : typeof r.isi === "string" ? r.isi : "";
    const sendAt =
      typeof r.sendAt === "number"
        ? r.sendAt
        : typeof r.waktu_kirim === "number"
          ? r.waktu_kirim
          : 0;
    return {
      id: r.id,
      chatJid: r.chatJid,
      body,
      sendAt,
      status: typeof r.status === "string" ? r.status : "draf",
      attempts: typeof r.attempts === "number" ? r.attempts : undefined,
      lastError: typeof r.lastError === "string" ? r.lastError : null,
    };
  };
  if (Array.isArray(data)) {
    return data
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .map(toItem)
      .filter((d): d is ScheduleView => d !== null);
  }
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).schedules)) {
    return normalizeSchedules((data as Record<string, unknown>).schedules);
  }
  return [];
}

function toDatetimeLocal(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function JadwalClient({ initialChatJid }: { initialChatJid?: string }) {
  const [items, setItems] = useState<ScheduleView[]>([]);
  const [chats, setChats] = useState<ChatView[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("semua");
  const [apiMissing, setApiMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formChat, setFormChat] = useState(initialChatJid ?? "");
  const [formBody, setFormBody] = useState("");
  const [formWhen, setFormWhen] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (res.status === 404) {
        setApiMissing(true);
        return;
      }
      if (!res.ok) {
        setNotice(`Gagal memuat jadwal (HTTP ${res.status}).`);
        return;
      }
      setApiMissing(false);
      setItems(normalizeSchedules(await res.json()));
    } catch {
      setNotice("Gagal menghubungi API jadwal.");
    }
  }, []);

  useEffect(() => {
    void load();
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).chats)) {
          setChats(
            ((data as Record<string, unknown>).chats as Record<string, unknown>[])
              .filter((c) => typeof c.jid === "string")
              .map((c) => ({ jid: c.jid as string, title: String(c.title ?? c.jid) })),
          );
        }
      })
      .catch(() => undefined);
  }, [load]);

  // Kontrak worker lain: PATCH /api/schedules/[id] dengan { body?, sendAt?,
  // status? } — status sah: draf/terjadwal/dibatalkan. Pause per-jadwal =
  // status draf (pause GLOBAL antrean adalah settings key queue_paused,
  // diatur dari Pengaturan, bukan dari sini).
  async function patchSchedule(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.status === 404) {
      setApiMissing(true);
      setNotice("API jadwal belum tersedia (dibuat worker lain).");
      return;
    }
    if (!res.ok) {
      setNotice(`Aksi gagal (HTTP ${res.status}).`);
      return;
    }
    setNotice("Tersimpan.");
    void load();
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const sendAt = new Date(formWhen).getTime();
    if (!formChat.trim() || !formBody.trim() || Number.isNaN(sendAt)) {
      setNotice("Lengkapi chat, isi pesan, dan waktu kirim.");
      return;
    }
    // Kontrak worker lain: jadwal aktif (status terjadwal) wajib sendAt
    // masa depan; tolak lebih awal daripada 400 dari API.
    if (!editingId && sendAt <= Date.now()) {
      setNotice("Waktu kirim harus di masa depan untuk jadwal aktif.");
      return;
    }
    if (editingId) {
      await patchSchedule(editingId, { body: formBody.trim(), sendAt });
      setEditingId(null);
    } else {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatJid: formChat.trim(), body: formBody.trim(), sendAt }),
      });
      if (res.status === 404) {
        setApiMissing(true);
        setNotice("API jadwal belum tersedia (dibuat worker lain).");
        return;
      }
      if (!res.ok) {
        setNotice(`Gagal membuat jadwal (HTTP ${res.status}).`);
        return;
      }
      setNotice("Jadwal dibuat.");
    }
    setFormBody("");
    setFormWhen("");
    void load();
  }

  const visible = filter === "semua" ? items : items.filter((i) => i.status === filter);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Jadwal</h1>
      {apiMissing && (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          API /api/schedules belum tersedia (dibuat worker lain) — daftar dan aksi
          akan aktif begitu API itu jadi.
        </p>
      )}
      {notice && <p className="rounded-lg bg-zinc-100 px-4 py-3 text-sm">{notice}</p>}

      <form onSubmit={(e) => void submitForm(e)} className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
        <h2 className="font-semibold">{editingId ? "Edit jadwal" : "Buat jadwal"}</h2>
        {chats.length > 0 ? (
          <select
            value={formChat}
            onChange={(e) => setFormChat(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">Pilih chat…</option>
            {chats.map((c) => (
              <option key={c.jid} value={c.jid}>
                {c.title}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={formChat}
            onChange={(e) => setFormChat(e.target.value)}
            placeholder="JID chat tujuan"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        )}
        <textarea
          value={formBody}
          onChange={(e) => setFormBody(e.target.value)}
          rows={3}
          placeholder="Isi pesan…"
          className="w-full rounded-lg border px-3 py-2 text-sm"
        />
        <input
          type="datetime-local"
          value={formWhen}
          onChange={(e) => setFormWhen(e.target.value)}
          className="w-full rounded-lg border px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white">
            {editingId ? "Simpan perubahan" : "Buat jadwal"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setFormBody("");
                setFormWhen("");
              }}
              className="rounded-lg bg-zinc-200 px-4 py-2 text-sm"
            >
              Batal edit
            </button>
          )}
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-sm ${
              filter === f ? "bg-zinc-900 text-white" : "bg-white"
            }`}
          >
            {f === "semua" ? "Semua" : (SCHEDULE_STATUS_LABEL[f] ?? f)}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-6 text-center text-sm text-zinc-500">
          Belum ada jadwal untuk filter ini.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((s) => (
            <li key={s.id} className="rounded-lg bg-white px-4 py-3 shadow-sm">
              <p className="whitespace-pre-wrap text-sm">{s.body}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {formatDateTime(s.sendAt)} · {SCHEDULE_STATUS_LABEL[s.status] ?? s.status}
                {s.lastError ? ` · error: ${s.lastError}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(s.id);
                    setFormChat(s.chatJid);
                    setFormBody(s.body);
                    setFormWhen(toDatetimeLocal(s.sendAt));
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  className="rounded-lg bg-zinc-200 px-3 py-1 text-xs"
                >
                  Edit
                </button>
                {s.status === "terjadwal" && (
                  <button
                    type="button"
                    onClick={() => void patchSchedule(s.id, { status: "draf" })}
                    className="rounded-lg bg-amber-100 px-3 py-1 text-xs"
                  >
                    Pause
                  </button>
                )}
                {s.status === "draf" && (
                  <button
                    type="button"
                    onClick={() => void patchSchedule(s.id, { status: "terjadwal" })}
                    className="rounded-lg bg-emerald-100 px-3 py-1 text-xs"
                  >
                    Aktifkan lagi
                  </button>
                )}
                {(s.status === "draf" || s.status === "terjadwal") && (
                  <button
                    type="button"
                    onClick={() => void patchSchedule(s.id, { status: "dibatalkan" })}
                    className="rounded-lg bg-red-100 px-3 py-1 text-xs"
                  >
                    Batalkan
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
