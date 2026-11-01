"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { displayMessageText, DRAFT_TONE_LABEL, formatTime } from "@/lib/format";

export type ChatMessageView = {
  id: string;
  chatJid: string;
  senderJid: string;
  direction: string;
  type: string;
  text: string | null;
  caption: string | null;
  timestamp: number;
  status: string;
};

type DraftView = { id?: string; tone: string; body: string };

// Normalisasi balasan /api/drafts (kontrak dibuat worker lain): terima
// array langsung, { drafts: [...] }, atau satu objek { body, tone }.
function normalizeDrafts(data: unknown): DraftView[] {
  const toDraft = (d: unknown): DraftView | null => {
    if (!d || typeof d !== "object") return null;
    const r = d as Record<string, unknown>;
    if (typeof r.body !== "string" && typeof r.isi !== "string") return null;
    return {
      id: typeof r.id === "string" ? r.id : undefined,
      tone: typeof r.tone === "string" ? r.tone : typeof r.nada === "string" ? r.nada : "santai",
      body: (r.body as string) ?? (r.isi as string),
    };
  };
  if (Array.isArray(data)) return data.map(toDraft).filter((d): d is DraftView => d !== null);
  if (data && typeof data === "object") {
    const r = data as Record<string, unknown>;
    if (Array.isArray(r.drafts)) {
      return r.drafts.map(toDraft).filter((d): d is DraftView => d !== null);
    }
    const single = toDraft(data);
    if (single) return [single];
  }
  return [];
}

export default function ConversationPane({
  chatJid,
  chatTitle,
  initialMessages,
}: {
  chatJid: string;
  chatTitle: string;
  initialMessages: ChatMessageView[];
}) {
  const router = useRouter();
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const [generating, setGenerating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const showSlashMenu = composer.startsWith("/") && !composer.includes(" ");

  async function generateDrafts() {
    setGenerating(true);
    setDraftError(null);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatJid }),
      });
      if (!res.ok) {
        setDraftError(
          res.status === 404
            ? "API draf belum tersedia (dibuat worker lain)."
            : `Gagal membuat draf (HTTP ${res.status}).`,
        );
        return;
      }
      const data: unknown = await res.json();
      const list = normalizeDrafts(data);
      if (list.length === 0) {
        setDraftError("API draf tidak mengembalikan draf yang bisa ditampilkan.");
        return;
      }
      setDrafts(list);
    } catch {
      setDraftError("Gagal menghubungi API draf.");
    } finally {
      setGenerating(false);
    }
  }

  // Kirim HANYA saat tombol diklik eksplisit. Enter di composer TIDAK
  // mengirim. AI tidak pernah mengirim langsung (SPEC §2.4).
  async function send() {
    const body = composer.trim();
    if (!body || sending) return;
    setSending(true);
    setSendNotice(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatJid, body }),
      });
      if (!res.ok) {
        setSendNotice(
          res.status === 503
            ? "Engine WhatsApp tidak jalan — pesan TIDAK terkirim (fail-closed)."
            : `Gagal mengirim (HTTP ${res.status}). Pesan tidak terkirim.`,
        );
        return;
      }
      setComposer("");
      setSendNotice("Terkirim.");
      router.refresh();
    } catch {
      setSendNotice("Gagal menghubungi server — pesan TIDAK terkirim.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="truncate font-semibold">{chatTitle}</h2>
        <button
          type="button"
          onClick={() => {
            setAiOpen((v) => !v);
            if (!aiOpen && drafts.length === 0) void generateDrafts();
          }}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white"
        >
          ✨ AI
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 p-4">
        {initialMessages.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">
            Belum ada pesan di chat ini.
          </p>
        ) : (
          <ul className="space-y-2">
            {initialMessages.map((m) => (
              <li
                key={m.id}
                className={`flex ${m.direction === "keluar" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm ${
                    m.direction === "keluar" ? "bg-emerald-100" : "bg-white"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">
                    {displayMessageText(m)}
                  </p>
                  <p className="mt-1 text-right text-[11px] text-zinc-500">
                    {formatTime(m.timestamp)} · {m.status}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Panel AI: overlay bawah di HP, panel samping di desktop */}
      {aiOpen && (
        <div className="border-t bg-violet-50 p-4 max-md:fixed max-md:inset-x-0 max-md:bottom-14 max-md:z-40 max-md:max-h-[55svh] max-md:overflow-y-auto">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Draf balasan AI</h3>
            <button
              type="button"
              onClick={() => setAiOpen(false)}
              className="text-sm text-zinc-500"
            >
              Tutup
            </button>
          </div>
          {generating && <p className="text-sm text-zinc-500">Membuat draf…</p>}
          {draftError && <p className="text-sm text-red-700">{draftError}</p>}
          {!generating && !draftError && drafts.length === 0 && (
            <button
              type="button"
              onClick={() => void generateDrafts()}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white"
            >
              Buat 3 draf
            </button>
          )}
          <ul className="space-y-2">
            {drafts.map((d, i) => (
              <li key={d.id ?? `${d.tone}-${i}`} className="rounded-lg bg-white p-3 shadow-sm">
                <p className="text-xs font-semibold text-violet-700">
                  {DRAFT_TONE_LABEL[d.tone] ?? d.tone}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{d.body}</p>
                <button
                  type="button"
                  onClick={() => setComposer(d.body)}
                  className="mt-2 rounded-lg bg-zinc-900 px-3 py-1 text-xs text-white"
                >
                  Pakai draf ini
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-500">
            “Pakai draf ini” hanya mengisi composer — tidak pernah mengirim otomatis.
          </p>
        </div>
      )}

      <div className="border-t p-3">
        {showSlashMenu && (
          <div className="mb-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setComposer("");
                setAiOpen(true);
                void generateDrafts();
              }}
              className="rounded-lg bg-zinc-900 px-3 py-1 text-sm text-white"
            >
              /draf — buat draf balasan AI
            </button>
            <button
              type="button"
              onClick={() => router.push(`/jadwal?chatJid=${encodeURIComponent(chatJid)}`)}
              className="rounded-lg bg-zinc-200 px-3 py-1 text-sm"
            >
              /jadwal — buat pesan terjadwal
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            rows={2}
            placeholder="Tulis pesan… (ketik / untuk perintah)"
            className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || composer.trim() === ""}
            className="self-end rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {sending ? "Mengirim…" : "Kirim"}
          </button>
        </div>
        {sendNotice && <p className="mt-2 text-sm text-zinc-600">{sendNotice}</p>}
      </div>
    </div>
  );
}
