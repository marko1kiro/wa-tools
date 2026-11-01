// Akses @wa-tools/db HANYA lewat import dinamis runtime-only di sini.
//
// Alasan: @wa-tools/db membuat klien @libsql/client di modul root-nya,
// dan rantai itu menarik binding native `libsql` yang TIDAK bisa
// dibundel webpack (gagal parse README.md saat `next build`).
// Import statis dari "@wa-tools/db" di page/route mana pun akan
// mengulang kegagalan build itu. Dengan `webpackIgnore: true`, import
// ini tetap menjadi require/import Node asli saat runtime — aman karena
// semua pemakai adalah server component / route handler (runtime Node),
// dan semua halaman data force-dynamic sehingga import ini tidak pernah
// dieksekusi saat build.
//
// ensureSchema() sedang dibuat worker lain di @wa-tools/db: pengecekan
// di sini membuat kode tetap lolos typecheck SEBELUM fungsi itu ada,
// dan otomatis memakainya begitu tersedia (dan dist @wa-tools/db
// di-rebuild). JANGAN duplikasi CREATE TABLE di sini — satu-satunya
// sumber skema adalah @wa-tools/db.
type DbModule = typeof import("@wa-tools/db") & {
  ensureSchema?: () => Promise<unknown>;
};

export async function getDb(): Promise<DbModule> {
  const mod = (await import(
    /* webpackIgnore: true */ "@wa-tools/db"
  )) as unknown as DbModule;
  if (typeof mod.ensureSchema === "function") {
    await mod.ensureSchema();
  }
  return mod;
}

// Alias lama: kembalikan klien drizzle setelah memastikan skema.
export async function ensureDb() {
  const mod = await getDb();
  return mod.db;
}
