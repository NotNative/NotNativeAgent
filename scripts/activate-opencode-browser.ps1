# Activate the NNA browser route in OpenChamber
#
# Why this script exists: the patched application tree is already deployed at
# `resources\app`, but Electron reads `resources\app.asar` first and the running
# process holds that archive open. Activation is therefore one restart with the
# archive set aside. This script does it, checks the result, and can undo it.
#
# Run with OpenChamber closed:  .\activate-opencode-browser.ps1
# Revert:                     .\activate-opencode-browser.ps1 -Revert

[CmdletBinding()]
param(
  [switch]$Revert,
  [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\@openchamberelectron",
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
$resources = Join-Path $InstallRoot 'resources'
$asar = Join-Path $resources 'app.asar'
$disabled = Join-Path $resources 'app.asar.disabled'
$appDir = Join-Path $resources 'app'
$capabilityName = 'nna-browser.json'

function Write-Step($message) { Write-Host "  $message" }

if (-not (Test-Path $resources)) {
  throw "OpenChamber is not installed at $InstallRoot. Pass -InstallRoot with the correct path."
}

if ($Revert) {
  if (-not (Test-Path $disabled)) {
    Write-Host 'Nothing to revert: no disabled archive is present, so the shipped build is already active.'
    return
  }
  if (Test-Path $asar) { throw "Both app.asar and app.asar.disabled exist; refusing to guess which is the shipped build." }
  Move-Item $disabled $asar
  Write-Host 'Reverted. OpenChamber runs its shipped build again; the browser route is inactive.'
  return
}

Write-Host 'Activating the NNA browser route'
if (-not (Test-Path $appDir)) {
  throw "The patched application tree is missing at $appDir. It must be deployed before this script can activate it."
}

# Why the lock check: moving a file the running app holds open fails, and a
# half-done swap is worse than none.
$running = Get-Process -Name OpenChamber -ErrorAction SilentlyContinue
if ($running) {
  throw "OpenChamber is running (PID $($running[0].Id)). Close it, then run this again. The archive it loads cannot be moved aside while it is open."
}

if (Test-Path $asar) {
  Move-Item $asar $disabled
  Write-Step "Set aside app.asar, so only the patched resources\app is present."
} else {
  Write-Step 'app.asar is already set aside.'
}

# Why wait for the binding: a launched app writes it during startup, and reading
# it is the only evidence that the route actually registered rather than being
# skipped by the try/catch around it.
Write-Host 'Starting OpenChamber and waiting for the route to publish its binding...'
Start-Process -FilePath (Join-Path $InstallRoot 'OpenChamber.exe') | Out-Null

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$found = $null
while ((Get-Date) -lt $deadline -and -not $found) {
  Start-Sleep -Seconds 2
  foreach ($root in @((Join-Path $env:USERPROFILE '.config\openchamber'), (Join-Path $env:APPDATA 'OpenChamber'))) {
    $instances = Join-Path $root 'run\instances'
    if (-not (Test-Path $instances)) { continue }
    $found = Get-ChildItem $instances -Recurse -Filter $capabilityName -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { break }
  }
}

if (-not $found) {
  Write-Warning "No binding appeared within $WaitSeconds seconds. The route logged a warning at startup instead; check the OpenChamber log under ~/.config/openchamber/logs for 'NNA browser route unavailable'."
  Write-Host "To undo: .\activate-opencode-browser.ps1 -Revert"
  exit 1
}

$binding = Get-Content $found.FullName -Raw | ConvertFrom-Json
Write-Host ''
Write-Host 'Active. The browser pane can now be driven from NNA conversations.'
Write-Step "Binding: $($binding.url)"
Write-Step "Written: $($found.FullName)"
Write-Host ''
Write-Host 'NNA needs no restart: the next conversation resolves the binding automatically.'
Write-Host 'To undo: .\activate-opencode-browser.ps1 -Revert'
