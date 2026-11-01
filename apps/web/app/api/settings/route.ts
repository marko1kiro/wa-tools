export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function GET() {
  try {
    const { db, settings: settingsTable } = await getDb();
    const rows = await db.select().from(settingsTable);
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = parseValue(row.value);
    return NextResponse.json({ settings: out });
  } catch {
    return NextResponse.json({ settings: {} });
  }
}

export async function PUT(req: Request) {
  const data: unknown = await req.json().catch(() => null);
  if (!data || typeof data !== "object") {
    return NextResponse.json({ error: "body JSON tidak valid" }, { status: 400 });
  }
  const record = data as Record<string, unknown>;
  const entries: [string, unknown][] = [];
  if (typeof record.key === "string" && "value" in record) {
    entries.push([record.key, record.value]);
  } else if (record.settings && typeof record.settings === "object") {
    for (const [k, v] of Object.entries(record.settings as Record<string, unknown>)) {
      entries.push([k, v]);
    }
  }
  if (entries.length === 0) {
    return NextResponse.json(
      { error: "kirim { key, value } atau { settings: { ... } }" },
      { status: 400 },
    );
  }
  try {
    const { db, settings: settingsTable } = await getDb();
    for (const [key, value] of entries) {
      const stored = typeof value === "string" ? value : JSON.stringify(value);
      await db
        .insert(settingsTable)
        .values({ key, value: stored })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: stored },
        });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "gagal menyimpan pengaturan" }, { status: 500 });
  }
}
