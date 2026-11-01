<#
.SYNOPSIS
  Install wa-engine sebagai Windows Service via NSSM (SPEC §13.1).
.DESCRIPTION
  Service "wa-tools-engine": Automatic (Delayed Start), restart otomatis
  saat crash (NSSM AppExit Default Restart, jeda 10 detik), jalan sebagai
  akun user (BUKAN SYSTEM) supaya file auth Baileys milik user, dan
  stdout/stderr ke file log berotasi (maks 10 MB per file).
  Install butuh hak admin SEKALI; setelah itu service jalan tanpa admin.

  Prasyarat: Node.js 20+, NSSM (nssm.exe di PATH atau -NssmPath),
  dan engine sudah di-build (apps/wa-engine/dist/index.js) — bila belum,
  script mencoba `pnpm --filter wa-engine build` bila pnpm tersedia.

  Password akun service HANYA diteruskan ke nssm (disimpan Windows
  Service Control Manager / LSA), tidak pernah ditulis ke file repo.
.PARAMETER ServiceName
  Nama service. Default: wa-tools-engine.
.PARAMETER ServiceUser
  Akun yang menjalankan service, format ".\username" atau
  "DOMAIN\username". Default: user yang menjalankan script ini.
.PARAMETER ServicePassword
  Password akun service (SecureString). Bila tidak diisi, diminta
  interaktif (Read-Host, tidak tampil di layar).
.PARAMETER NssmPath
  Path ke nssm.exe. Default: cari di PATH. Bila tidak ketemu, unduh
  dari https://nssm.cc/download lalu ulangi dengan -NssmPath.
.PARAMETER NodeExe
  Path ke node.exe. Default: cari di PATH.
.PARAMETER Port
  Port HTTP wa-engine. Default: 3101.
.PARAMETER Force
  Bila service sudah ada, hentikan + hapus lalu install ulang.
  Tanpa -Force, script berhenti dengan pesan error.
.PARAMETER WithTrayStartup
  Buat shortcut tray companion di folder Startup user, supaya ikon
  tray muncul otomatis tiap login (service sendiri jalan tanpa login).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-service.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-service.ps1 -Force -WithTrayStartup
.NOTES
  Script ini ditulis untuk Windows (PowerShell 5.1+). TIDAK BISA diuji
  dari VM Linux — verifikasi instalasi di PC user (lihat README).
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "wa-tools-engine",
  [string]$ServiceUser = ".\$env:USERNAME",
  [SecureString]$ServicePassword,
  [string]$NssmPath = "",
  [string]$NodeExe = "",
  [int]$Port = 3101,
  [switch]$Force,
  [switch]$WithTrayStartup
)

$ErrorActionPreference = "Stop"

# 1. Wajib admin (sekali, saat install saja).
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Script ini harus dijalankan sebagai Administrator (klik kanan PowerShell -> Run as administrator)."
  exit 1
}

# 2. Lokasi: script ini di <root>/apps/wa-engine/scripts/.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$EngineEntry = Join-Path $RepoRoot 'apps\wa-engine\dist\index.js'
$DataDir = Join-Path $RepoRoot 'data'
$LogsDir = Join-Path $RepoRoot 'logs'
$TrayScript = Join-Path $PSScriptRoot 'tray-companion.ps1'

if (-not $NodeExe) {
  $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $NodeExe) {
  Write-Error "node.exe tidak ditemukan di PATH. Install Node.js 20+ lalu ulangi."
  exit 1
}
if (-not $NssmPath) {
  $NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
}
if (-not $NssmPath) {
  Write-Error "nssm.exe tidak ditemukan di PATH. Unduh dari https://nssm.cc/download, lalu ulangi dengan -NssmPath <path-ke-nssm.exe>."
  exit 1
}

# 3. Engine harus sudah di-build; coba build bila pnpm tersedia.
if (-not (Test-Path $EngineEntry)) {
  $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
  if ($pnpm) {
    Write-Host "dist belum ada, mencoba build engine..."
    Push-Location $RepoRoot
    try { & $pnpm --filter wa-engine build } finally { Pop-Location }
  }
}
if (-not (Test-Path $EngineEntry)) {
  Write-Error "Engine belum di-build ($EngineEntry tidak ada). Jalankan `pnpm install` lalu `pnpm --filter wa-engine build` dari $RepoRoot, lalu ulangi install."
  exit 1
}

New-Item -ItemType Directory -Force -Path $DataDir, $LogsDir | Out-Null

# 4. Service sudah ada?
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  if (-not $Force) {
    Write-Error "Service $ServiceName sudah ada. Pakai -Force untuk install ulang, atau jalankan uninstall-service.ps1 dulu."
    exit 1
  }
  Write-Host "Service lama ditemukan, menghapus dulu (-Force)..."
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & $NssmPath remove $ServiceName confirm
}

# 5. Password akun service (tidak pernah ditulis ke file).
if (-not $ServicePassword) {
  $ServicePassword = Read-Host "Password akun $ServiceUser (untuk service, tidak tampil di layar)" -AsSecureString
}
$plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword)
)

# 6. Install + konfigurasi NSSM.
#    DATABASE_URL memakai garis miring (file:C:/...) agar libSQL Windows
#    tidak salah parsing backslash. Lock memakai path absolut supaya
#    tidak bergantung pada working directory service.
$DbFile = Join-Path $DataDir 'wa-tools.db'
$DbUrl = 'file:' + ($DbFile -replace '\\', '/')
$LockFile = Join-Path $DataDir 'wa-engine.lock'

& $NssmPath install $ServiceName $NodeExe $EngineEntry
& $NssmPath set $ServiceName DisplayName "WA Tools Engine"
& $NssmPath set $ServiceName Description "WhatsApp Tools - Baileys engine (koneksi WA, antrean kirim)."
& $NssmPath set $ServiceName AppDirectory $RepoRoot
# AppEnvironmentExtra: tiap argumen = satu entri REG_MULTI_SZ.
& $NssmPath set $ServiceName AppEnvironmentExtra "WA_ENGINE_MOCK=0" "WA_ENGINE_PORT=$Port" "DATABASE_URL=$DbUrl" "WA_ENGINE_LOCK_FILE=$LockFile"
& $NssmPath set $ServiceName ObjectName $ServiceUser $plainPassword
& $NssmPath set $ServiceName Start SERVICE_DELAYED_AUTO_START
& $NssmPath set $ServiceName AppExit Default Restart
& $NssmPath set $ServiceName AppRestartDelay 10000
# Kode exit 2 = lock ditahan proses lain: JANGAN di-restart (hindari loop).
# Bila nssm versi lama menolak sintaks per-kode, lanjut saja (peringatan).
try {
  & $NssmPath set $ServiceName AppExit 2 Exit
} catch {
  Write-Warning "nssm menolak AppExit per-kode (2 Exit); default Restart tetap berlaku. Bila service restart loop karena lock, hentikan proses wa-engine kedua secara manual."
}
& $NssmPath set $ServiceName AppStdout (Join-Path $LogsDir 'wa-engine.out.log')
& $NssmPath set $ServiceName AppStderr (Join-Path $LogsDir 'wa-engine.err.log')
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 10485760
& $NssmPath set $ServiceName AppStdoutCreationDisposition 4
& $NssmPath set $ServiceName AppStderrCreationDisposition 4

# 7. Jalankan service + ringkasan.
Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
Get-Service -Name $ServiceName | Format-Table Name, Status, StartType -AutoSize
Write-Host ""
Write-Host "Service $ServiceName terinstall dan berjalan."
Write-Host "  Health  : http://127.0.0.1:$Port/health"
Write-Host "  Log     : $LogsDir\wa-engine.out.log / wa-engine.err.log"
Write-Host "  Data    : $DbFile"
Write-Host "  Pairing : buka dashboard -> Pengaturan -> scan QR atau 'Gunakan kode pairing'."
Write-Host "  Update  : git pull dari $RepoRoot, lalu: Restart-Service -Name $ServiceName (butuh shell elevated)."
Write-Host "  Uninstall: jalankan uninstall-service.ps1 (data/log/auth TIDAK dihapus)."

if ($WithTrayStartup) {
  $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $startup 'WA Tools Tray.lnk'))
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-STA -WindowStyle Hidden -File `"$TrayScript`""
  $shortcut.WorkingDirectory = $PSScriptRoot
  $shortcut.Save()
  Write-Host "  Tray    : shortcut autostart dibuat (ikon tray muncul tiap login)."
}
