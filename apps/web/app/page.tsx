export const dynamic = "force-dynamic";

import Link from "next/link";
import type { chats, drafts, messages, schedules } from "@wa-tools/db";
import { getDb } from "@/lib/db";
import { formatTime } from "@/lib/format";

function todayBounds(): { start: number; end: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-6 text-center text-sm text-zinc-500">
      {text}
    </p>
  );
}

export default async function Home() {
  const { start, end } = todayBounds();
  // Gagal baca DB (mis. tabel belum dibuat worker lain) = empty state,
  // bukan halaman error. DB lokal kecil, jadi saring di JS saja.
  let loadFailed = false;
  let todaySchedules: typeof schedules.$inferSelect[] = [];
  let unreadChats: typeof chats.$inferSelect[] = [];
  let pendingDrafts: typeof drafts.$inferSelect[] = [];
  let sentToday = 0;
  try {
    const {
      db,
      schedules: schedulesTable,
      chats: chatsTable,
      drafts: draftsTable,
      messages: messagesTable,
    } = await getDb();
    const [allSched, allChats, allDrafts, allMsg] = await Promise.all([
      db.select().from(schedulesTable),
      db.select().from(chatsTable),
      db.select().from(draftsTable),
      db.select().from(messagesTable),
    ]);
    todaySchedules = allSched
      .filter((s) => s.sendAt >= start && s.sendAt < end)
      .sort((a, b) => a.sendAt - b.sendAt);
    unreadChats = allChats
      .filter((c) => c.unreadCount > 0)
      .sort((a, b) => b.unreadCount - a.unreadCount || a.title.localeCompare(b.title));
    pendingDrafts = allDrafts.filter((d) => d.status === "menunggu review");
    sentToday = allMsg.filter(
      (m) => m.direction === "keluar" && m.timestamp >= start && m.timestamp < end,
    ).length;
  } catch {
    loadFailed = true;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Hari ini</h1>
      {loadFailed && (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Data belum tersedia — database masih kosong atau skema belum dibuat.
        </p>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Jadwal hari ini", value: todaySchedules.length, href: "/jadwal" },
          { label: "Chat belum dibalas", value: unreadChats.length, href: "/chat" },
          { label: "Draf menunggu review", value: pendingDrafts.length, href: "/ai" },
          { label: "Terkirim hari ini", value: sentToday, href: "/jadwal" },
        ].map((stat) => (
          <Link key={stat.label} href={stat.href} className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-3xl font-bold">{stat.value}</p>
            <p className="mt-1 text-sm text-zinc-500">{stat.label}</p>
          </Link>
        ))}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Jadwal hari ini</h2>
        {todaySchedules.length === 0 ? (
          <Empty text="Belum ada jadwal hari ini." />
        ) : (
          <ul className="space-y-2">
            {todaySchedules.map((s) => (
              <li key={s.id} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                <p className="text-sm font-medium">{s.body}</p>
                <p className="text-xs text-zinc-500">
                  {formatTime(s.sendAt)} · {s.status}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Chat belum dibalas</h2>
        {unreadChats.length === 0 ? (
          <Empty text="Tidak ada chat yang belum dibalas." />
        ) : (
          <ul className="space-y-2">
            {unreadChats.map((c) => (
              <li key={c.jid} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                <Link href={`/chat?jid=${encodeURIComponent(c.jid)}`} className="font-medium">
                  {c.title}
                </Link>
                <p className="text-xs text-zinc-500">{c.unreadCount} pesan belum dibaca</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Antrean review AI</h2>
        {pendingDrafts.length === 0 ? (
          <Empty text="Tidak ada draf yang menunggu review." />
        ) : (
          <ul className="space-y-2">
            {pendingDrafts.map((d) => (
              <li key={d.id} className="rounded-lg bg-white px-4 py-3 shadow-sm">
                <p className="text-sm">{d.body}</p>
                <p className="text-xs text-zinc-500">
                  Nada: {d.tone} · {d.status}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
