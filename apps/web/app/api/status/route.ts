export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

// Status engine dengan timeout singkat. Engine gagal dihubungi ->
// engineUp:false dan queuePaused:true (fail-closed, SPEC §2.5: WA putus
// -> jadwal auto-pause, bukan kirim setengah-setengah).
export async function GET() {
  const engineUrl = process.env.WA_ENGINE_URL?.replace(/\/$/, "");
  if (!engineUrl) {
    return NextResponse.json({
      engineUp: false,
      waState: null,
      phone: null,
      queuePaused: true,
    });
  }
  try {
    const res = await fetch(`${engineUrl}/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const waState =
      typeof data?.waState === "string"
        ? data.waState
        : typeof data?.state === "string"
          ? data.state
          : null;
    const phone = typeof data?.phone === "string" ? data.phone : null;
    const queuePaused =
      typeof data?.queuePaused === "boolean" ? data.queuePaused : false;
    return NextResponse.json({ engineUp: true, waState, phone, queuePaused });
  } catch {
    return NextResponse.json({
      engineUp: false,
      waState: null,
      phone: null,
      queuePaused: true,
    });
  }
}
