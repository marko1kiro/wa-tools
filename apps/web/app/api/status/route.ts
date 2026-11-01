export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

// Status engine dengan timeout singkat. Engine gagal dihubungi ->
// engineUp:false dan queuePaused:true (fail-closed, SPEC §2.5: WA putus
// -> jadwal auto-pause, bukan kirim setengah-setengah).
// /health ikut diambil (SPEC §13.2) supaya dashboard menampilkan
// uptime + disconnect terakhir; gagal ambil /health tidak menggagalkan
// status (field-nya jadi null).
export async function GET() {
  const engineUrl = process.env.WA_ENGINE_URL?.replace(/\/$/, "");
  if (!engineUrl) {
    return NextResponse.json({
      engineUp: false,
      waState: null,
      phone: null,
      queuePaused: true,
      uptimeSeconds: null,
      lastDisconnectAt: null,
    });
  }
  const fetchJson = async (p: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch(`${engineUrl}${p}`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  };
  try {
    const data = await fetchJson("/status");
    if (!data) throw new Error("status fetch failed");
    const waState =
      typeof data.waState === "string"
        ? data.waState
        : typeof data.state === "string"
          ? data.state
          : null;
    const phone = typeof data.phone === "string" ? data.phone : null;
    const queuePaused =
      typeof data.queuePaused === "boolean" ? data.queuePaused : false;
    const health = await fetchJson("/health");
    const uptimeSeconds =
      typeof health?.uptimeSeconds === "number" ? health.uptimeSeconds : null;
    const lastDisconnectAt =
      typeof health?.lastDisconnectAt === "string" ? health.lastDisconnectAt : null;
    return NextResponse.json({
      engineUp: true,
      waState,
      phone,
      queuePaused,
      uptimeSeconds,
      lastDisconnectAt,
    });
  } catch {
    return NextResponse.json({
      engineUp: false,
      waState: null,
      phone: null,
      queuePaused: true,
      uptimeSeconds: null,
      lastDisconnectAt: null,
    });
  }
}
