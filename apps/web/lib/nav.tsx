"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Navigasi icon-only (SPEC §10 + mockup UI v1): tanpa teks keterangan,
// hanya ikon + aria-label. Sidebar 70px di desktop, bar bawah di HP.
const NAV = [
  { href: "/", icon: "🏠", label: "Home" },
  { href: "/chat", icon: "💬", label: "Chat" },
  { href: "/jadwal", icon: "🗓️", label: "Jadwal" },
  { href: "/ai", icon: "✨", label: "AI" },
  { href: "/media", icon: "🖼️", label: "Media" },
  { href: "/pengaturan", icon: "⚙️", label: "Pengaturan" },
];

function NavItems({ vertical }: { vertical: boolean }) {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            title={item.label}
            className={`flex items-center justify-center text-2xl ${
              vertical ? "h-14 w-full" : "h-14 flex-1"
            } ${active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
          >
            {item.icon}
          </Link>
        );
      })}
    </>
  );
}

export function Sidebar() {
  return (
    <nav
      aria-label="Navigasi utama"
      className="fixed inset-y-0 left-0 z-40 hidden w-[70px] flex-col bg-zinc-900 md:flex"
    >
      <div className="flex h-14 items-center justify-center text-2xl" title="WhatsApp Tools">
        🟢
      </div>
      <NavItems vertical />
    </nav>
  );
}

export function BottomNav() {
  return (
    <nav
      aria-label="Navigasi utama"
      className="fixed inset-x-0 bottom-0 z-40 flex bg-zinc-900 md:hidden"
    >
      <NavItems vertical={false} />
    </nav>
  );
}
