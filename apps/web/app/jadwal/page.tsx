export const dynamic = "force-dynamic";

import JadwalClient from "@/lib/jadwal-client";

export default async function JadwalPage({
  searchParams,
}: {
  searchParams: Promise<{ chatJid?: string | string[] }>;
}) {
  const sp = await searchParams;
  const initialChatJid = typeof sp.chatJid === "string" ? sp.chatJid : undefined;
  return <JadwalClient initialChatJid={initialChatJid} />;
}
