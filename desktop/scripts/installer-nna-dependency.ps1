# SPDX-License-Identifier: Apache-2.0
# A carried NNA release is executable only after an external manifest digest
# anchors a complete, private staged copy. This helper does not download code.
function Get-NndDependencySha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Assert-NndDependencyDirectory([string]$Candidate) {
    if (![IO.Path]::IsPathRooted($Candidate) -or $Candidate.Length -gt 4096) { throw 'NNA dependency root must be absolute.' }
    $root = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    if ($root.Length -le [IO.Path]::GetPathRoot($root).Length) { throw 'NNA dependency root cannot be a filesystem root.' }
    $current = $root
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NNA dependency root contains a reparse point.' }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($parent) { $parent.FullName } else { $null }
    }
    if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'NNA dependency root must be a directory.' }
    return $root
}

function Read-NndDependencyManifest([string]$Root, [string]$ExpectedSha256) {
    if ($ExpectedSha256 -notmatch '^[a-f0-9]{64}$') { throw 'NNA dependency manifest SHA-256 is required.' }
    $ExpectedSha256 = $ExpectedSha256.ToLowerInvariant()
    $manifestPath = Join-Path $Root 'RELEASE_MANIFEST.sha256'
    $file = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $file.PSIsContainer -or $file.Length -gt 4194304) {
        throw 'NNA dependency release manifest is invalid.'
    }
    if ((Get-NndDependencySha256 $manifestPath) -cne $ExpectedSha256) {
        throw 'NNA dependency release manifest SHA-256 does not match.'
    }
    $entries = [ordered]@{}
    $lines = @(Get-Content -LiteralPath $manifestPath -Encoding UTF8)
    if ($lines.Count -lt 4 -or $lines.Count -gt 8192) { throw 'NNA dependency release manifest has an invalid size.' }
    foreach ($line in $lines) {
        if ($line -cnotmatch '^([a-f0-9]{64}) \*([A-Za-z0-9._/-]+)$') { throw 'NNA dependency release manifest has an invalid entry.' }
        $hash = $Matches[1]; $relative = $Matches[2]
        $segments = $relative.Split('/')
        if ($segments.Count -gt 32 -or @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0 -or
            $relative -eq 'RELEASE_MANIFEST.sha256' -or $entries.Contains($relative)) {
            throw 'NNA dependency release manifest has a duplicate or unsafe path.'
        }
        $entries[$relative] = $hash
    }
    foreach ($required in @('install.ps1', 'package.json', 'VERSION', 'src/cli.js')) {
        if (!$entries.Contains($required)) { throw "NNA dependency release manifest omits $required." }
    }
    return $entries
}

function Assert-NndDependencyTree([string]$Root, $Entries) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root); $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $count = 0; [long]$total = 0
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            $count++; if ($count -gt 16384) { throw 'NNA dependency tree exceeds its entry bound.' }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NNA dependency tree contains a reparse point.' }
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            $relative = $item.FullName.Substring($Root.Length + 1).Replace('\', '/')
            if (!$seen.Add($relative) -or ($relative -ne 'RELEASE_MANIFEST.sha256' -and !$Entries.Contains($relative))) {
                throw 'NNA dependency tree has an unlisted or duplicate file.'
            }
            if ($item.Length -gt 67108864) { throw 'NNA dependency file exceeds its size bound.' }
            $total += $item.Length
            if ($total -gt 536870912) { throw 'NNA dependency release exceeds its size bound.' }
        }
    }
    if ($seen.Count -ne $Entries.Count + 1) { throw 'NNA dependency release is missing a listed file.' }
}

function Assert-NndDependencyStageAncestry([string]$Candidate) {
    $current = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'NNA dependency stage or NND target contains a reparse point.'
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($parent) { $parent.FullName } else { $null }
    }
}

function Stage-NndNnaDependency([string]$Root, [string]$ManifestSha256, [string]$NndTargetRoot = '') {
    $source = Assert-NndDependencyDirectory $Root
    $entries = Read-NndDependencyManifest $source $ManifestSha256
    $ManifestSha256 = $ManifestSha256.ToLowerInvariant()
    Assert-NndDependencyTree $source $entries
    $tempRoot = [IO.Path]::GetTempPath()
    Assert-NndDependencyStageAncestry $tempRoot
    if ($NndTargetRoot) { Assert-NndDependencyStageAncestry $NndTargetRoot }
    $stage = Join-Path $tempRoot ('nnd-nna-dependency-' + [guid]::NewGuid().ToString('N'))
    $stageFull = [IO.Path]::GetFullPath($stage).TrimEnd('\', '/')
    foreach ($forbidden in @($source, $NndTargetRoot)) {
        if (!$forbidden) { continue }
        $rootFull = [IO.Path]::GetFullPath($forbidden).TrimEnd('\', '/')
        if ($stageFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
            $stageFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) {
            throw 'NNA dependency staging cannot overlap its source or the NND installation target.'
        }
    }
    [void](New-Item -ItemType Directory -Path $stage -ErrorAction Stop)
    try {
        foreach ($relative in $entries.Keys) {
            $from = Join-Path $source ($relative.Replace('/', '\'))
            $to = Join-Path $stage ($relative.Replace('/', '\'))
            [void](New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force)
            Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
            if ((Get-NndDependencySha256 $to) -cne $entries[$relative]) {
                throw "NNA dependency file failed SHA-256 verification: $relative"
            }
        }
        Copy-Item -LiteralPath (Join-Path $source 'RELEASE_MANIFEST.sha256') -Destination (Join-Path $stage 'RELEASE_MANIFEST.sha256')
        if ((Get-NndDependencySha256 (Join-Path $stage 'RELEASE_MANIFEST.sha256')) -cne $ManifestSha256) {
            throw 'Staged NNA dependency manifest changed.'
        }
        $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
        $version = (Get-Content -LiteralPath (Join-Path $stage 'VERSION') -Raw).Trim()
        if ($package.name -ne 'not-native-agent' -or $version -cnotmatch '^\d{8}-[1-9]\d*$' -or
            $package.nna_version -cne $version) { throw 'Staged NNA dependency identity is invalid.' }
        return $stage
    } catch {
        Remove-NndDependencyStage $stage
        throw
    }
}

function Remove-NndDependencyStage([string]$Stage) {
    $full = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
    $parent = [IO.Directory]::GetParent($full)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if (!$parent -or !$parent.FullName.TrimEnd('\', '/').Equals($temp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -cnotmatch '^nnd-nna-dependency-[a-f0-9]{32}$') {
        throw 'NNA dependency stage cleanup target is invalid.'
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NNA dependency stage is redirected.' }
        $pending = New-Object 'System.Collections.Generic.Stack[string]'
        $directories = New-Object 'System.Collections.Generic.List[string]'
        $pending.Push($full)
        while ($pending.Count) {
            $directory = $pending.Pop(); $directories.Add($directory)
            foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
                if (!$entry.FullName.StartsWith("$full\", [StringComparison]::OrdinalIgnoreCase) -or
                    $entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'NNA dependency stage contains an unsafe entry; it was preserved.'
                }
                if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
                else { Remove-Item -LiteralPath $entry.FullName -Force }
            }
        }
        foreach ($directory in ($directories | Sort-Object Length -Descending)) {
            [IO.Directory]::Delete($directory, $false)
        }
    }
}
