# SPDX-License-Identifier: Apache-2.0
# NotNativeDesktop tray host: the tray icon is coupled to the SERVICE, never to
# the desktop client. The supervised service child spawns this script after the
# readiness frame; the icon lives exactly as long as the service generation it
# belongs to. "Open NNA Desktop" launches the desktop client (which starts the
# service first if it is down); "Quit NNA" asks the supervisor's controller to
# stop the service, then exits once this generation's discovery record goes
# away. Deliberately NOT Electron: a tray must not cost a Chromium boot.

param(
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [string]$Generation
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Single instance per data root: a second spawn for the same service is a no-op
# (the shortcut path can race the service's own spawn). The mutex dies with the
# process, so a service restart reliably gets a fresh tray. GetHashCode is
# stable per machine on Windows PowerShell 5.1 (.NET Framework), which is all
# the mutex name needs: uniqueness per data root on this machine.
$mutexName = 'Local\NotNativeDesktopTray-' + ($DataRoot.ToUpperInvariant().GetHashCode() -as [string])
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
# A retiring generation can own the mutex for one watchdog tick after the new service is ready.
try { if (-not $mutex.WaitOne(10000)) { exit 0 } } catch [System.Threading.AbandonedMutexException] { }

$runtimeDir = Join-Path $DataRoot 'runtime\nnd'
function Read-CurrentRecord {
  $currentPath = Join-Path $runtimeDir 'current.json'
  if (-not (Test-Path $currentPath)) { return $null }
  try {
    $current = Get-Content $currentPath -Raw | ConvertFrom-Json
    if ($Generation -and $current.instance_id -cne $Generation) { return $null }
    $generationPath = Join-Path $runtimeDir ('generation-' + $current.instance_id + '.json')
    if (-not (Test-Path $generationPath)) { return $null }
    $generation = Get-Content $generationPath -Raw | ConvertFrom-Json
    if (-not $generation.control_token -or -not $generation.endpoint) { return $null }
    return $generation
  } catch { return $null }
}

function Stop-Service {
  $record = Read-CurrentRecord
  if (-not $record) { return $false }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($record.endpoint + '/stop') `
      -Headers @{ authorization = 'Bearer ' + $record.control_token } `
      -ContentType 'application/json' -Body '{}' -TimeoutSec 5
    return ($response.StatusCode -eq 202)
  } catch { return $false }
}

$notifyIcon = $null
$menu = $null
$timer = $null
$exiting = $false

function Convert-PngToIcon {
  param([string]$PngPath)
  if (-not (Test-Path $PngPath)) { return $null }
  try {
    $bitmap = [System.Drawing.Bitmap]::new($PngPath)
    try { return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon()) } finally { $bitmap.Dispose() }
  } catch { return $null }
}

function Exit-Tray {
  if ($exiting) { return }
  $script:exiting = $true
  try { $timer.Stop() } catch { }
  try { $notifyIcon.Visible = $false } catch { }
  try { $notifyIcon.Dispose() } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  try { $mutex.Dispose() } catch { }
  [System.Windows.Forms.Application]::Exit()
}

function Open-Desktop {
  $launcher = Join-Path $InstallRoot 'scripts\launch-selected-desktop.mjs'
  if (-not (Test-Path $launcher)) { return }
  Start-Process -FilePath $NodePath -ArgumentList @('--disable-warning=ExperimentalWarning', ('"' + $launcher + '"')) `
    -WorkingDirectory $InstallRoot -WindowStyle Hidden
}

function Invoke-TrayAction([string]$Action) {
  $helper = Join-Path $InstallRoot 'scripts\tray-action.mjs'
  try {
    Start-Process -FilePath $NodePath -ArgumentList @('--disable-warning=ExperimentalWarning', ('"' + $helper + '"'), $Action) -WorkingDirectory $InstallRoot -WindowStyle Hidden
  } catch { [void][System.Windows.Forms.MessageBox]::Show('NNA could not launch the tray action.', 'NNA') }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open NNA Desktop')
$openItem.add_Click({ Open-Desktop })
$browserItem = $menu.Items.Add('Open in browser')
$browserItem.add_Click({ Invoke-TrayAction 'browser' })
$restartItem = $menu.Items.Add('Restart NNA')
$restartItem.add_Click({ Invoke-TrayAction 'restart' })
[void]$menu.Items.Add('-')
$quitItem = $menu.Items.Add('Quit NNA')
$quitItem.add_Click({ if (Stop-Service) { Exit-Tray } })

$assetsDir = Join-Path $InstallRoot 'packages\electron\assets'
$icon = Convert-PngToIcon (Join-Path $assetsDir 'tray-running.png')
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
if ($icon) { $notifyIcon.Icon = $icon } else {
  $fallback = [System.Drawing.SystemIcons]::Application
  $notifyIcon.Icon = $fallback
}
$notifyIcon.Text = 'NotNativeAgent (NNA)'
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Visible = $true
$notifyIcon.add_DoubleClick({ Open-Desktop })

# Lifetime watchdog: the tray belongs to exactly one service generation. It
# exits when (a) this generation's discovery record disappears (service
# stopped, or replaced by a new generation after a restart — the new
# generation spawns its own tray), or (b) the parent service child dies
# without removing its record (crash path).
$parentPid = $PID
$servicePid = $null
try {
  $servicePid = (Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid").ParentProcessId
} catch { $servicePid = $null }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  $serviceAlive = $true
  if ($servicePid) {
    try { $serviceAlive = $null -ne (Get-Process -Id $servicePid -ErrorAction Stop) } catch { $serviceAlive = $false }
  }
  $record = Read-CurrentRecord
  if ((-not $record) -or (-not $serviceAlive)) { Exit-Tray }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
try { $mutex.ReleaseMutex() } catch { }
$mutex.Dispose()
