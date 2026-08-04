# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$InstallRoot,
    [string]$DataRoot,
    [switch]$SkipPathUpdate,
    [switch]$SkipDependencyInstall,
    [switch]$SkipRipgrepSetup,
    [switch]$ForceBundledNode,
    [switch]$SkipProviderSetup,
    [switch]$SkipWebSearchSetup,
    [switch]$DeployLocalSearch,
    [string]$WebSearchEndpoint,
    [switch]$SkipGatewaySetup,
    [string]$TelegramBotToken,
    [string]$TelegramUserId,
    [switch]$StartGateway,
    [string]$NodeDownloadBase = 'https://nodejs.org/dist/latest-v24.x'
)

$ErrorActionPreference = 'Stop'
$Product = 'NotNativeAgent'
$UserHome = [Environment]::GetFolderPath('UserProfile')
$LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $SourceRoot) { $SourceRoot = $PSScriptRoot }
if (-not $InstallRoot) { $InstallRoot = Join-Path $LocalAppData $Product }
if (-not $DataRoot) { $DataRoot = Join-Path $UserHome '.nna' }
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)

$UseInstallerColor = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
function Write-InstallerLine([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
    if ($UseInstallerColor) { Write-Host $Text -ForegroundColor $Color }
    else { Write-Output $Text }
}
function Write-InstallerSection([string]$Title) {
    Write-Output ''
    Write-InstallerLine "== $Title ==" Cyan
}
function Write-InstallerStep([string]$Text) { Write-InstallerLine "  > $Text" DarkGray }
function Write-InstallerOk([string]$Text) { Write-InstallerLine " [OK] $Text" Green }
function Write-InstallerSkip([string]$Text) { Write-InstallerLine " [--] $Text" DarkGray }
function Write-InstallerWarning([string]$Text) { Write-InstallerLine " [!!] $Text" Yellow }
function Write-InstallerBrand([string]$Release) {
    Write-Output ''
    Write-InstallerLine ' NNA // INSTALLER' Magenta
    Write-InstallerLine " NotNativeAgent $Release" White
    Write-InstallerLine ' Local-first agent runtime' DarkGray
}

function Find-Ripgrep {
    $Command = Get-Command rg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Command) { return $Command.Source }
    return $null
}

function Install-Ripgrep {
    $Managers = @(
        @{ Name = 'winget'; Args = @('install', '--id', 'BurntSushi.ripgrep.MSVC', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements') },
        @{ Name = 'choco'; Args = @('install', 'ripgrep', '-y') },
        @{ Name = 'scoop'; Args = @('install', 'ripgrep') }
    )
    foreach ($Manager in $Managers) {
        if (-not (Get-Command $Manager.Name -ErrorAction SilentlyContinue)) { continue }
        Write-InstallerStep "Installing ripgrep with $($Manager.Name)"
        $Arguments = $Manager.Args
        & $Manager.Name @Arguments
        if ($LASTEXITCODE -eq 0) { return $true }
        Write-InstallerWarning "$($Manager.Name) did not complete the ripgrep installation"
    }
    return $false
}

function Initialize-Ripgrep {
    $Existing = Find-Ripgrep
    if ($Existing) {
        $VersionLine = (& $Existing --version | Select-Object -First 1)
        Write-InstallerOk "$VersionLine"
        Write-InstallerLine "      $Existing" DarkGray
        return
    }
    Write-InstallerWarning 'ripgrep was not found; NNA will retain its slower native search fallback'
    if ($SkipRipgrepSetup -or $SkipDependencyInstall) {
        Write-InstallerSkip 'Optional ripgrep installation skipped by request'
        return
    }
    if ([Console]::IsInputRedirected) {
        Write-InstallerSkip 'Non-interactive install detected; use ripgrep package guidance after installation if desired'
        return
    }
    $Answer = (Read-Host 'Install ripgrep search acceleration now? [Y/n]').Trim()
    if ($Answer -match '^(n|no)$') {
        Write-InstallerSkip 'Optional ripgrep installation declined; native search remains available'
        return
    }
    if (-not (Install-Ripgrep)) {
        Write-InstallerWarning 'No supported package manager installed ripgrep; NNA will use native search'
        return
    }
    $Installed = Find-Ripgrep
    if ($Installed) { Write-InstallerOk "ripgrep installed: $Installed" }
    else { Write-InstallerWarning 'ripgrep installed but is not visible in this terminal; open a new terminal before using NNA' }
}

function Assert-SafeRoot([string]$Path, [string[]]$Forbidden) {
    $Resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    foreach ($Value in $Forbidden) {
        if ($Resolved -ieq [IO.Path]::GetFullPath($Value).TrimEnd('\')) { throw "Unsafe product root: $Resolved" }
    }
}

function Protect-UserDataRoot([string]$Path) {
    $Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & $Icacls $Path '/inheritance:r' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to disable inherited ACLs on $Path" }
    & $Icacls $Path '/grant:r' "*${CurrentSid}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to grant the current user access to $Path" }
    & $Icacls $Path '/grant:r' '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to grant SYSTEM access to $Path" }
}

function Test-LegacyGatewayTask([object]$Task, [string]$ExpectedScript) {
    $Actions = @($Task.Actions)
    if ($Actions.Count -ne 1) { return $false }
    $Executable = [IO.Path]::GetFileName(([string]$Actions[0].Execute).Trim())
    if ($Executable -notin @('wscript.exe', 'cscript.exe')) { return $false }
    $Argument = ([string]$Actions[0].Arguments).Trim()
    if ($Argument.Length -ge 2 -and $Argument[0] -eq '"' -and $Argument[$Argument.Length - 1] -eq '"') {
        $Argument = $Argument.Substring(1, $Argument.Length - 2)
    }
    try { $ResolvedArgument = [IO.Path]::GetFullPath($Argument) }
    catch { return $false }
    return $ResolvedArgument -ieq [IO.Path]::GetFullPath($ExpectedScript)
}

function Remove-LegacyGatewayTaskElevated {
    $Cleanup = @'
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'NotNativeAgentGateway' -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $task) { exit 2 }
$actions = @($task.Actions)
$expected = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.nna\gateway.vbs'))
if ($actions.Count -ne 1) { exit 3 }
$executable = [IO.Path]::GetFileName(([string]$actions[0].Execute).Trim())
if ($executable -notin @('wscript.exe', 'cscript.exe')) { exit 3 }
$argument = ([string]$actions[0].Arguments).Trim()
if ($argument.Length -ge 2 -and $argument[0] -eq '"' -and $argument[$argument.Length - 1] -eq '"') {
    $argument = $argument.Substring(1, $argument.Length - 2)
}
try { $resolved = [IO.Path]::GetFullPath($argument) } catch { exit 3 }
if ($resolved -ine $expected) { exit 3 }
Unregister-ScheduledTask -TaskName 'NotNativeAgentGateway' -TaskPath '\' -Confirm:$false
exit 0
'@
    $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Cleanup))
    try {
        $Process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-EncodedCommand', $Encoded
        ) -Wait -PassThru
        return $Process.ExitCode
    } catch {
        return 4
    }
}

function Remove-LegacyGatewayTask {
    $TaskName = 'NotNativeAgentGateway'
    $ExpectedScript = Join-Path $UserHome '.nna\gateway.vbs'
    try {
        $Task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    } catch {
        $Task = $null
    }
    if (-not $Task) { return }
    if (-not (Test-LegacyGatewayTask $Task $ExpectedScript)) {
        Write-InstallerWarning "Scheduled task \$TaskName was preserved because it does not target the legacy NNA gateway."
        return
    }
    try {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
        Write-InstallerOk 'Removed the legacy elevated Telegram gateway task'
        return
    } catch [System.UnauthorizedAccessException] {
        Write-InstallerStep 'Administrator approval is required to remove the legacy gateway task'
    } catch {
        if ($_.Exception.Message -notmatch 'access.*denied|0x80070005') {
            Write-InstallerWarning "The legacy gateway task could not be removed: $($_.Exception.Message)"
            return
        }
        Write-InstallerStep 'Administrator approval is required to remove the legacy gateway task'
    }
    $ExitCode = Remove-LegacyGatewayTaskElevated
    if ($ExitCode -eq 0 -or $ExitCode -eq 2) {
        Write-InstallerOk 'Removed the legacy elevated Telegram gateway task'
    } elseif ($ExitCode -eq 3) {
        Write-InstallerWarning "Scheduled task \$TaskName changed during inspection and was preserved."
    } else {
        Write-InstallerWarning 'Legacy gateway cleanup was not approved; the existing task was preserved.'
    }
}

Assert-SafeRoot $InstallRoot @([IO.Path]::GetPathRoot($InstallRoot), $UserHome, $LocalAppData)
Assert-SafeRoot $DataRoot @([IO.Path]::GetPathRoot($DataRoot), $UserHome)

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $ResolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $ResolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    if (-not $ResolvedPath.StartsWith("$ResolvedParent\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside expected parent: $ResolvedPath"
    }
}

function Copy-ProductFile([string]$RelativePath, [string]$DestinationRoot) {
    $Source = Join-Path $SourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $Source)) { throw "Release file is missing: $RelativePath" }
    $Destination = Join-Path $DestinationRoot $RelativePath
    $Parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-CompatibleNode {
    $Command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Command) { return $null }
    try {
        $Major = [int]((& $Command.Source -p "process.versions.node.split('.')[0]").Trim())
        if ($Major -ge 24) { return [string]$Command.Source }
    } catch { return $null }
    return $null
}

function Get-ManagedNode([string]$Root) {
    $RuntimeRoot = Join-Path $Root 'runtime'
    if (-not (Test-Path -LiteralPath $RuntimeRoot)) { return $null }
    foreach ($Candidate in Get-ChildItem -LiteralPath $RuntimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue) {
        Assert-ChildPath $Candidate.FullName $RuntimeRoot
        try {
            $Major = [int]((& $Candidate.FullName -p "process.versions.node.split('.')[0]").Trim())
            if ($Major -ge 24) { return [string]$Candidate.FullName }
        } catch { continue }
    }
    return $null
}

function Install-UserNode([string]$Root, [string]$DownloadBase) {
    $Architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
    }
    $RuntimeRoot = Join-Path $Root 'runtime'
    $DownloadRoot = Join-Path $RuntimeRoot ('.download-{0}' -f $PID)
    New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null
    Assert-ChildPath $DownloadRoot $RuntimeRoot
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $SumsPath = Join-Path $DownloadRoot 'SHASUMS256.txt'
        $Client = New-Object Net.WebClient
        $Client.DownloadFile("$($DownloadBase.TrimEnd('/'))/SHASUMS256.txt", $SumsPath)
        $Pattern = "^([a-f0-9]{64})\s+\*?(node-v([0-9]+\.[0-9]+\.[0-9]+)-win-$Architecture\.zip)$"
        $Expected = $null; $ArchiveName = $null; $NodeVersion = $null
        foreach ($Line in Get-Content -LiteralPath $SumsPath) {
            if ($Line -match $Pattern) { $Expected = $Matches[1]; $ArchiveName = $Matches[2]; $NodeVersion = $Matches[3]; break }
        }
        if (-not $ArchiveName) { throw "Official Node.js checksums do not contain a Windows $Architecture archive." }
        $ArchivePath = Join-Path $DownloadRoot $ArchiveName
        $Client.DownloadFile("$($DownloadBase.TrimEnd('/'))/$ArchiveName", $ArchivePath)
        $Actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Actual -ne $Expected.ToLowerInvariant()) { throw 'Downloaded Node.js archive failed SHA-256 verification.' }
        $ExtractRoot = Join-Path $DownloadRoot 'extract'
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot
        $DirectoryName = "node-v$NodeVersion-win-$Architecture"
        $Extracted = Join-Path $ExtractRoot $DirectoryName
        $RuntimeTarget = Join-Path $RuntimeRoot $DirectoryName
        Assert-ChildPath $RuntimeTarget $RuntimeRoot
        if (Test-Path -LiteralPath $RuntimeTarget) {
            if (-not (Test-Path -LiteralPath (Join-Path $RuntimeTarget 'node.exe'))) { throw 'Refusing to replace a foreign runtime directory.' }
            Remove-Item -LiteralPath $RuntimeTarget -Recurse -Force
        }
        Move-Item -LiteralPath $Extracted -Destination $RuntimeTarget
        return Join-Path $RuntimeTarget 'node.exe'
    } finally {
        if (Test-Path -LiteralPath $DownloadRoot) { Remove-Item -LiteralPath $DownloadRoot -Recurse -Force }
    }
}

$PackagePath = Join-Path $SourceRoot 'package.json'
if (-not (Test-Path -LiteralPath $PackagePath)) { throw 'package.json was not found in the source root.' }
$Package = Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json
if ($Package.name -ne 'not-native-agent') { throw 'The source directory is not a NotNativeAgent release.' }
$Version = if ($Package.nna_version) { [string]$Package.nna_version } else { [string]$Package.version }
Write-InstallerBrand $Version
Write-InstallerSection 'Runtime readiness'
Write-InstallerOk "Release manifest: $Version"
Write-InstallerStep 'Locating a compatible Node.js 24+ runtime'
$NodeSource = 'system'
$NodePath = if ($ForceBundledNode) { $null } else { Get-CompatibleNode }
if (-not $NodePath -and -not $ForceBundledNode) { $NodePath = Get-ManagedNode $InstallRoot; $NodeSource = 'managed' }
if (-not $NodePath) {
    if ($SkipDependencyInstall) { throw 'Node.js 24 or newer is missing and dependency installation was disabled.' }
    Write-InstallerStep 'Downloading the verified official Node.js 24 LTS runtime for this user'
    $NodePath = Install-UserNode $InstallRoot $NodeDownloadBase
    $NodeSource = 'new managed'
}
$NodeMajor = [int]((& $NodePath -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 24) { throw 'Installed Node.js dependency validation failed.' }
$NodeVersion = (& $NodePath -p 'process.versions.node').Trim()
Write-InstallerOk "Node.js v$NodeVersion ($NodeSource)"
Write-InstallerLine "      $NodePath" DarkGray
Initialize-Ripgrep

Write-InstallerSection 'Application payload'
Write-InstallerStep "Staging version $Version"
$Target = Join-Path $InstallRoot 'installed'
$Stage = Join-Path $InstallRoot ('.installed.staging-{0}' -f $PID)
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Assert-ChildPath $Stage $InstallRoot
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

try {
    New-Item -ItemType Directory -Path (Join-Path $Stage 'src') | Out-Null
    Copy-Item -Path (Join-Path $SourceRoot 'src\*') -Destination (Join-Path $Stage 'src') -Recurse -Force
    Copy-Item -Path (Join-Path $SourceRoot 'docs') -Destination (Join-Path $Stage 'docs') -Recurse -Force
    $PlanningDocs = Join-Path $Stage 'docs\planning'
    if (Test-Path -LiteralPath $PlanningDocs) { Remove-Item -LiteralPath $PlanningDocs -Recurse -Force }
    Copy-Item -Path (Join-Path $SourceRoot 'resources') -Destination (Join-Path $Stage 'resources') -Recurse -Force
    foreach ($File in @('package.json', 'LICENSE', 'NOTICE', 'SECURITY.md', 'SUPPORT.md', 'THIRD_PARTY_NOTICES.md', 'SBOM.spdx.json')) {
        Copy-ProductFile $File $Stage
    }
    Assert-ChildPath $Target $InstallRoot
    if (Test-Path -LiteralPath $Target) {
        $ExistingPackagePath = Join-Path $Target 'package.json'
        if (-not (Test-Path -LiteralPath $ExistingPackagePath)) { throw 'Refusing to replace an unmarked version directory.' }
        $ExistingPackage = Get-Content -LiteralPath $ExistingPackagePath -Raw | ConvertFrom-Json
        if ($ExistingPackage.name -ne 'not-native-agent') { throw 'Refusing to replace a foreign version directory.' }
        Remove-Item -LiteralPath $Target -Recurse -Force
    }
    Move-Item -LiteralPath $Stage -Destination $Target
} catch {
    if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
    throw
}
Write-InstallerOk "Runtime files installed"
Write-InstallerLine "      $Target" DarkGray

New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'transitory') | Out-Null

Write-InstallerSection 'User data and security'
Write-InstallerStep 'Preparing durable sessions, configuration, logs, and support storage'
$DataMarkerPath = Join-Path $DataRoot '.nna-install.json'
$DeleteAllowed = -not (Test-Path -LiteralPath $DataRoot)
if (Test-Path -LiteralPath $DataMarkerPath) {
    $ExistingDataMarker = Get-Content -LiteralPath $DataMarkerPath -Raw | ConvertFrom-Json
    $DeleteAllowed = $ExistingDataMarker.product -eq $Product -and $ExistingDataMarker.deletable -eq $true
}
foreach ($Directory in @($DataRoot, (Join-Path $DataRoot 'sessions'), (Join-Path $DataRoot 'reviewer-ledger'), (Join-Path $DataRoot 'config'), (Join-Path $DataRoot 'logs'), (Join-Path $DataRoot 'support'))) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
}
Protect-UserDataRoot $DataRoot
$DataMarker = @{ product = $Product; data_root = $DataRoot; created_by = 'windows-installer'; deletable = $DeleteAllowed } | ConvertTo-Json
[IO.File]::WriteAllText($DataMarkerPath, $DataMarker, [Text.UTF8Encoding]::new($false))
Write-InstallerOk 'User data directories prepared with restricted ACLs'
Write-InstallerLine "      $DataRoot" DarkGray

Write-InstallerSection 'Command launchers'
$BinRoot = Join-Path $InstallRoot 'bin'
New-Item -ItemType Directory -Force -Path $BinRoot | Out-Null
$Launcher = "@echo off`r`nset `"NNA_HOME=$DataRoot`"`r`n`"$NodePath`" `"$Target\src\cli.js`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $BinRoot 'nna.cmd'), $Launcher, [Text.ASCIIEncoding]::new())
$PowerShellDataRoot = $DataRoot.Replace("'", "''")
$PowerShellNodePath = $NodePath.Replace("'", "''")
$PowerShellCliPath = (Join-Path $Target 'src\cli.js').Replace("'", "''")
$PowerShellLauncher = @"
# SPDX-License-Identifier: Apache-2.0
`$PriorNnaHome = `$env:NNA_HOME
try {
    `$env:NNA_HOME = '$PowerShellDataRoot'
    & '$PowerShellNodePath' '$PowerShellCliPath' @args
    `$NnaExitCode = `$LASTEXITCODE
} finally {
    `$env:NNA_HOME = `$PriorNnaHome
}
exit `$NnaExitCode
"@
[IO.File]::WriteAllText((Join-Path $BinRoot 'nna.ps1'), $PowerShellLauncher, [Text.UTF8Encoding]::new($false))
$InstallMarker = @{ product = $Product; version = $Version; install_root = $InstallRoot; data_root = $DataRoot; node = $NodePath; node_major = $NodeMajor } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $InstallRoot 'install.json'), $InstallMarker, [Text.UTF8Encoding]::new($false))
Write-InstallerOk 'PowerShell and Command Prompt launchers written'
Write-InstallerLine "      $BinRoot" DarkGray

Write-InstallerSection 'Initial provider profile'
$PriorNnaHome = $env:NNA_HOME
$env:NNA_HOME = $DataRoot
try {
    $ProviderStatus = & $NodePath (Join-Path $Target 'src\cli.js') provider status | ConvertFrom-Json
    if ($ProviderStatus.configured) {
        Write-InstallerSkip "Provider profile already configured; setup skipped."
    } elseif ($SkipProviderSetup -or [Console]::IsInputRedirected) {
        Write-InstallerSkip 'Interactive provider setup skipped; run NNA to configure a provider later'
    } else {
        do { $ProviderEndpoint = (Read-Host 'OpenAI-compatible provider URL (example: http://127.0.0.1:1234/v1)').Trim() } while (-not $ProviderEndpoint)
        $SecureProviderKey = Read-Host 'Provider API key (leave blank if authentication is not required)' -AsSecureString
        $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureProviderKey)
        try { $ProviderKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
        Write-InstallerStep 'Discovering available models from the provider'
        $DiscoveryJson = $ProviderKey | & $NodePath (Join-Path $Target 'src\cli.js') provider discover $ProviderEndpoint
        if ($LASTEXITCODE -ne 0) { throw 'Provider model discovery failed. Verify the URL and API key, then run the installer again.' }
        $Models = @(($DiscoveryJson | ConvertFrom-Json).models)
        for ($Index = 0; $Index -lt $Models.Count; $Index++) { Write-InstallerLine ("  {0,3}. {1}" -f ($Index + 1), $Models[$Index]) White }
        do {
            $Selection = (Read-Host 'Choose a model by number or exact model name').Trim()
            $SelectedModel = $null
            $Number = 0
            if ([int]::TryParse($Selection, [ref]$Number) -and $Number -ge 1 -and $Number -le $Models.Count) {
                $SelectedModel = [string]$Models[$Number - 1]
            } else {
                $SelectedModel = @($Models | Where-Object { $_ -ceq $Selection } | Select-Object -First 1)[0]
            }
            if (-not $SelectedModel) { Write-InstallerWarning 'Enter a listed number or an exact model name.' }
        } while (-not $SelectedModel)
        $ConfigureJson = $ProviderKey | & $NodePath (Join-Path $Target 'src\cli.js') provider configure $ProviderEndpoint $SelectedModel
        if ($LASTEXITCODE -ne 0) { throw 'Provider profile could not be saved.' }
        $ConfiguredProvider = $ConfigureJson | ConvertFrom-Json
        Write-InstallerOk "Provider configured: $($ConfiguredProvider.endpoint) / $($ConfiguredProvider.model)"
    }
} finally {
    $env:NNA_HOME = $PriorNnaHome
    $ProviderKey = $null
    $SecureProviderKey = $null
}

Write-InstallerSection 'WebSearch integration'
$PriorNnaHome = $env:NNA_HOME
$env:NNA_HOME = $DataRoot
try {
    $SearchStatus = & $NodePath (Join-Path $Target 'src\cli.js') websearch status | ConvertFrom-Json
    if ($SearchStatus.configured) {
        Write-InstallerSkip "WebSearch is already configured at $($SearchStatus.config.endpoint); setup skipped."
    } elseif ($WebSearchEndpoint) {
        Write-InstallerStep "Validating existing SearXNG endpoint: $WebSearchEndpoint"
        & $NodePath (Join-Path $Target 'src\cli.js') websearch configure $WebSearchEndpoint | Out-Null
        Write-InstallerOk "WebSearch configured at $WebSearchEndpoint"
    } elseif ($DeployLocalSearch) {
        Write-InstallerStep 'Checking Docker and deploying loopback-only SearXNG'
        & $NodePath (Join-Path $Target 'src\cli.js') websearch deploy | Out-Null
        Write-InstallerOk 'Loopback-only SearXNG deployed and configured'
    } elseif (-not $SkipWebSearchSetup -and -not [Console]::IsInputRedirected) {
        $ConfigureSearch = Read-Host 'Configure WebSearch now? [y/N]'
        if ($ConfigureSearch -match '^(?i:y|yes)$') {
            $Endpoint = Read-Host 'Enter the base URL of your existing SearXNG server (example: http://192.168.1.50:8080), or leave blank to deploy a new local instance with Docker'
            if ($Endpoint) { & $NodePath (Join-Path $Target 'src\cli.js') websearch configure $Endpoint | Out-Null }
            else { & $NodePath (Join-Path $Target 'src\cli.js') websearch deploy | Out-Null }
            Write-InstallerOk 'WebSearch configured and validated'
        }
    } else { Write-InstallerSkip 'WebSearch setup not requested' }
} finally {
    $env:NNA_HOME = $PriorNnaHome
}

Write-InstallerSection 'Telegram gateway'
Remove-LegacyGatewayTask
$PriorNnaHome = $env:NNA_HOME
$env:NNA_HOME = $DataRoot
try {
    $GatewayStatus = & $NodePath (Join-Path $Target 'src\cli.js') gateway status | ConvertFrom-Json
    $ConfigureGateway = $false
    if ($GatewayStatus.configured -and $GatewayStatus.authorized_user_ids.Count -gt 0) {
        Write-InstallerSkip "Telegram gateway already configured for $($GatewayStatus.authorized_user_ids.Count) authorized operator(s)."
    } elseif ($TelegramBotToken -or $TelegramUserId) {
        if (-not $TelegramBotToken -or -not $TelegramUserId) { throw 'TelegramBotToken and TelegramUserId must be supplied together.' }
        $ConfigureGateway = $true
    } elseif (-not $SkipGatewaySetup -and -not [Console]::IsInputRedirected) {
        $Answer = Read-Host 'Configure the Telegram gateway now? [y/N]'
        if ($Answer -match '^(?i:y|yes)$') {
            $SecureToken = Read-Host 'Telegram bot token from BotFather' -AsSecureString
            $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
            try { $TelegramBotToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
            $TelegramUserId = Read-Host 'Numeric Telegram user ID to authorize'
            $ConfigureGateway = $true
        }
    }
    if ($ConfigureGateway) {
        Write-InstallerStep 'Saving the bot token in restricted local configuration'
        $TelegramBotToken | & $NodePath (Join-Path $Target 'src\cli.js') gateway token-stdin | Out-Null
        & $NodePath (Join-Path $Target 'src\cli.js') gateway authorize $TelegramUserId | Out-Null
        $GatewayWorkspace = Join-Path $DataRoot 'gateway\workspace'
        New-Item -ItemType Directory -Force -Path $GatewayWorkspace | Out-Null
        & $NodePath (Join-Path $Target 'src\cli.js') gateway workspace $GatewayWorkspace | Out-Null
        & $NodePath (Join-Path $Target 'src\cli.js') gateway enable | Out-Null
        & $NodePath (Join-Path $Target 'src\cli.js') gateway test | Out-Null
        Write-InstallerOk 'Telegram bot validated and operator authorized'
        $StartGateway = $true
    }
    if ($StartGateway) {
        & $NodePath (Join-Path $Target 'src\cli.js') gateway start | Out-Null
        $StartupRoot = [Environment]::GetFolderPath('Startup')
        $StartupPath = Join-Path $StartupRoot 'NotNativeAgent-Telegram.vbs'
        $GatewayCommand = '"{0}" "{1}" gateway start' -f $NodePath, (Join-Path $Target 'src\cli.js')
        $VbsCommand = $GatewayCommand.Replace('"', '""')
        $Vbs = "CreateObject(`"WScript.Shell`").Run `"$VbsCommand`", 0, False`r`n"
        [IO.File]::WriteAllText($StartupPath, $Vbs, [Text.ASCIIEncoding]::new())
        Write-InstallerOk 'Telegram gateway started and registered for user login'
    } elseif (-not $GatewayStatus.configured) {
        Write-InstallerSkip 'Telegram gateway setup not requested'
    }
} finally {
    $env:NNA_HOME = $PriorNnaHome
    $TelegramBotToken = $null
}

if (-not $SkipPathUpdate) {
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $Entries = @($UserPath -split ';' | Where-Object { $_ })
    if (-not ($Entries | Where-Object { $_.TrimEnd('\') -ieq $BinRoot.TrimEnd('\') })) {
        $Updated = (@($Entries) + $BinRoot) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $Updated, 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $BinRoot.TrimEnd('\') })) {
        $env:Path = "$env:Path;$BinRoot"
    }
    Write-InstallerOk 'User PATH contains the NNA launcher directory'
} else {
    Write-InstallerSkip 'PATH update skipped by request'
}

Write-InstallerSection 'Verification'
Write-InstallerStep 'Launching the installed CLI and checking its canonical version'
$InstalledVersion = (& $NodePath (Join-Path $Target 'src\cli.js') --version | Out-String).Trim()
if ($InstalledVersion -notmatch [Regex]::Escape($Version)) { throw 'Installed CLI version verification failed.' }
Write-InstallerOk $InstalledVersion

Write-Output ''
Write-InstallerLine ' INSTALL COMPLETE' Magenta
Write-InstallerLine " Version     $Version" White
Write-InstallerLine " Application $Target" DarkGray
Write-InstallerLine " User data   $DataRoot" DarkGray
Write-InstallerLine ' Next step   Open a new terminal and run: nna' Cyan
