<#
.SYNOPSIS
  Hapus Windows Service wa-tools-engine (SPEC §13.1).
.DESCRIPTION
  Menghentikan lalu menghapus service. TIDAK menghapus data (data/*.db),
  log (logs/), maupun folder auth Baileys — semua itu tetap di repo dan
  bisa dipakai install ulang. Jalankan sebagai Administrator.
.PARAMETER ServiceName
  Nama service. Default: wa-tools-engine.
.PARAMETER NssmPath
  Path ke nssm.exe. Default: cari di PATH.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall-service.ps1
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "wa-tools-engine",
  [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Script ini harus dijalankan sebagai Administrator."
  exit 1
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "Service $ServiceName tidak ditemukan — tidak ada yang dihapus."
  exit 0
}

if (-not $NssmPath) {
  $NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
}
if (-not $NssmPath) {
  Write-Error "nssm.exe tidak ditemukan di PATH. Ulangi dengan -NssmPath <path-ke-nssm.exe>."
  exit 1
}

Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
& $NssmPath remove $ServiceName confirm
Write-Host "Service $ServiceName dihapus. Data (data/), log (logs/), dan auth Baileys TIDAK dihapus."
