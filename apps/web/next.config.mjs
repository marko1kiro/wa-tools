/** @type {import('next').NextConfig} */
const nextConfig = {
  // @libsql/client membawa binding native yang tidak bisa dibundel
  // webpack; biarkan sebagai require runtime Node (semua pemakai adalah
  // server component / route handler, dan semua halaman data
  // force-dynamic sehingga tidak dieksekusi saat build).
  serverExternalPackages: ["@libsql/client", "@wa-tools/db"],
};

export default nextConfig;
