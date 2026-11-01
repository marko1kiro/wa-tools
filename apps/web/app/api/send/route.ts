export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  chatJid: z.string().min(1),
  body: z.string().min(1),
});

// Proxy ke engine. Fail-closed: engine tidak jalan / tidak merespons
// sukses -> HTTP 503, dan UI TIDAK BOLEH mengklaim pesan terkirim.
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "chatJid dan body wajib diisi" }, { status: 400 });
  }
  const engineUrl = process.env.WA_ENGINE_URL?.replace(/\/$/, "");
  if (!engineUrl) {
    return NextResponse.json(
      { error: "Engine WhatsApp belum dikonfigurasi / tidak jalan" },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(`${engineUrl}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Engine menolak pengiriman (HTTP ${res.status})` },
        { status: 502 },
      );
    }
    const data: unknown = await res.json().catch(() => null);
    if (data && typeof data === "object") return NextResponse.json(data as Record<string, unknown>);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Engine WhatsApp tidak dapat dihubungi" },
      { status: 503 },
    );
  }
}
