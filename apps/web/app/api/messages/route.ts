export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chatJid = url.searchParams.get("chatJid");
  if (!chatJid) {
    return NextResponse.json({ error: "chatJid wajib diisi" }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 100;
  try {
    const { db, messages: messagesTable } = await getDb();
    const rows = await db.select().from(messagesTable);
    const list = rows
      .filter((m) => m.chatJid === chatJid)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
    return NextResponse.json({ messages: list });
  } catch {
    return NextResponse.json({ messages: [] });
  }
}
