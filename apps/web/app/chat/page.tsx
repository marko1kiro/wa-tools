export const dynamic = "force-dynamic";

import Link from "next/link";
import type { chats } from "@wa-tools/db";
import { getDb } from "@/lib/db";
import ConversationPane, { type ChatMessageView } from "@/lib/conversation-pane";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ jid?: string | string[] }>;
}) {
  const sp = await searchParams;
  const selectedJid = typeof sp.jid === "string" ? sp.jid : undefined;

  let loadFailed = false;
  let chatList: typeof chats.$inferSelect[] = [];
  let selected: typeof chats.$inferSelect | undefined;
  let msgList: ChatMessageView[] = [];
  try {
    const { db, chats: chatsTable, messages: messagesTable } = await getDb();
    const allChats = await db.select().from(chatsTable);
    chatList = allChats.sort(
      (a, b) => b.pinned - a.pinned || b.unreadCount - a.unreadCount || a.title.localeCompare(b.title),
    );
    if (selectedJid) {
      selected = allChats.find((c) => c.jid === selectedJid);
      if (selected) {
        const rows = await db.select().from(messagesTable);
        msgList = rows
          .filter((m) => m.chatJid === selectedJid)
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-200)
          .map((m) => ({
            id: m.id,
            chatJid: m.chatJid,
            senderJid: m.senderJid,
            direction: m.direction,
            type: m.type,
            text: m.text,
            caption: m.caption,
            timestamp: m.timestamp,
            status: m.status,
          }));
      }
    }
  } catch {
    loadFailed = true;
  }

  return (
    <div className="flex h-[calc(100dvh-56px-2rem)] min-h-[400px] overflow-hidden rounded-xl bg-white shadow-sm md:h-[calc(100dvh-2rem)]">
      {/* Daftar chat */}
      <aside
        className={`w-full shrink-0 flex-col border-r md:flex md:w-80 ${
          selectedJid ? "hidden md:flex" : "flex"
        }`}
      >
        <h1 className="border-b px-4 py-3 font-bold">Chat</h1>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadFailed && (
            <p className="px-4 py-6 text-sm text-amber-800">
              Data belum tersedia — database masih kosong atau skema belum dibuat.
            </p>
          )}
          {!loadFailed && chatList.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">
              Belum ada chat. Chat muncul setelah engine sinkronisasi.
            </p>
          )}
          <ul>
            {chatList.map((c) => (
              <li key={c.jid} className={c.jid === selectedJid ? "bg-emerald-50" : ""}>
                <Link
                  href={`/chat?jid=${encodeURIComponent(c.jid)}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50"
                >
                  <span className="truncate font-medium">{c.title}</span>
                  {c.unreadCount > 0 && (
                    <span className="ml-2 shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-xs text-white">
                      {c.unreadCount}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Percakapan */}
      <div className={`min-w-0 flex-1 flex-col ${selectedJid ? "flex" : "hidden md:flex"}`}>
        {!selectedJid && (
          <p className="m-auto px-4 text-center text-sm text-zinc-500">
            Pilih chat di daftar untuk mulai membaca / membalas.
          </p>
        )}
        {selectedJid && !selected && !loadFailed && (
          <p className="m-auto px-4 text-center text-sm text-zinc-500">
            Chat tidak ditemukan.{" "}
            <Link href="/chat" className="underline">
              Kembali ke daftar
            </Link>
          </p>
        )}
        {selected && (
          <ConversationPane
            chatJid={selected.jid}
            chatTitle={selected.title}
            initialMessages={msgList}
          />
        )}
      </div>
    </div>
  );
}
