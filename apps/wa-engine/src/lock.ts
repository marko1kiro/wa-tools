import fs from "node:fs";
import path from "node:path";

// Single-instance lock untuk wa-engine (SPEC §13.4).
//
// Mekanisme: file lock berisi PID proses pemilik. Diakuisisi dengan
// open eksklusif ('wx') SEBELUM server/queue jalan, supaya dua proses
// tidak pernah rebutan satu sesi Baileys.
// - File sudah ada + PID masih hidup -> akuisisi DITOLAK (fail-closed).
// - File sudah ada + PID sudah mati -> dianggap stale, dihapus, lalu
//   akuisisi diulang sekali.
// - Isi file bukan angka / tidak bisa dibaca -> DITOLAK (fail-closed);
//   user menghapus manual file-nya bila yakin tidak ada proses jalan.
// - release() hanya menghapus bila isi file == PID sendiri, supaya
//   tidak pernah menghapus lock milik proses lain.
// - Crash tanpa cleanup tetap aman: proses berikutnya melihat PID mati
//   dan menganggap lock stale.
//
// Lokasi default: ./data/wa-engine.lock (relatif terhadap cwd, sama
// seperti default DATABASE_URL). Override: WA_ENGINE_LOCK_FILE.
// Di service NSSM, AppDirectory diarahkan ke root repo sehingga path
// relatif ini mengarah ke <root>/data/wa-engine.lock; script install
// juga menyetel path absolut lewat env agar tidak bergantung pada cwd.

export interface LockResult {
  acquired: boolean;
  /** PID pemilik lock saat ini (bila ditolak). */
  holderPid?: number;
  /** Alasan penolakan (bila ditolak). */
  reason?: string;
}

function readHolderPid(lockPath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf-8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    // Sinyal 0 = cek eksistensi saja, tanpa mengirim sinyal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = tidak ada proses itu. EPERM = ada, tapi tak boleh
    // disinyal (milik user lain) -> tetap dianggap hidup.
    return code === "EPERM";
  }
}

export function acquireLock(lockPath: string): LockResult {
  const dir = path.dirname(lockPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      acquired: false,
      reason: `tidak bisa membuat folder lock ${dir}: ${
        err instanceof Error ? err.message : err
      }`,
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return {
          acquired: false,
          reason: `tidak bisa membuat lock ${lockPath}: ${
            err instanceof Error ? err.message : err
          }`,
        };
      }
      // File sudah ada: periksa pemiliknya.
      const holder = readHolderPid(lockPath);
      if (holder === null) {
        return {
          acquired: false,
          reason:
            `lock ${lockPath} ada tapi isinya bukan PID valid — ` +
            "hapus manual file-nya bila yakin tidak ada wa-engine jalan",
        };
      }
      if (holder === process.pid) {
        // Percobaan akuisisi kedua dari proses yang sama = start kedua:
        // tetap ditolak, supaya tidak ada jalan yang mengaburkan
        // "satu proses saja" (main() hanya mengakuisisi sekali).
        return {
          acquired: false,
          holderPid: holder,
          reason: `wa-engine sudah jalan (PID ${holder})`,
        };
      }
      if (pidAlive(holder)) {
        return {
          acquired: false,
          holderPid: holder,
          reason: `wa-engine sudah jalan (PID ${holder})`,
        };
      }
      // Stale: pemilik sudah mati -> hapus, lalu coba lagi.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return {
          acquired: false,
          holderPid: holder,
          reason: `lock stale (PID ${holder} mati) tapi gagal dihapus`,
        };
      }
      continue;
    }
    try {
      fs.writeFileSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, holderPid: process.pid };
  }
  return { acquired: false, reason: "gagal akuisisi lock setelah 2 percobaan" };
}

export function releaseLock(lockPath: string): void {
  try {
    // Hanya hapus bila masih milik proses ini.
    if (readHolderPid(lockPath) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // File sudah hilang / tak bisa dihapus: abaikan, proses keluar.
  }
}
