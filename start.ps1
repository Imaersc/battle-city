param([string]$Username)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
$oLock = $null
$oBackend = $null
$oProxy = $null

function Initialize-LocalAccount {
    Protect-LocalAuthData
    & node.exe --disable-warning=ExperimentalWarning deploy/local-auth/server.mjs status
    if ($LASTEXITCODE -notin 0, 3) {
        throw 'Could not check the local account database.'
    }
    if ($LASTEXITCODE -eq 3) {
        if (-not $Username -and [Console]::IsInputRedirected) {
            throw 'Pass -Username to initialize an account when using redirected input.'
        }
        $strUsername = $Username
        if (-not $strUsername) {
            $strUsername = Read-Host 'Test account username'
        }

        if ([Console]::IsInputRedirected) {
            $strPassword = [Console]::In.ReadToEnd().TrimEnd([char[]]"`r`n")
        } else {
            $oSecure = Read-Host 'Test account password' -AsSecureString
            $strPassword = ([pscredential]::new($strUsername, $oSecure)).GetNetworkCredential().Password
        }
        $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        try {
            $strPassword | & node.exe deploy/local-auth/server.mjs init $strUsername
            if ($LASTEXITCODE -ne 0) {
                throw 'Account initialization failed.'
            }
        } finally {
            $strPassword = $null
        }
    }
}

function Wait-LocalAuthBackend([Diagnostics.Process]$oProcess) {
    $oTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($oTimer.ElapsedMilliseconds -lt 8000 -and -not $oProcess.HasExited) {
        $oListener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 8788 -OwningProcess $oProcess.Id -ErrorAction SilentlyContinue
        if ($oListener) {
            return
        }
        Start-Sleep -Milliseconds 125
    }
    throw 'Authentication did not start. Check the local account and Node.js version.'
}

function Wait-LocalAuthProxy([Diagnostics.Process]$oProcess) {
    for ($nAttempt = 0; $nAttempt -lt 40 -and -not $oProcess.HasExited; $nAttempt++) {
        $nPid = 0
        if ((Test-Path -LiteralPath 'staging/local-auth/nginx.pid') -and
            [int]::TryParse((Get-Content -LiteralPath 'staging/local-auth/nginx.pid' -Raw), [ref]$nPid) -and
            $nPid -eq $oProcess.Id) {
            return
        }
        Start-Sleep -Milliseconds 125
    }
    throw 'Nginx did not start. Check the Nginx configuration and port 8081.'
}

function Assert-LocalGameBuild {
    Assert-LocalAuthPath 'dist'
    if (-not (Test-Path -LiteralPath 'dist/index.html' -PathType Leaf)) {
        throw 'Run pnpm.cmd build before starting the service.'
    }

    $oPending = [Collections.Generic.Stack[string]]::new()
    $oPending.Push('dist')
    while ($oPending.Count -gt 0) {
        $strDirectory = $oPending.Pop()
        foreach ($oEntry in (Get-ChildItem -LiteralPath $strDirectory -Force)) {
            if (($oEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $oEntry.LinkType -eq 'HardLink') {
                throw 'The game build contains a linked file or directory. Rebuild dist locally.'
            }
            if ($oEntry.PSIsContainer) {
                $oPending.Push((Join-Path $strDirectory $oEntry.Name))
            }
        }
    }
}

try {
    Import-Module ./deploy/local-auth/runtime.psm1
    $oLock = Enter-LocalAuthLock
    $bBackendRunning = $null -ne (Get-LocalAuthProcess 'node')
    $bProxyRunning = $null -ne (Get-LocalAuthProcess 'nginx')
    if ($bBackendRunning -and $bProxyRunning) {
        Write-Output 'Already running at http://127.0.0.1:8081/.'
    } else {
        if ($bBackendRunning -or $bProxyRunning) {
            throw 'Only one local service is running. Run stop.ps1 before starting both.'
        }
        $oListeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -in 8081, 8788 }
        if ($oListeners) {
            throw 'Port 8081 or 8788 is already in use.'
        }

        Get-Command node.exe, nginx.exe -ErrorAction Stop | Out-Null
        Assert-LocalGameBuild
        Assert-LocalAuthPath 'staging/local-auth/nginx.pid'
        foreach ($strTemp in @('client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi')) {
            Assert-LocalAuthPath "staging/local-auth/$strTemp"
        }
        $arrNginx = @('-e', 'stderr', '-p', './', '-c', 'deploy/local-auth/nginx.conf')
        $oConfigCheck = Start-Process -FilePath nginx.exe -ArgumentList ($arrNginx + '-t' + '-q') -WorkingDirectory '.' -WindowStyle Hidden -PassThru -Wait
        if ($oConfigCheck.ExitCode -ne 0) {
            throw 'Nginx configuration test failed.'
        }

        Initialize-LocalAccount
        $oBackend = Start-Process -FilePath node.exe -ArgumentList 'deploy/local-auth/server.mjs serve' -WorkingDirectory '.' -WindowStyle Hidden -PassThru
        Save-LocalAuthProcess 'node' $oBackend
        Wait-LocalAuthBackend $oBackend
        $oProxy = Start-Process -FilePath nginx.exe -ArgumentList $arrNginx -WorkingDirectory '.' -WindowStyle Hidden -PassThru
        Save-LocalAuthProcess 'nginx' $oProxy
        Wait-LocalAuthProxy $oProxy
        Write-Output 'Open http://127.0.0.1:8081/ in your browser.'
    }
} catch {
    if ($oProxy) {
        if (-not $oProxy.HasExited) {
            $nPid = 0
            if ((Test-Path -LiteralPath 'staging/local-auth/nginx.pid') -and
                [int]::TryParse((Get-Content -LiteralPath 'staging/local-auth/nginx.pid' -Raw), [ref]$nPid) -and
                $nPid -eq $oProxy.Id) {
                & nginx.exe @arrNginx -s quit
            }
            if (-not $oProxy.WaitForExit(5000)) {
                $oProxy.Kill()
            }
            $oProxy.WaitForExit()
        }
        Clear-LocalAuthProcess 'nginx'
    }
    if ($oBackend) {
        if (-not $oBackend.HasExited) {
            $oBackend.Kill()
            $oBackend.WaitForExit()
        }
        Clear-LocalAuthProcess 'node'
    }
    throw
} finally {
    if ($oLock) {
        $oLock.Dispose()
    }
    Pop-Location
}
