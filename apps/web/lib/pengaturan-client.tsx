"use client";

import { useEffect, useState } from "react";

type StatusView = {
  engineUp: boolean;
  waState: string | null;
  phone: string | null;
  queuePaused: boolean;
  uptimeSeconds: number | null;
  lastDisconnectAt: string | null;
};

/** Format detik uptime -> "45d", "3j 12m", "2h 5j", "1h". */
function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}d`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}h ${h % 24}j`;
}

function formatDisconnectAt(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("id-ID");
}

const DEFAULTS: Record<string, string> = {
  gateway_base_url: "http://localhost:20128/v1",
  draft_model: "",
  jeda_min_ms: "5000",
  jeda_max_ms: "15000",
  batas_harian: "50",
  jam_tenang: "22:00-07:00",
};

export default function PengaturanClient() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [qrBroken, setQrBroken] = useState(false);
  // Cache-buster load QR: URL gambar QR harus segar tiap mount supaya
  // browser tidak menyajikan cache gambar rusak lama (kasus QR JSON).
  const [qrNonce] = useState(() => Date.now());
  // Kode pairing fallback (SPEC §3.1): BUKAN SMS OTP — kode ini
  // dimasukkan user di HP (Perangkat Tertaut -> Tautkan dengan nomor
  // telepon). Berlaku singkat; minta baru bila kedaluwarsa.
  const [pairingPhone, setPairingPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingDetail, setPairingDetail] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({ ...DEFAULTS });
  const [notice, setNotice] = useState<string | null>(null);
  // Pause GLOBAL antrean kirim (kontrak worker lain: settings key
  // queue_paused dibaca antrean engine — bukan status per-jadwal).
  const [queuePaused, setQueuePaused] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          setStatus({
            engineUp: d.engineUp === true,
            waState: typeof d.waState === "string" ? d.waState : null,
            phone: typeof d.phone === "string" ? d.phone : null,
            queuePaused: d.queuePaused === true,
            uptimeSeconds:
              typeof d.uptimeSeconds === "number" ? d.uptimeSeconds : null,
            lastDisconnectAt:
              typeof d.lastDisconnectAt === "string" ? d.lastDisconnectAt : null,
          });
        } else {
          setStatusError(true);
        }
      })
      .catch(() => setStatusError(true));
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const s = (d.settings ?? d) as Record<string, unknown>;
          const next = { ...DEFAULTS };
          for (const key of Object.keys(DEFAULTS)) {
            const v = s[key];
            if (typeof v === "string") next[key] = v;
            else if (typeof v === "number") next[key] = String(v);
          }
          setValues(next);
          if (s.queue_paused === true) setQueuePaused(true);
        }
      })
      .catch(() => undefined);
  }, []);

  async function requestPairingCode(e: React.FormEvent) {
    e.preventDefault();
    setPairingError(null);
    setPairingDetail(null);
    setPairingBusy(true);
    try {
      const res = await fetch("/api/pairing-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: pairingPhone }),
      });
      const data = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!res.ok || typeof data?.code !== "string") {
        const err = typeof data?.error === "string" ? data.error : "";
        // Detail aman dari engine (mis. socket_not_ready / pesan Baileys)
        // ditampilkan apa adanya di bawah pesan gagal.
        if (typeof data?.detail === "string" && data.detail.length > 0) {
          setPairingDetail(data.detail);
        }
        setPairingError(
          err === "invalid_phone"
            ? "Nomor tidak valid — pakai digit dengan kode negara, tanpa + (mis. 62812xxxxxxx)."
            : err === "already_connected"
              ? "WhatsApp sudah terhubung — tidak perlu kode pairing."
              : err === "already_registered"
                ? "Akun ini sudah terdaftar — pakai sesi yang ada (atau scan QR)."
                : err === "engine_unreachable" || err === "engine_unconfigured"
                  ? "Engine tidak bisa dihubungi — pastikan wa-engine jalan."
                  : err === "socket_not_ready"
                    ? "Socket WhatsApp belum siap — coba lagi sebentar."
                    : "Gagal meminta kode pairing. Coba lagi.",
        );
        return;
      }
      setPairingCode(data.code);
      // Segarkan status supaya kartu menampilkan state "pairing".
      fetch("/api/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: unknown) => {
          if (d && typeof d === "object") {
            const s = d as Record<string, unknown>;
            setStatus((prev) =>
              prev
                ? {
                    ...prev,
                    waState:
                      typeof s.waState === "string"
                        ? s.waState
                        : typeof s.state === "string"
                          ? s.state
                          : prev.waState,
                  }
                : prev,
            );
          }
        })
        .catch(() => undefined);
    } catch {
      setPairingError("Gagal menghubungi server.");
    } finally {
      setPairingBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: values }),
      });
      if (!res.ok) {
        setNotice(`Gagal menyimpan (HTTP ${res.status}).`);
        return;
      }
      setNotice("Pengaturan tersimpan.");
    } catch {
      setNotice("Gagal menghubungi server.");
    }
  }

  const field = (key: string, label: string, placeholder?: string, type = "text") => (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        type={type}
        value={values[key] ?? ""}
        placeholder={placeholder}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Pengaturan</h1>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-2 font-semibold">Status WhatsApp</h2>
        {statusError && (
          <p className="text-sm text-red-700">
            Status tidak bisa dimuat — engine kemungkinan belum jalan.
          </p>
        )}
        {status && (
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-zinc-500">Engine:</dt>
              <dd>{status.engineUp ? "jalan" : "tidak jalan"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500">Status WA:</dt>
              <dd>{status.waState ?? "tidak diketahui"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500">Nomor:</dt>
              <dd>{status.phone ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500">Antrean kirim:</dt>
              <dd>{status.queuePaused ? "dijeda (fail-closed)" : "aktif"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500">Uptime engine:</dt>
              <dd>{formatUptime(status.uptimeSeconds)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500">Terakhir putus:</dt>
              <dd>{formatDisconnectAt(status.lastDisconnectAt)}</dd>
            </div>
          </dl>
        )}
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={queuePaused}
            onChange={(e) => {
              const next = e.target.checked;
              setQueuePaused(next);
              fetch("/api/settings", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ key: "queue_paused", value: next }),
              }).catch(() => undefined);
            }}
          />
          Jeda antrean kirim (pause global — jadwal tidak terkirim selama dijeda)
        </label>
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">QR pairing</h3>
          {qrBroken ? (
            <p className="text-sm text-zinc-500">
              QR tidak tersedia — engine belum jalan atau belum ada QR aktif.
            </p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/qr-proxy?t=${qrNonce}`}
              alt="QR pairing WhatsApp"
              onError={() => setQrBroken(true)}
              className="h-56 w-56 rounded-lg border object-contain"
            />
          )}
        </div>
        <div className="mt-4 border-t pt-4">
          <h3 className="mb-1 text-sm font-semibold">Gunakan kode pairing</h3>
          <p className="mb-2 text-xs text-zinc-500">
            Bila QR bermasalah. Ini BUKAN SMS OTP — kode dimasukkan di HP:
            WhatsApp → Perangkat Tertaut → Tautkan dengan nomor telepon.
          </p>
          <form onSubmit={(e) => void requestPairingCode(e)} className="flex flex-wrap items-center gap-2">
            <input
              type="tel"
              value={pairingPhone}
              onChange={(e) => setPairingPhone(e.target.value)}
              placeholder="62812xxxxxxx"
              className="w-48 rounded-lg border px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={pairingBusy || pairingPhone.trim().length === 0}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {pairingBusy ? "Meminta…" : pairingCode ? "Minta kode baru" : "Minta kode"}
            </button>
          </form>
          {pairingError && (
            <p className="mt-2 text-sm text-red-700">{pairingError}</p>
          )}
          {pairingDetail && (
            <p className="mt-1 text-xs text-zinc-500">{pairingDetail}</p>
          )}
          {pairingCode && (
            <div className="mt-3">
              <p className="font-mono text-4xl font-bold tracking-[0.2em]">
                {pairingCode}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Kode berlaku singkat — segera masukkan di HP. Bila
                kedaluwarsa, tekan “Minta kode baru”.
              </p>
            </div>
          )}
        </div>
      </section>

      <form onSubmit={(e) => void save(e)} className="space-y-4 rounded-xl bg-white p-4 shadow-sm">
        <h2 className="font-semibold">Gateway AI</h2>
        {field("gateway_base_url", "Base URL gateway", "http://localhost:20128/v1")}
        {field("draft_model", "Model draf balasan", "mis. model cepat/murah")}
        <p className="text-xs text-zinc-500">
          Key gateway tidak disimpan di form ini — kelola lewat environment
          server, bukan lewat file UI.
        </p>

        <h2 className="font-semibold">Batas kirim</h2>
        {field("jeda_min_ms", "Jeda antar pesan — minimum (ms)", undefined, "number")}
        {field("jeda_max_ms", "Jeda antar pesan — maksimum (ms)", undefined, "number")}
        {field("batas_harian", "Batas kirim harian", undefined, "number")}
        {field("jam_tenang", "Jam tenang", "22:00-07:00")}
        <p className="text-xs text-zinc-500">
          Default konservatif untuk nomor utama (SPEC §8). Menaikkan batas di
          atas default adalah risiko user sendiri.
        </p>

        <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white">
          Simpan pengaturan
        </button>
        {notice && <p className="text-sm text-zinc-600">{notice}</p>}
      </form>
    </div>
  );
}
