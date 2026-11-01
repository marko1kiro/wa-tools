export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const { db, chats: chatsTable } = await getDb();
    const rows = await db.select().from(chatsTable);
    rows.sort(
      (a, b) => b.pinned - a.pinned || b.unreadCount - a.unreadCount || a.title.localeCompare(b.title),
    );
    return NextResponse.json({ chats: rows });
  } catch {
    // DB kosong / tabel belum ada -> daftar kosong, bukan 500.
    return NextResponse.json({ chats: [] });
  }
}
