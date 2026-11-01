import type { Metadata } from "next";
import "./globals.css";
import { BottomNav, Sidebar } from "@/lib/nav";

export const metadata: Metadata = {
  title: "WhatsApp Tools (local)",
  description: "Dashboard local untuk membantu kerja harian di WhatsApp.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body className="bg-zinc-100 text-zinc-900">
        <Sidebar />
        <div className="pb-14 md:pb-0 md:pl-[70px]">
          <main className="mx-auto max-w-6xl p-4">{children}</main>
        </div>
        <BottomNav />
      </body>
    </html>
  );
}
