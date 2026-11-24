$g_strRuntimeDir = 'staging/local-auth'

function Assert-LocalAuthPath([string]$strRelativePath) {
    $strItemPath = '.'
    foreach ($strPart in ($strRelativePath -split '[/\\]')) {
        $strItemPath = Join-Path $strItemPath $strPart
        $oItem = Get-Item -LiteralPath $strItemPath -Force -ErrorAction SilentlyContinue
        if ($oItem -and (($oItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $oItem.LinkType -eq 'HardLink')) {
            throw "A workspace path is a link: $strRelativePath."
        }
    }
}

function _SetLocalAuthAcl([string]$strRelativePath, [System.Security.AccessControl.InheritanceFlags]$eInheritance) {
    $oItem = Get-Item -LiteralPath $strRelativePath -Force
    $eSections = [System.Security.AccessControl.AccessControlSections]'Access, Owner'
    $bDesktop = $PSVersionTable.PSEdition -eq 'Desktop'
    $oAcl = if ($bDesktop) {
        $oItem.GetAccessControl($eSections)
    } else {
        [IO.FileSystemAclExtensions]::GetAccessControl($oItem, $eSections)
    }
    $oAcl.SetAccessRuleProtection($true, $false)
    foreach ($oAccessRule in @($oAcl.Access)) {
        $oAcl.RemoveAccessRuleSpecific($oAccessRule)
    }
    $oUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $oSystem = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $oOwner = $oAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($oOwner -ne $oUser -and $oOwner -ne $oSystem) {
        $oAcl.SetOwner($oUser)
    }
    foreach ($oIdentity in @($oUser, $oSystem)) {
        $oRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $oIdentity,
            'FullControl',
            $eInheritance,
            'None',
            'Allow'
        )
        $oAcl.AddAccessRule($oRule)
    }
    if ($bDesktop) {
        $oItem.SetAccessControl($oAcl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl($oItem, $oAcl)
    }
}

function Protect-LocalAuthData {
    $strDataDir = "$g_strRuntimeDir/data"
    Assert-LocalAuthPath $strDataDir
    New-Item -ItemType Directory -Path $strDataDir -Force | Out-Null
    _SetLocalAuthAcl $strDataDir 'ContainerInherit, ObjectInherit'
    foreach ($strSuffix in @('', '-journal', '-wal', '-shm')) {
        $strDbFile = "$strDataDir/account-actual.db$strSuffix"
        Assert-LocalAuthPath $strDbFile
        if (Test-Path -LiteralPath $strDbFile -PathType Leaf) {
            _SetLocalAuthAcl $strDbFile 'None'
        }
    }
}

function Enter-LocalAuthLock {
    Assert-LocalAuthPath "$g_strRuntimeDir/service.lock"
    New-Item -ItemType Directory -Path $g_strRuntimeDir -Force | Out-Null
    _SetLocalAuthAcl $g_strRuntimeDir 'ContainerInherit, ObjectInherit'
    $strLock = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath("$g_strRuntimeDir/service.lock")
    try {
        [IO.File]::Open($strLock, 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
        throw 'Another local service command is running, or the runtime lock is unavailable.'
    }
}

function Get-LocalAuthProcess([ValidateSet('node', 'nginx')][string]$strName) {
    $strRecordPath = "$g_strRuntimeDir/$strName.json"
    Assert-LocalAuthPath $strRecordPath
    if (Test-Path -LiteralPath $strRecordPath) {
        $oRecord = Get-Content -LiteralPath $strRecordPath -Raw | ConvertFrom-Json
        $oProcess = Get-Process -Id $oRecord.id -ErrorAction SilentlyContinue
        if ($oProcess -and $oProcess.ProcessName -eq $strName -and
            $oProcess.StartTime.ToFileTimeUtc().ToString() -eq $oRecord.started) {
            $oProcess
        }
    }
}

function Save-LocalAuthProcess([ValidateSet('node', 'nginx')][string]$strName, [Diagnostics.Process]$oProcess) {
    $strRecordPath = "$g_strRuntimeDir/$strName.json"
    Assert-LocalAuthPath $strRecordPath
    @{ id = $oProcess.Id; started = $oProcess.StartTime.ToFileTimeUtc().ToString() } |
        ConvertTo-Json -Compress |
        Set-Content -LiteralPath $strRecordPath -Encoding Ascii
}

function Clear-LocalAuthProcess([ValidateSet('node', 'nginx')][string]$strName) {
    $strRecordPath = "$g_strRuntimeDir/$strName.json"
    Assert-LocalAuthPath $strRecordPath
    if (Test-Path -LiteralPath $strRecordPath) {
        Remove-Item -LiteralPath $strRecordPath
    }
}

Export-ModuleMember -Function Assert-LocalAuthPath, Protect-LocalAuthData, Enter-LocalAuthLock, Get-LocalAuthProcess, Save-LocalAuthProcess, Clear-LocalAuthProcess
