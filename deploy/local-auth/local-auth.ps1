param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Initialize', 'StartProxy', 'StopProxy')]
    [string]$Action,
    [string]$Username
)

$ErrorActionPreference = 'Stop'
$strProject = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path.Replace('\', '/')

function Initialize-LocalAccount {
    if (-not $Username -or -not $env:LOCALAPPDATA) {
        throw 'A username and LOCALAPPDATA are required.'
    }

    $strDataDir = Join-Path $env:LOCALAPPDATA 'BattleCity/Auth'
    New-Item -ItemType Directory -Path $strDataDir -Force | Out-Null
    $oAcl = Get-Acl -LiteralPath $strDataDir
    $oAcl.SetAccessRuleProtection($true, $false)
    foreach ($oAccessRule in @($oAcl.Access)) {
        $oAcl.RemoveAccessRuleSpecific($oAccessRule)
    }
    $oUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $oSystem = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    foreach ($oIdentity in @($oUser, $oSystem)) {
        $oRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $oIdentity,
            'FullControl',
            'ContainerInherit, ObjectInherit',
            'None',
            'Allow'
        )
        $oAcl.AddAccessRule($oRule)
    }
    Set-Acl -LiteralPath $strDataDir -AclObject $oAcl

    if ([Console]::IsInputRedirected) {
        $strPassword = [Console]::In.ReadToEnd().TrimEnd([char[]]"`r`n")
    } else {
        $oSecure = Read-Host 'Test account password' -AsSecureString
        $strPassword = ([pscredential]::new($Username, $oSecure)).GetNetworkCredential().Password
    }
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    try {
        $strPassword | & node (Join-Path $PSScriptRoot 'server.mjs') init $Username
        if ($LASTEXITCODE -ne 0) {
            throw 'Account initialization failed.'
        }
    } finally {
        $strPassword = $null
    }
}

if ($Action -eq 'Initialize') {
    Initialize-LocalAccount
    exit 0
}

$oNginx = Get-Command nginx.exe -ErrorAction Stop
$strLogDir = Join-Path $strProject 'staging/local-auth'
$strPidPath = Join-Path $strLogDir 'nginx.pid'
$arrOptions = @('-e', 'stderr', '-p', "$strProject/", '-c', 'deploy/local-auth/nginx.conf')
if ($Action -eq 'StopProxy') {
    if (Test-Path -LiteralPath $strPidPath) {
        & $oNginx.Source @arrOptions -s quit
        exit $LASTEXITCODE
    }
    exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $strProject 'dist/index.html'))) {
    throw 'Run pnpm.cmd build before starting the proxy.'
}

New-Item -ItemType Directory -Path $strLogDir -Force | Out-Null
& $oNginx.Source @arrOptions -t
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$strArguments = '-e stderr -p "{0}/" -c deploy/local-auth/nginx.conf' -f $strProject
$oProcess = Start-Process -FilePath $oNginx.Source -ArgumentList $strArguments -WorkingDirectory $strProject -WindowStyle Hidden -PassThru
for ($nAttempt = 0; $nAttempt -lt 50; $nAttempt++) {
    if ($oProcess.HasExited) {
        throw "Nginx exited. See $strLogDir/error.log."
    }
    if (Test-Path -LiteralPath $strPidPath) {
        $nStarted = 0
        if ([int]::TryParse((Get-Content -LiteralPath $strPidPath -Raw), [ref]$nStarted) -and $nStarted -eq $oProcess.Id) {
            Write-Output 'Open http://127.0.0.1:8081/ in your browser.'
            exit 0
        }
    }
    Start-Sleep -Milliseconds 100
}

throw "Nginx did not start in time. See $strLogDir/error.log."
