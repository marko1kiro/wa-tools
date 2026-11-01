"use client";

import { useEffect, useState } from "react";
import { DRAFT_TONE_LABEL } from "@/lib/format";

type ChatView = { jid: string; title: string };
type DraftView = { id?: string; chatJid?: string; tone: string; body: string; status?: string };

function normalizeDrafts(data: unknown): DraftView[] {
  const toDraft = (d: unknown): DraftView | null => {
    if (!d || typeof d !== "object") return null;
    const r = d as Record<string, unknown>;
    const body = typeof r.body === "string" ? r.body : typeof r.isi === "string" ? r.isi : null;
    if (!body) return null;
    return {
      id: typeof r.id === "string" ? r.id : undefined,
      chatJid: typeof r.chatJid === "string" ? r.chatJid : undefined,
      tone: typeof r.tone === "string" ? r.tone : typeof r.nada === "string" ? r.nada : "santai",
      body,
      status: typeof r.status === "string" ? r.status : undefined,
    };
  };
  if (Array.isArray(data)) {
    return data.map(toDraft).filter((d): d is DraftView => d !== null);
  }
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).drafts)) {
    return normalizeDrafts((data as Record<string, unknown>).drafts);
  }
  const single = data ? toDraft(data) : null;
  return single ? [single] : [];
}

export default function AiClient() {
  const [chats, setChats] = useState<ChatView[]>([]);
  const [chatJid, setChatJid] = useState("");
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const [savedDrafts, setSavedDrafts] = useState<DraftView[]>([]);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  // Kontrak worker lain: GET /api/drafts hanya filter ?status=, TIDAK
  // kenal ?chatJid=. Jadi ambil draf "menunggu review" lalu saring
  // per-chat di client — kalau tidak, draf chat lain ikut tampil.
  async function loadSaved(jid: string) {
    if (!jid) {
      setSavedDrafts([]);
      return;
    }
    try {
      const res = await fetch("/api/drafts?status=menunggu%20review");
      if (!res.ok) {
        setSavedDrafts([]);
        return;
      }
      setSavedDrafts(normalizeDrafts(await res.json()).filter((d) => d.chatJid === jid));
    } catch {
      setSavedDrafts([]);
    }
  }

  async function generate() {
    if (!chatJid) {
      setNotice("Pilih chat dulu.");
      return;
    }
    setGenerating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatJid }),
      });
      if (res.status === 404) {
        setNotice("API draf belum tersedia (dibuat worker lain).");
        return;
      }
      if (!res.ok) {
        setNotice(`Gagal membuat draf (HTTP ${res.status}).`);
        return;
      }
      const list = normalizeDrafts(await res.json());
      setDrafts(list);
      if (list.length === 0) setNotice("API draf tidak mengembalikan draf yang bisa ditampilkan.");
      void loadSaved(chatJid);
    } catch {
      setNotice("Gagal menghubungi API draf.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">AI Tools</h1>

      <section className="space-y-3 rounded-xl bg-white p-4 shadow-sm">
        <h2 className="font-semibold">Draf balasan</h2>
        <p className="text-sm text-zinc-500">
          Pilih chat, lalu buat 3 opsi nada (formal, santai, tegas). Draf hanya
          ditampilkan di sini — pengiriman tetap manual dari halaman Chat.
        </p>
        {chats.length > 0 ? (
          <select
            value={chatJid}
            onChange={(e) => {
              setChatJid(e.target.value);
              setDrafts([]);
              void loadSaved(e.target.value);
            }}
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
            value={chatJid}
            onChange={(e) => setChatJid(e.target.value)}
            placeholder="JID chat"
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        )}
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating || !chatJid}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {generating ? "Membuat…" : "Buat 3 draf"}
        </button>
        {notice && <p className="text-sm text-zinc-600">{notice}</p>}
        {drafts.length > 0 && (
          <ul className="space-y-2">
            {drafts.map((d, i) => (
              <li key={d.id ?? `${d.tone}-${i}`} className="rounded-lg bg-violet-50 p-3">
                <p className="text-xs font-semibold text-violet-700">
                  {DRAFT_TONE_LABEL[d.tone] ?? d.tone}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{d.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 font-semibold">Draf tersimpan</h2>
        {savedDrafts.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Belum ada draf tersimpan untuk chat ini (atau API daftar draf belum tersedia).
          </p>
        ) : (
          <ul className="space-y-2">
            {savedDrafts.map((d, i) => (
              <li key={d.id ?? `${d.tone}-${i}`} className="rounded-lg bg-zinc-50 p-3">
                <p className="text-xs font-semibold text-zinc-500">
                  {DRAFT_TONE_LABEL[d.tone] ?? d.tone}
                  {d.status ? ` · ${d.status}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{d.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Analisa chat</h2>
          <p className="mt-1 text-sm text-zinc-500">Segera hadir (Fase 2, SPEC §4).</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold">Laporan</h2>
          <p className="mt-1 text-sm text-zinc-500">Segera hadir (Fase 2, SPEC §4).</p>
        </div>
      </section>
    </div>
  );
}
