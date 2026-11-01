{/* PLACEHOLDER SCAFFOLD — bukan halaman fungsional.
    Rute nyata mengikuti SPEC §10 dan mockup UI v1 yang sudah di-approve
    (preview-desain-ui-whatsapp-tools). Implementasi adalah langkah
    berikutnya, bukan bagian dari scaffold ini. */}
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">WhatsApp Tools (local)</h1>
      <p className="mt-2 text-gray-600">
        Scaffold proyek — belum ada fitur. Koneksi WhatsApp, inbox, jadwal,
        draf AI, dan pengaturan diimplementasikan pada langkah berikutnya
        sesuai SPEC.md.
      </p>
      <h2 className="mt-6 font-semibold">Rute yang direncanakan (SPEC §10)</h2>
      <ul className="mt-2 list-inside list-disc text-gray-700">
        <li>/ — Home / Hari ini (data asli)</li>
        <li>/chat — Inbox / Chat (replica WA Web + Omnibox /)</li>
        <li>/jadwal — Pesan terjadwal</li>
        <li>/ai — AI Tools (Fase 1: hanya draf balasan)</li>
        <li>/media — Studio Media (Fase 2, tampil &quot;segera hadir&quot;)</li>
        <li>/pengaturan — Pengaturan</li>
      </ul>
    </main>
  );
}
