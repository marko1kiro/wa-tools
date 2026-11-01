<#
.SYNOPSIS
  Tray companion wa-engine (SPEC §13.5): ikon system tray + menu.
.DESCRIPTION
  Ikon di system tray Windows dengan menu:
    - Status koneksi (teks, diperbarui tiap 10 detik dari /health)
    - Buka Dashboard (browser ke dashboard web)
    - Restart Engine (Restart-Service; butuh hak atas service)
    - Berhenti Engine (Stop-Service; butuh hak atas service)
    - Keluar (hanya menutup tray, service tetap jalan)

  PENTING:
  - Tray hanya hidup di sesi desktop yang login. Service NSSM jalan
    tanpa login; tray adalah pendamping saat user sedang login.
  - Restart/Berhenti memanggil Service Control Manager: bila akun user
    tidak punya hak atas service, Windows menolak dan tray menampilkan
    balon peringatan (service tetap bisa di-restart dari shell elevated).
  - Jalankan: powershell -STA -File tray-companion.ps1
    (atau lewat shortcut Startup yang dibuat install-service.ps1
    dengan -WithTrayStartup).
  - Dashboard web (Next.js) TIDAK dijalankan tray ini; "Buka Dashboard"
    membuka URL-nya saja. Bila dashboard belum jalan (mis. pnpm dev
    belum start), browser menampilkan connection error — itu normal.

  CATATAN VERIFIKASI: script ini ditulis untuk Windows PowerShell 5.1
  + .NET Framework dan TIDAK BISA diuji dari VM Linux. Sebelum dipakai
  harian, verifikasi di PC user: ikon muncul, status berubah, menu
  Buka Dashboard / Restart / Berhenti bekerja. Alternatif bila tray
  tidak dipakai: kelola service dari Pengaturan dashboard + konsol
  Services (services.msc) seperti biasa.
.PARAMETER EngineUrl
  Base URL wa-engine. Default: http://127.0.0.1:3101.
.PARAMETER DashboardUrl
  URL dashboard web. Default: http://localhost:3000.
.PARAMETER ServiceName
  Nama service wa-engine. Default: wa-tools-engine.
#>
[CmdletBinding()]
param(
  [string]$EngineUrl = "http://127.0.0.1:3101",
  [string]$DashboardUrl = "http://localhost:3000",
  [string]$ServiceName = "wa-tools-engine"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:LastState = $null

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = "WA Tools Engine: memeriksa..."
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = "Status: memeriksa..."
$statusItem.Enabled = $false
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Buka Dashboard"
$openItem.Add_Click({ Start-Process $DashboardUrl })
[void]$menu.Items.Add($openItem)

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = "Restart Engine"
$restartItem.Add_Click({
  try {
    Restart-Service -Name $ServiceName -ErrorAction Stop
    $icon.ShowBalloonTip(3000, "WA Tools Engine", "Engine di-restart.", [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $icon.ShowBalloonTip(5000, "WA Tools Engine", "Gagal restart engine (butuh hak atas service?). Coba dari shell elevated.", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
[void]$menu.Items.Add($restartItem)

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem.Text = "Berhenti Engine"
$stopItem.Add_Click({
  try {
    Stop-Service -Name $ServiceName -ErrorAction Stop
    $icon.ShowBalloonTip(3000, "WA Tools Engine", "Engine dihentikan.", [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $icon.ShowBalloonTip(5000, "WA Tools Engine", "Gagal menghentikan engine (butuh hak atas service?).", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$context = New-Object System.Windows.Forms.ApplicationContext

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Keluar (tray saja)"
$exitItem.Add_Click({
  $icon.Visible = $false
  $icon.Dispose()
  $context.ExitThread()
})
[void]$menu.Items.Add($exitItem)

$icon.ContextMenuStrip = $menu

function Update-Status {
  $stateText = "engine tidak terjangkau"
  $connected = $false
  try {
    $health = Invoke-RestMethod -Uri "$EngineUrl/health" -TimeoutSec 3 -ErrorAction Stop
    if ($health.connected -eq $true) {
      $connected = $true
      $stateText = "terhubung"
      if ($health.phone) { $stateText = "terhubung ($($health.phone))" }
    } else {
      $stateText = "tidak terhubung ($($health.state))"
    }
  } catch {
    $connected = $false
    $stateText = "engine tidak terjangkau"
  }
  $statusItem.Text = "Status: $stateText"
  $icon.Text = "WA Tools Engine: $stateText"
  $icon.Icon = if ($connected) {
    [System.Drawing.SystemIcons]::Information
  } else {
    [System.Drawing.SystemIcons]::Warning
  }
  if ($script:LastState -ne $null -and $script:LastState -ne $connected) {
    $msg = if ($connected) { "WhatsApp terhubung kembali." } else { "WhatsApp terputus." }
    $icon.ShowBalloonTip(3000, "WA Tools Engine", $msg, [System.Windows.Forms.ToolTipIcon]::Info)
  }
  $script:LastState = $connected
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ Update-Status })
$timer.Start()

Update-Status
[System.Windows.Forms.Application]::Run($context)
