$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
$oLock = $null

try {
    Import-Module ./deploy/local-auth/runtime.psm1
    Assert-LocalAuthPath 'staging/local-auth'
    if (Test-Path -LiteralPath 'staging/local-auth') {
        $oLock = Enter-LocalAuthLock
        $oProxy = Get-LocalAuthProcess 'nginx'
        $oBackend = Get-LocalAuthProcess 'node'
        if ($oProxy) {
            $strPidPath = 'staging/local-auth/nginx.pid'
            Assert-LocalAuthPath $strPidPath
            $nPid = 0
            if (-not (Test-Path -LiteralPath $strPidPath) -or
                -not [int]::TryParse((Get-Content -LiteralPath $strPidPath -Raw), [ref]$nPid) -or
                $nPid -ne $oProxy.Id) {
                throw 'The Nginx PID file does not match this workspace service.'
            }
            & nginx.exe -e stderr -p ./ -c deploy/local-auth/nginx.conf -s quit
            if ($LASTEXITCODE -ne 0 -or -not $oProxy.WaitForExit(10000)) {
                throw 'Nginx did not stop. Try stop.ps1 again after requests finish.'
            }
        }
        Clear-LocalAuthProcess 'nginx'

        if ($oBackend) {
            $oBackend.Kill()
            if (-not $oBackend.WaitForExit(5000)) {
                throw 'Authentication did not stop.'
            }
        }
        Clear-LocalAuthProcess 'node'
    }
    Write-Output 'Local services stopped.'
} finally {
    if ($oLock) {
        $oLock.Dispose()
    }
    Pop-Location
}
