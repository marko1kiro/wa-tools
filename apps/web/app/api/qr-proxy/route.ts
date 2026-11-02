export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

// Proxy engine /qr apa adanya (body + content-type diteruskan).
// Engine tidak jalan -> 503 JSON, bukan gambar palsu.
export async function GET() {
  const engineUrl = process.env.WA_ENGINE_URL?.replace(/\/$/, "");
  if (!engineUrl) {
    return NextResponse.json({ error: "Engine WhatsApp belum jalan" }, { status: 503 });
  }
  try {
    const res = await fetch(`${engineUrl}/qr`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Engine tidak menyediakan QR (HTTP ${res.status})` },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    return new NextResponse(buf, {
      headers: { "content-type": contentType, "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Engine WhatsApp tidak dapat dihubungi" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
