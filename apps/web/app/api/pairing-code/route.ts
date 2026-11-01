export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

// Proxy ke engine POST /pairing-code (SPEC §3.1). Fail-closed:
// engine tidak terkonfigurasi / tidak bisa dihubungi -> 503, bukan
// kode palsu. Error engine diteruskan apa adanya (status + error).
const bodySchema = z.object({
  phone: z.string().min(1, "phone wajib diisi"),
});

export async function POST(req: Request) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const result = bodySchema.safeParse(parsed);
  if (!result.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const engineUrl = process.env.WA_ENGINE_URL?.replace(/\/$/, "");
  if (!engineUrl) {
    return NextResponse.json({ error: "engine_unconfigured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${engineUrl}/pairing-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: result.data.phone }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return NextResponse.json(
        { error: typeof data?.error === "string" ? data.error : "pairing_failed" },
        { status: res.status },
      );
    }
    return NextResponse.json({
      code: data?.code ?? null,
      phone: data?.phone ?? null,
      state: data?.state ?? null,
    });
  } catch {
    return NextResponse.json({ error: "engine_unreachable" }, { status: 503 });
  }
}
