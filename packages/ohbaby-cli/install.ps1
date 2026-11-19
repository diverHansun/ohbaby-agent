# Run in a child scope so Invoke-Expression leaves the caller's preferences alone.
& {
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $nodeVersion = '24.22.3'
    $versionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z'
    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    $newline = [Environment]::NewLine

    function Get-PathAttributes([string]$Path) {
        try { [IO.File]::GetAttributes($Path) }
        catch [IO.FileNotFoundException] { $null }
        catch [IO.DirectoryNotFoundException] { $null }
    }

    function Read-TextIfPresent([string]$Path) {
        try { [IO.File]::ReadAllText($Path) }
        catch [IO.FileNotFoundException] { $null }
        catch [IO.DirectoryNotFoundException] { $null }
    }

    function Read-VersionPointer([string]$Path, [string]$Pattern = $versionPattern) {
        $value = Read-TextIfPresent $Path
        if ($null -eq $value) { return $null }
        $value = $value.TrimEnd([char]13, [char]10)
        if ($value -cnotmatch $Pattern) { throw "Invalid version in $Path." }
        return $value
    }

    function Write-AtomicText([string]$Path, [string]$Value) {
        $temp = "$Path.tmp"
        try {
            [IO.File]::WriteAllText($temp, $Value, $utf8NoBom)
            if ($null -eq (Get-PathAttributes $Path)) {
                [IO.File]::Move($temp, $Path)
            } else {
                [IO.File]::Replace($temp, $Path, [NullString]::Value)
            }
        } finally {
            [IO.File]::Delete($temp)
        }
    }

    function Test-ProcessPresent([int]$ProcessId) {
        try {
            Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
            return $true
        } catch {
            if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { return $false }
            throw
        }
    }

    function Test-JsonNumber($Value) {
        return ($Value -is [int] -or $Value -is [long] -or $Value -is [double])
    }

    function Assert-DaemonStopped([string]$ConfigHome) {
        $serverDir = Join-Path $ConfigHome 'server'
        foreach ($name in 'daemon.pid', 'daemon-state.json') {
            $path = Join-Path $serverDir $name
            try {
                $text = Read-TextIfPresent $path
                if ($null -eq $text) { continue }
                $record = ConvertFrom-Json -InputObject $text
                if ($name -eq 'daemon.pid') {
                    if ($record.pid -isnot [int] -or $record.pid -le 0 -or
                        $record.token -isnot [string] -or [string]::IsNullOrWhiteSpace($record.token) -or
                        -not (Test-JsonNumber $record.startedAt)) {
                        throw 'Invalid daemon PID record.'
                    }
                } else {
                    if ($record.status -cnotin @('running', 'stopping', 'stopped', 'crashed') -or
                        -not (Test-JsonNumber $record.updatedAt)) {
                        throw 'Invalid daemon state record.'
                    }
                    if ($record.status -ceq 'running' -and
                        ($record.host -isnot [string] -or -not $record.host -or
                         $record.port -isnot [int] -or $record.port -lt 1 -or $record.port -gt 65535 -or
                         $record.authToken -isnot [string] -or -not $record.authToken)) {
                        throw 'Incomplete running daemon state.'
                    }
                    if ($null -eq $record.pid -and $record.status -cin @('stopped', 'crashed')) { continue }
                    if ($record.pid -isnot [int] -or $record.pid -le 0) { throw 'Invalid daemon PID.' }
                }
                $running = Test-ProcessPresent $record.pid
            } catch {
                throw "Cannot verify daemon status at '$path'. $($_.Exception.Message)"
            }
            if ($running) {
                throw "Daemon PID $($record.pid) is still present (record: '$path'). Make sure it is idle, run 'ohbaby serve stop', then retry."
            }
        }
    }

    function Remove-TreeIfPresent([string]$Path) {
        $attributes = Get-PathAttributes $Path
        if ($null -ne $attributes) {
            # Never recurse through a junction at the root of a staging or cleanup directory.
            [IO.Directory]::Delete($Path, -not ($attributes -band [IO.FileAttributes]::ReparsePoint))
        }
    }

    function Try-NewInstallLock([string]$Path) {
        # Directory.CreateDirectory also succeeds for an existing directory.
        # Moving a prepared directory publishes both the lock and its PID exclusively.
        $candidate = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
        [void][IO.Directory]::CreateDirectory($candidate)
        try {
            [IO.File]::WriteAllText((Join-Path $candidate 'pid'), "$PID$newline", $utf8NoBom)
            try {
                [IO.Directory]::Move($candidate, $Path)
                return $true
            } catch [IO.IOException] {
                if ($null -ne (Get-PathAttributes $Path)) { return $false }
                throw
            }
        } finally {
            Remove-TreeIfPresent $candidate
        }
    }

    function Assert-InstallLockExpired([string]$Path) {
        $attributes = Get-PathAttributes $Path
        if ($null -eq $attributes) { return }
        if (-not ($attributes -band [IO.FileAttributes]::Directory) -or
            ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Unrecognized install lock at '$Path'. Check that no installation is running before removing it."
        }
        try {
            $text = [IO.File]::ReadAllText((Join-Path $Path 'pid')).TrimEnd([char]13, [char]10)
            $owner = 0
            if ($text -cnotmatch '^[1-9][0-9]*\z' -or -not [int]::TryParse($text, [ref]$owner)) {
                throw 'Invalid install lock PID.'
            }
            $running = Test-ProcessPresent $owner
        } catch {
            throw "Cannot verify the owner of '$Path'. Check that no installation is running before removing it. $($_.Exception.Message)"
        }
        if ($running) { throw "An install or uninstall is already running (PID $owner, lock '$Path')." }
    }

    function Enter-InstallLock([string]$Path) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
        $reclaim = "$Path.reclaim"
        $reclaimHint = "Install lock recovery is in progress or left a lock at '$reclaim'. Remove it only after confirming no install or uninstall is running."
        if ($null -ne (Get-PathAttributes $reclaim)) { throw $reclaimHint }
        if (Try-NewInstallLock $Path) { return }

        Assert-InstallLockExpired $Path
        if (-not (Try-NewInstallLock $reclaim)) { throw $reclaimHint }
        try {
            Assert-InstallLockExpired $Path
            Remove-TreeIfPresent $Path
            if (-not (Try-NewInstallLock $Path)) { throw "Another installer acquired '$Path'. Try again later." }
        } finally {
            try { Remove-TreeIfPresent $reclaim }
            catch { Write-Warning "Unable to clear recovery lock '$reclaim'. $($_.Exception.Message)" }
        }
    }

    function Get-NodeDownload([string]$Url, [string]$Destination) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
        } catch {
            throw "Could not download '$Url'. Check your proxy settings or set OHBABY_NODE_MIRROR. $($_.Exception.Message)"
        }
    }

    function Test-ExecutableVersion([string]$Executable, [string]$Expected, [string]$Program) {
        if (-not [IO.File]::Exists($Executable)) { return $false }
        $ErrorActionPreference = 'Continue'
        if ($Program) { $output = & $Executable $Program --version 2>$null }
        else { $output = & $Executable --version 2>$null }
        return ($LASTEXITCODE -eq 0 -and ($output -join $newline).Trim() -ceq $Expected)
    }

    function Resolve-InstallVersion([string]$Node, [string]$Npm, [string]$Requested) {
        $ErrorActionPreference = 'Continue'
        $versions = & $Node $Npm view "ohbaby-cli@$Requested" version --json=false --color=false
        $version = ($versions -join $newline).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -cnotmatch $versionPattern -or
            ($Requested -cne 'latest' -and $Requested -cne $version)) {
            throw "Could not resolve ohbaby-cli@$Requested in the configured npm registry. If you use a mirror, it may not have synced yet. Try again later."
        }
        return $version
    }

    function Initialize-Node([string]$RuntimeDir, [string]$Architecture, [string]$Mirror) {
        $destination = Join-Path $RuntimeDir "node-v$nodeVersion"
        if ($null -ne (Get-PathAttributes $destination)) {
            if (-not (Test-ExecutableVersion (Join-Path $destination 'node.exe') "v$nodeVersion")) {
                throw "Existing Node.js runtime at '$destination' failed its version check."
            }
            return $destination
        }

        $partial = Join-Path $RuntimeDir ".node-v$nodeVersion.partial"
        Remove-TreeIfPresent $partial
        [void][IO.Directory]::CreateDirectory($partial)
        $name = "node-v$nodeVersion-win-$Architecture"
        $archive = "$name.zip"
        $zipPath = Join-Path $partial $archive
        $checksums = Join-Path $partial 'SHASUMS256.txt'
        $from = "$($Mirror.TrimEnd('/'))/v$nodeVersion"
        Get-NodeDownload "$from/$archive" $zipPath
        Get-NodeDownload "$from/SHASUMS256.txt" $checksums
        $pattern = '^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($archive) + '\z'
        $expectedHash = @([IO.File]::ReadLines($checksums) | ForEach-Object {
            if ($_ -match $pattern) { $Matches[1] }
        })
        if ($expectedHash.Count -ne 1 -or (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -ine $expectedHash[0]) {
            throw "SHA-256 verification failed for '$archive'."
        }

        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        if ([IO.File]::Exists($tar)) {
            & $tar -xf $zipPath -C $partial
            if ($LASTEXITCODE -ne 0) { throw "Could not extract '$zipPath' (tar exit code $LASTEXITCODE)." }
        } else {
            Expand-Archive -LiteralPath $zipPath -DestinationPath $partial
        }
        $extracted = Join-Path $partial $name
        if (-not (Test-ExecutableVersion (Join-Path $extracted 'node.exe') "v$nodeVersion")) {
            throw "The downloaded Node.js runtime failed its version check."
        }
        [IO.Directory]::Move($extracted, $destination)
        try { Remove-TreeIfPresent $partial }
        catch { Write-Warning "Could not remove temporary directory '$partial'. $($_.Exception.Message)" }
        return $destination
    }

    function Install-Release([string]$ReleaseDir, [string]$RuntimeDir, [string]$Node, [string]$Npm, [string]$Version) {
        $bin = 'node_modules\ohbaby-cli\dist\bin.js'
        $nodePattern = '^[0-9]+\.[0-9]+\.[0-9]+\z'
        if ($null -ne (Get-PathAttributes $ReleaseDir)) {
            $releaseNode = Read-VersionPointer (Join-Path $ReleaseDir 'node-version') $nodePattern
            if ($releaseNode -and
                (Test-ExecutableVersion (Join-Path $RuntimeDir "node-v$releaseNode\node.exe") $Version (Join-Path $ReleaseDir $bin))) {
                return
            }
            throw "Existing release at '$ReleaseDir' failed its version check. Keep any working release and remove the broken release before retrying."
        }

        $partial = "$ReleaseDir.partial"
        Remove-TreeIfPresent $partial
        [void][IO.Directory]::CreateDirectory($partial)
        & {
            $ErrorActionPreference = 'Continue'
            & $Node $Npm install --global=false --prefix $partial --ignore-scripts --omit=dev --include=optional --no-audit --no-fund "ohbaby-cli@$Version"
            if ($LASTEXITCODE -ne 0) { throw "npm could not install ohbaby-cli@$Version (exit code $LASTEXITCODE)." }
        }
        [IO.File]::WriteAllText((Join-Path $partial 'node-version'), "$nodeVersion$newline", $utf8NoBom)
        if (-not (Test-ExecutableVersion $Node $Version (Join-Path $partial $bin))) {
            throw "ohbaby-cli@$Version failed its version check."
        }
        [IO.Directory]::Move($partial, $ReleaseDir)
    }

    function Install-Launcher([string]$BinDir) {
        $launcher = Join-Path $BinDir 'ohbaby.cmd'
        $existing = Read-TextIfPresent $launcher
        if ($null -ne $existing) {
            $lines = $existing -split '\r?\n', 3
            if ($lines.Count -gt 1 -and $lines[1] -ceq 'rem ohbaby-launcher 1') { return }
        }
        $body = @'
@echo off
rem ohbaby-launcher 1
setlocal
for %%I in ("%~dp0..") do set "OHBABY_INSTALL_DIR=%%~fI"
set /p V=<"%OHBABY_INSTALL_DIR%\current"
set "R=%OHBABY_INSTALL_DIR%\releases\%V%"
set /p N=<"%R%\node-version"
set "D=%OHBABY_INSTALL_DIR%\runtime\node-v%N%"
set "PATH=%PATH%;%D%"
"%D%\node.exe" "%R%\node_modules\ohbaby-cli\dist\bin.js" %* & call exit /b %%errorlevel%%
'@
        [void][IO.Directory]::CreateDirectory($BinDir)
        Write-AtomicText $launcher ((($body -split '\r?\n') -join $newline) + $newline)
    }

    function Send-EnvironmentChange {
        try {
            $typeName = 'OhbabyInstaller.NativeEnvironmentBroadcast'
            if (-not ([System.Management.Automation.PSTypeName]$typeName).Type) {
                Add-Type -Namespace 'OhbabyInstaller' -Name 'NativeEnvironmentBroadcast' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hwnd, uint msg, System.IntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@
            }
            $result = [UIntPtr]::Zero
            [void][OhbabyInstaller.NativeEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)
        } catch {
            Write-Warning "Could not notify other Windows processes of the PATH change. Open a new terminal to refresh PATH."
        }
    }

    function Add-PathEntryFirst([string]$PathValue, [string]$Entry) {
        if (-not $PathValue) { return $Entry }
        $rest = @($PathValue.Split(';') | Where-Object {
            $expanded = [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"'))
            $expanded.Replace('/', '\').TrimEnd('\') -ine $Entry.TrimEnd('\')
        })
        return (@($Entry) + $rest) -join ';'
    }

    function Add-InstallPath([string]$BinDir) {
        if ($BinDir.Contains(';')) { throw "Cannot add '$BinDir' to PATH because it contains a semicolon. Set OHBABY_NO_MODIFY_PATH=1 to skip this step." }
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
        try {
            $rawPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $newPath = Add-PathEntryFirst $rawPath $BinDir
            if ($newPath -cne $rawPath -or $key.GetValueKind('Path') -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
                $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                Send-EnvironmentChange
            }
        } finally {
            $key.Dispose()
        }
        $env:Path = Add-PathEntryFirst $env:Path $BinDir
    }

    function Clear-OldDirectories([string]$Root, [string]$Pattern, [string[]]$Keep) {
        foreach ($path in [IO.Directory]::GetDirectories($Root)) {
            $name = [IO.Path]::GetFileName($path)
            $trash = $path
            try {
                if ($name -cnotlike '.trash-*') {
                    if ($name -cnotmatch $Pattern -or $Keep -contains $name) { continue }
                    $trash = Join-Path $Root ".trash-$name-$PID"
                    Remove-TreeIfPresent $trash
                    [IO.Directory]::Move($path, $trash)
                }
                Remove-TreeIfPresent $trash
            } catch {
                Write-Warning "Could not clean up '$path'. A later update can retry. $($_.Exception.Message)"
            }
        }
    }

    function Clear-OldReleases([string]$Releases, [string]$Runtime, [string]$Version, [string]$Previous) {
        $keep = @($Version)
        if ($Previous) { $keep += $Previous }
        Clear-OldDirectories $Releases $versionPattern $keep
        $nodes = foreach ($release in $keep) {
            try {
                $record = Read-VersionPointer (Join-Path $Releases "$release\node-version") '^[0-9]+\.[0-9]+\.[0-9]+\z'
            } catch {
                Write-Warning "Could not read which Node.js runtime release '$release' uses. Skipping runtime cleanup."
                return
            }
            if ($record) { "node-v$record" }
        }
        Clear-OldDirectories $Runtime '^node-v[0-9]+\.[0-9]+\.[0-9]+\z' @($nodes)
    }

    function Find-NpmOhbabyPrefix {
        foreach ($command in Get-Command ohbaby -All -CommandType Application,ExternalScript -ErrorAction SilentlyContinue) {
            $prefix = [IO.Path]::GetDirectoryName($command.Path)
            $shim = Read-TextIfPresent (Join-Path $prefix 'ohbaby.cmd')
            if ($shim -match '(?m)^:find_dp0\r?$' -and
                $shim -match '(?i)%dp0%\\node_modules\\ohbaby-cli\\dist\\bin\.js"') {
                return $prefix
            }
        }
    }

    function Remove-OldNpmInstall([string]$Prefix, [string]$ConfigHome, [string]$Node, [string]$Npm) {
        if (-not $Prefix) { return }
        $answer = if ($env:OHBABY_NON_INTERACTIVE -ne '1' -and [Environment]::UserInteractive) {
            Read-Host "Uninstall the npm copy at '$Prefix'? [y/N]"
        }
        if ($answer -in @('y', 'yes')) {
            Assert-DaemonStopped $ConfigHome
            $shim = Join-Path $Prefix 'npm.cmd'
            if (-not [IO.File]::Exists($shim)) {
                $shim = (Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Path
            }
            if ($shim) {
                # Invoke npm through Node, keeping custom prefixes out of cmd.exe parsing.
                $npmDir = [IO.Path]::GetDirectoryName($shim)
                $localNpm = Join-Path $npmDir 'node_modules\npm\bin\npm-cli.js'
                $localNode = Join-Path $npmDir 'node.exe'
                if ([IO.File]::Exists($localNpm) -and [IO.File]::Exists($localNode)) {
                    $Npm = $localNpm
                    $Node = $localNode
                }
            }
            & {
                $ErrorActionPreference = 'Continue'
                & $Node $Npm uninstall -g --prefix $Prefix ohbaby-cli
                if ($LASTEXITCODE -ne 0) {
                    throw "Could not uninstall the npm copy (exit code $LASTEXITCODE). Close other ohbaby windows and retry the npm uninstall command."
                }
            }
        } else {
            $first = Get-Command ohbaby -ErrorAction SilentlyContinue | Select-Object -First 1
            $message = "Kept the npm copy at '$Prefix'."
            if ($first) { $message += " In this shell, 'ohbaby' resolves to '$($first.Definition)'." }
            Write-Host $message
        }
    }

    function Invoke-OhbabyInstall {
        $architecture = $env:PROCESSOR_ARCHITEW6432
        if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
        $architecture = switch ($architecture) {
            'AMD64' { 'x64' }
            'ARM64' { 'arm64' }
            default { throw 'Unsupported Windows architecture. Install a supported Node.js version and use npm install -g ohbaby-cli.' }
        }
        $userHome = $env:USERPROFILE
        if (-not $userHome) { $userHome = $HOME }
        $configHome = $env:OHBABY_HOME
        if ([string]::IsNullOrWhiteSpace($configHome)) { $configHome = Join-Path $userHome '.ohbaby' }
        $configHome = $configHome.Trim()
        if ($configHome -notmatch '^(?:[A-Za-z]:)?[\\/]') { throw 'OHBABY_HOME must be an absolute directory path.' }
        $configHome = [IO.Path]::GetFullPath($configHome)
        $installDir = $env:OHBABY_INSTALL_DIR
        if (-not $installDir) { $installDir = Join-Path $userHome '.ohbaby\install' }
        $installDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installDir).TrimEnd('\', '/')
        if ($installDir -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or -not [IO.Path]::GetDirectoryName($installDir)) {
            throw 'OHBABY_INSTALL_DIR must name a directory inside a filesystem root.'
        }
        $installAttributes = Get-PathAttributes $installDir
        if ($null -ne $installAttributes) {
            # The uninstall command resolves the real installation path before
            # computing its sibling lock. A linked root could split those locks.
            if ($installAttributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Install directory '$installDir' is a junction or symbolic link. Set OHBABY_INSTALL_DIR to the real directory and retry."
            }
            if (-not ($installAttributes -band [IO.FileAttributes]::Directory)) {
                throw "Install path '$installDir' is not a directory."
            }
        }
        $mirror = $env:OHBABY_NODE_MIRROR
        if (-not $mirror) { $mirror = 'https://nodejs.org/dist' }
        $requested = $env:OHBABY_INSTALL_VERSION
        if (-not $requested) { $requested = 'latest' }
        if ($requested -cne 'latest' -and $requested -cnotmatch $versionPattern) {
            throw 'OHBABY_INSTALL_VERSION must be an exact version or latest.'
        }

        Assert-DaemonStopped $configHome
        $npmPrefix = Find-NpmOhbabyPrefix
        $lock = "$installDir.lock"
        Enter-InstallLock $lock
        $switched = $false
        $stage = 'prepare the installation'
        try {
            $runtime = Join-Path $installDir 'runtime'
            $releases = Join-Path $installDir 'releases'
            $current = Join-Path $installDir 'current'
            $binDir = Join-Path $installDir 'bin'
            $previous = Read-VersionPointer $current
            $privateNode = Initialize-Node $runtime $architecture $mirror
            $node = Join-Path $privateNode 'node.exe'
            $npm = Join-Path $privateNode 'node_modules\npm\bin\npm-cli.js'
            $version = Resolve-InstallVersion $node $npm $requested
            Install-Release (Join-Path $releases $version) $runtime $node $npm $version
            Install-Launcher $binDir
            if ($version -cne $previous) {
                $stage = 'switch the current version'
                Assert-DaemonStopped $configHome
                Write-AtomicText $current "$version$newline"
                $switched = $true
            }

            if ($env:OHBABY_NO_MODIFY_PATH -ne '1') {
                $stage = 'update the user PATH'
                Add-InstallPath $binDir
            }
            if ($switched) {
                $stage = 'clean up previous releases'
                Clear-OldReleases $releases $runtime $version $previous
            }
            $stage = 'handle the existing npm installation'
            Remove-OldNpmInstall $npmPrefix $configHome $node $npm
            Write-Host "Installed ohbaby $version at '$installDir'."
            if ($env:OHBABY_NO_MODIFY_PATH -eq '1') {
                Write-Host "Run '$binDir\ohbaby.cmd' or add '$binDir' to PATH."
            } else {
                Write-Host 'Reopen other terminals to pick up the PATH change.'
            }
        } catch {
            if ($switched) {
                throw "ohbaby switched to $version, but could not $stage. Rerun the installer for $version to retry. $($_.Exception.Message)"
            }
            throw
        } finally {
            try { Remove-TreeIfPresent $lock }
            catch { Write-Warning "Could not remove install lock '$lock'. $($_.Exception.Message)" }
        }
    }

    Invoke-OhbabyInstall
}
