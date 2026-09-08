<#
.SYNOPSIS
    Copies the ManageEngine agent installer to a single remote Windows Server
    and runs it silently, via one of four remote-execution transports (with
    automatic fallback). Invoked by the Node.js backend once per target
    server (not run manually in normal use).

    Ported from the standalone UEMSAgentDeployer desktop tool
    (D:\Project\ManageEngineAgentDeployer) so this web app has the same
    transport options and fallback order: RemComStyle -> WinRM -> PsExec ->
    WMI. RemComStyle, PsExec and WMI all need the target's ADMIN$/RPC
    surface reachable (SMB port 445 or RPC port 135); WinRM needs
    WinRM/PSRemoting enabled (Enable-PSRemoting).

.PARAMETER TargetHost
    Hostname or IP of the server to deploy to.

.PARAMETER InstallerPath
    Local path (on this machine) to this target's agent installer - .exe or
    .msi. For a pre-customized per-location EXE (see
    config.deployment.installerByLocation), leave -InstallArgs blank; it's
    already silent by design. MSI installers default to "/qn /norestart"
    when -InstallArgs is blank.

.PARAMETER CredentialFile
    Path to a PSCredential exported via Export-Clixml (see Setup-Credential.ps1).
    Use this OR -Username, not both.

.PARAMETER Username
    Deployment account username for this specific target (e.g. a per-server
    local admin account looked up from the inventory tool). When set, the
    matching password is read as a single line from stdin - never from a
    command-line argument or a file - so it never appears in the process
    list or on disk. Use this OR -CredentialFile, not both.

    SECURITY NOTE: the RemComStyle and PsExec transports below still pass
    the plaintext password as a command-line argument to net.exe/PsExec.exe
    - that's an inherent limitation of those tools' interfaces (the
    reference desktop tool has the same exposure), unlike WinRM/WMI, which
    take the credential as an in-process object.

.PARAMETER Method
    Auto (default - tries RemComStyle, then WinRM, then PsExec, then WMI,
    in that order, until one succeeds) or one specific method: RemComStyle,
    WinRM, PsExec, WMI.

.NOTES
    Prints single-line progress markers ("STEP: ...", "STATUS: ...") that the
    Node.js backend parses to update job status and stream logs to the UI.
    Keep these markers if you modify this script. Never Write-Output the
    password/credential - anything printed here is streamed live to the web
    UI and persisted to the job history on disk.
#>
param(
    [Parameter(Mandatory = $true)][string]$TargetHost,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$CredentialFile,
    [string]$Username,
    [ValidateSet("Auto", "RemComStyle", "WinRM", "PsExec", "WMI")]
    [string]$Method = "Auto",
    [string]$InstallArgs = "",
    [string]$RemoteDir = "C:\Windows\Temp",
    [string]$ServiceName = "ManageEngine UEMS - Agent",
    [string]$PsExecPath = "C:\Sysinternals\PsExec.exe",
    [int]$WinRmPort = 5985,
    [switch]$UseHttps,
    [switch]$SkipCertValidation
)

$ErrorActionPreference = "Stop"

function Emit-Step($step) { Write-Output "STEP: $step" }
function Emit-Status($status, $message) { Write-Output "STATUS: $status | $message" }

# ---------------------------------------------------------------------------
# Credential resolution (file OR username+stdin password)
# ---------------------------------------------------------------------------
if ($CredentialFile) {
    if (-not (Test-Path $CredentialFile)) {
        Emit-Status "Failed" "Credential file not found at $CredentialFile. Run Setup-Credential.ps1 first."
        exit 1
    }
    $cred = Import-Clixml -Path $CredentialFile
}
elseif ($Username) {
    $passwordLine = [Console]::In.ReadLine()
    if ([string]::IsNullOrEmpty($passwordLine)) {
        Emit-Status "Failed" "No password was supplied on stdin for user $Username."
        exit 1
    }
    $securePassword = ConvertTo-SecureString -String $passwordLine -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($Username, $securePassword)
    Remove-Variable passwordLine -ErrorAction SilentlyContinue
}
else {
    Emit-Status "Failed" "Either -CredentialFile or -Username (with a password on stdin) must be supplied."
    exit 1
}

if (-not (Test-Path $InstallerPath)) {
    Emit-Status "Failed" "Installer not found at $InstallerPath."
    exit 1
}

$InstallerLeaf = Split-Path $InstallerPath -Leaf
$IsMsi = [System.IO.Path]::GetExtension($InstallerPath) -ieq ".msi"
if ([string]::IsNullOrWhiteSpace($InstallArgs) -and $IsMsi) {
    $InstallArgs = "/qn /norestart"
}
$RemotePath = Join-Path $RemoteDir $InstallerLeaf

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

function Test-TcpPort {
    param([string]$ComputerName, [int]$Port, [int]$TimeoutMs = 5000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function ConvertTo-UncPath {
    param([string]$ComputerName, [string]$RemotePath)
    if ($RemotePath -imatch '^[A-Za-z]:\\Windows\\(.*)$') {
        return "\\" + $ComputerName + "\ADMIN$\" + $Matches[1]
    }
    if ($RemotePath -imatch '^([A-Za-z]):\\(.*)$') {
        return "\\" + $ComputerName + "\" + $Matches[1] + "$\" + $Matches[2]
    }
    throw "Unsupported remote path for UNC conversion: $RemotePath"
}

function Connect-AdminShare {
    param([string]$ComputerName, [string]$UserName, [string]$Password)
    & net use ("\\" + $ComputerName + "\ADMIN$") "/delete" "/y" 2>&1 | Out-Null
    $output = & net use ("\\" + $ComputerName + "\ADMIN$") $Password ("/user:" + $UserName) 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to map ADMIN`$ on $ComputerName - $($output -join ' ')"
    }
}

function Disconnect-AdminShare {
    param([string]$ComputerName)
    & net use ("\\" + $ComputerName + "\ADMIN$") "/delete" "/y" 2>&1 | Out-Null
}

function Test-ServiceViaWinRM {
    param([string]$ComputerName, $Credential, [string]$Name, [int]$Port, [switch]$Https)
    try {
        $installed = Invoke-Command -ComputerName $ComputerName -Credential $Credential -Port $Port -UseSSL:$Https -ScriptBlock {
            param($svcName)
            [bool](Get-Service -Name $svcName -ErrorAction SilentlyContinue)
        } -ArgumentList $Name -ErrorAction Stop
        return [bool]$installed
    }
    catch {
        return $false
    }
}

function Test-ServiceViaScQuery {
    param([string]$ComputerName, [string]$Name)
    $output = & sc.exe ("\\" + $ComputerName) query "$Name" 2>&1
    return ($LASTEXITCODE -eq 0 -and ($output -join "`n") -match [regex]::Escape($Name))
}

function Test-ServiceViaWmi {
    param([string]$ComputerName, $Credential, [string]$Name)
    try {
        $escaped = $Name.Replace("'", "''")
        $svc = Get-WmiObject -Class Win32_Service -ComputerName $ComputerName -Credential $Credential -Filter "Name='$escaped' OR DisplayName='$escaped'" -ErrorAction Stop
        return [bool]$svc
    }
    catch {
        return $false
    }
}

function Test-AgentInstalled {
    param([string]$Via)
    switch ($Via) {
        "WinRM" { return Test-ServiceViaWinRM -ComputerName $TargetHost -Credential $cred -Name $ServiceName -Port $WinRmPort -Https:$UseHttps }
        "WMI" { return Test-ServiceViaWmi -ComputerName $TargetHost -Credential $cred -Name $ServiceName }
        default { return Test-ServiceViaScQuery -ComputerName $TargetHost -Name $ServiceName } # RemComStyle/PsExec both use plain remote sc query
    }
}

function Wait-ForUncFlag {
    param([string]$SuccessPath, [string]$FailedPath, [string]$ExitCodePath, [int]$TimeoutSeconds = 900, [int]$PollSeconds = 5, [scriptblock]$InstalledCheck)
    $start = Get-Date
    while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSeconds) {
        if (Test-Path $SuccessPath) { return "SUCCESS" }
        if (Test-Path $FailedPath) { return "FAILED" }
        if ($InstalledCheck -and (& $InstalledCheck)) { return "SUCCESS" }
        Start-Sleep -Seconds $PollSeconds
    }
    throw "Deployment verification timed out after $TimeoutSeconds seconds."
}

# ---------------------------------------------------------------------------
# RemComStyle: copies installer + a launcher .cmd over the ADMIN$ share,
# creates a one-shot temporary Windows service whose binPath runs the
# launcher, starts it, and polls for success/failure flag files the
# launcher writes next to itself. No external RemCom.exe binary needed -
# sc.exe's own remote service control (RPC) does the launching.
# ---------------------------------------------------------------------------
function Install-ViaRemComStyle {
    Emit-Step "RemComStyle-Connect"
    if (-not (Test-TcpPort -ComputerName $TargetHost -Port 445)) {
        throw "Port 445 (SMB) is not reachable on $TargetHost."
    }
    Connect-AdminShare -ComputerName $TargetHost -UserName $cred.UserName -Password $cred.GetNetworkCredential().Password

    $remoteDirUnc = ConvertTo-UncPath -ComputerName $TargetHost -RemotePath $RemoteDir
    $stamp = (Get-Date -Format "yyyyMMddHHmmss") + "_" + (Get-Random -Maximum 9999)
    $successName = "uems_remcom_ok_$stamp.flag"
    $failedName = "uems_remcom_fail_$stamp.flag"
    $exitName = "uems_remcom_exitcode_$stamp.txt"
    $launcherName = "uems_remcom_launch_$stamp.cmd"
    $serviceName = "UEMSDeploy_$stamp"

    $payloadUnc = Join-Path $remoteDirUnc $InstallerLeaf
    $successUnc = Join-Path $remoteDirUnc $successName
    $failedUnc = Join-Path $remoteDirUnc $failedName
    $exitUnc = Join-Path $remoteDirUnc $exitName
    $launcherUnc = Join-Path $remoteDirUnc $launcherName

    $remoteSuccess = Join-Path $RemoteDir $successName
    $remoteFailed = Join-Path $RemoteDir $failedName
    $remoteExit = Join-Path $RemoteDir $exitName
    $remoteLauncher = Join-Path $RemoteDir $launcherName

    try {
        if (-not (Test-Path $remoteDirUnc)) { New-Item -ItemType Directory -Path $remoteDirUnc -Force | Out-Null }

        Emit-Step "RemComStyle-CopyInstaller"
        Copy-Item -Path $InstallerPath -Destination $payloadUnc -Force
        Write-Output "Installer copied to $payloadUnc"

        $installCommand = "`"$RemotePath`""
        if ($InstallArgs) { $installCommand += " $InstallArgs" }

        $launcherLines = @(
            "@echo off",
            "del /f /q `"$remoteSuccess`" >nul 2>nul",
            "del /f /q `"$remoteFailed`" >nul 2>nul",
            "del /f /q `"$remoteExit`" >nul 2>nul",
            $installCommand,
            "set UEMS_EXIT=%ERRORLEVEL%",
            "echo %UEMS_EXIT% > `"$remoteExit`"",
            "if `"%UEMS_EXIT%`"==`"0`" (type nul > `"$remoteSuccess`") else (type nul > `"$remoteFailed`")",
            "exit /b %UEMS_EXIT%"
        )

        Emit-Step "RemComStyle-WriteLauncher"
        Set-Content -Path $launcherUnc -Value $launcherLines -Encoding ASCII
        Write-Output "Launcher script written to $launcherUnc"
        Remove-Item -Path $successUnc, $failedUnc, $exitUnc -Force -ErrorAction SilentlyContinue

        $binPath = "cmd.exe /c `"$remoteLauncher`""

        Emit-Step "RemComStyle-CreateService"
        $createOutput = & sc.exe ("\\" + $TargetHost) create "$serviceName" binPath= "$binPath" start= demand 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Remote service creation failed: $($createOutput -join ' ')"
        }
        Write-Output "Temporary service '$serviceName' created."

        Emit-Step "RemComStyle-StartService"
        $startOutput = & sc.exe ("\\" + $TargetHost) start "$serviceName" 2>&1
        Write-Output ("sc start output: " + ($startOutput -join ' '))
        # A one-shot "run and exit" service commonly reports a non-zero start
        # result even when the command inside it runs fine - the flag-file
        # poll below is the authoritative success signal, not this exit code.

        Emit-Step "RemComStyle-Verify"
        $result = Wait-ForUncFlag -SuccessPath $successUnc -FailedPath $failedUnc -ExitCodePath $exitUnc -TimeoutSeconds 900 `
            -InstalledCheck { Test-ServiceViaScQuery -ComputerName $TargetHost -Name $ServiceName }
        if ($result -ne "SUCCESS") {
            $exitText = ""
            if (Test-Path $exitUnc) { $exitText = (Get-Content $exitUnc -Raw -ErrorAction SilentlyContinue) }
            throw "RemComStyle remote install reported failure$(if ($exitText) { ": $exitText" })"
        }
        Write-Output "RemComStyle deployment succeeded."
    }
    finally {
        & sc.exe ("\\" + $TargetHost) delete "$serviceName" 2>&1 | Out-Null
        Remove-Item -Path $launcherUnc, $successUnc, $failedUnc, $exitUnc, $payloadUnc -Force -ErrorAction SilentlyContinue
        Disconnect-AdminShare -ComputerName $TargetHost
    }
}

# ---------------------------------------------------------------------------
# WinRM: copies the installer over the ADMIN$ share (avoiding any WinRM
# payload-size limit entirely, unlike embedding the file in the WinRM
# request itself) then runs it via PowerShell Remoting, which blocks until
# the installer exits and hands back its real exit code directly.
# ---------------------------------------------------------------------------
function Install-ViaWinRM {
    Emit-Step "WinRM-Connect"
    if (-not (Test-TcpPort -ComputerName $TargetHost -Port $WinRmPort)) {
        throw "Port $WinRmPort (WinRM) is not reachable on $TargetHost."
    }

    Emit-Step "WinRM-CopyInstaller"
    $remoteDirUnc = ConvertTo-UncPath -ComputerName $TargetHost -RemotePath $RemoteDir
    if (-not (Test-Path $remoteDirUnc)) { New-Item -ItemType Directory -Path $remoteDirUnc -Force | Out-Null }
    $payloadUnc = Join-Path $remoteDirUnc $InstallerLeaf
    Copy-Item -Path $InstallerPath -Destination $payloadUnc -Force
    Write-Output "Installer copied to $payloadUnc"

    Emit-Step "WinRM-RemoteInstall"
    $sessionOption = New-PSSessionOption -SkipCACheck:$SkipCertValidation -SkipCNCheck:$SkipCertValidation -SkipRevocationCheck:$SkipCertValidation
    $exitCode = Invoke-Command -ComputerName $TargetHost -Credential $cred -Port $WinRmPort -UseSSL:$UseHttps -SessionOption $sessionOption -ScriptBlock {
        param($path, $args)
        if ($args) {
            $proc = Start-Process -FilePath $path -ArgumentList $args -Wait -PassThru
        }
        else {
            $proc = Start-Process -FilePath $path -Wait -PassThru
        }
        return $proc.ExitCode
    } -ArgumentList $RemotePath, $InstallArgs

    Write-Output "Installer process exit code: $exitCode"
    if ($exitCode -ne 0) {
        throw "Installer returned non-zero exit code $exitCode."
    }
    Write-Output "WinRM deployment succeeded."
}

# ---------------------------------------------------------------------------
# PsExec: copies the installer over the ADMIN$ share, then shells out to
# Sysinternals PsExec.exe, which blocks until the remote process exits and
# passes its exit code straight back as PsExec's own exit code.
# ---------------------------------------------------------------------------
function Install-ViaPsExec {
    Emit-Step "PsExec-Connect"
    if (-not (Test-Path $PsExecPath)) {
        throw "PsExec not found at $PsExecPath. Set DEPLOY_PSEXEC_PATH to a valid PsExec.exe (Sysinternals)."
    }
    if (-not (Test-TcpPort -ComputerName $TargetHost -Port 445)) {
        throw "Port 445 (SMB) is not reachable on $TargetHost."
    }
    $plainPassword = $cred.GetNetworkCredential().Password
    Connect-AdminShare -ComputerName $TargetHost -UserName $cred.UserName -Password $plainPassword

    $remoteDirUnc = ConvertTo-UncPath -ComputerName $TargetHost -RemotePath $RemoteDir
    $payloadUnc = Join-Path $remoteDirUnc $InstallerLeaf
    try {
        if (-not (Test-Path $remoteDirUnc)) { New-Item -ItemType Directory -Path $remoteDirUnc -Force | Out-Null }

        Emit-Step "PsExec-CopyInstaller"
        Copy-Item -Path $InstallerPath -Destination $payloadUnc -Force
        Write-Output "Installer copied to $payloadUnc"

        $remoteCmdline = "`"$RemotePath`""
        if ($InstallArgs) { $remoteCmdline += " $InstallArgs" }

        Emit-Step "PsExec-RunInstaller"
        $psexecArgs = @(("\\" + $TargetHost), "-u", $cred.UserName, "-p", $plainPassword, "-h", "-accepteula", "cmd", "/c", $remoteCmdline)
        $output = & $PsExecPath @psexecArgs 2>&1
        $exitCode = $LASTEXITCODE
        Write-Output ($output -join "`n")
        if ($exitCode -ne 0) {
            throw "PsExec install returned exit code $exitCode."
        }
        Write-Output "PsExec deployment succeeded."
    }
    finally {
        Disconnect-AdminShare -ComputerName $TargetHost
    }
}

# ---------------------------------------------------------------------------
# WMI: needs no ADMIN$/SMB access at all - only RPC/DCOM port 135. Since
# there's no share to copy the installer through, this machine briefly
# serves the installer over a one-shot, token-authenticated local HTTP
# endpoint; a remote process (launched via WMI Win32_Process.Create)
# downloads it and runs it, then writes its own success/failure flags to
# its *local* C:\Windows\Temp - checked back here via WMI CIM_DataFile
# queries (again, no SMB needed).
# ---------------------------------------------------------------------------
function Get-LocalIpForTarget {
    param([string]$TargetHostName)
    try {
        $udp = New-Object System.Net.Sockets.UdpClient
        $udp.Connect($TargetHostName, 80)
        $ip = $udp.Client.LocalEndPoint.Address.ToString()
        $udp.Close()
        return $ip
    }
    catch {
        $addr = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq "InterNetwork" } | Select-Object -First 1
        return $addr.ToString()
    }
}

function Get-FreeTcpPort {
    param([string]$BindIp, [int]$Min = 20000, [int]$Max = 45000)
    for ($i = 0; $i -lt 25; $i++) {
        $port = Get-Random -Minimum $Min -Maximum $Max
        try {
            $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($BindIp), $port)
            $listener.Start()
            $listener.Stop()
            return $port
        }
        catch {
            continue
        }
    }
    throw "Unable to find a free local port for the one-shot HTTP server."
}

function Start-OneShotHttpServer {
    param([string]$FilePath, [string]$BindIp, [int]$Port, [string]$Token)
    return Start-Job -ScriptBlock {
        param($FilePath, $BindIp, $Port, $Token)
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://" + $BindIp + ":" + $Port + "/")
        $listener.Start()
        try {
            $context = $listener.GetContext() # blocks until one request arrives, or this job is force-stopped
            $req = $context.Request
            $resp = $context.Response
            if ($req.Url.AbsolutePath -eq ("/" + $Token)) {
                $bytes = [System.IO.File]::ReadAllBytes($FilePath)
                $resp.ContentType = "application/octet-stream"
                $resp.ContentLength64 = $bytes.Length
                $resp.OutputStream.Write($bytes, 0, $bytes.Length)
                $resp.OutputStream.Flush()
            }
            else {
                $resp.StatusCode = 404
            }
            $resp.Close()
        }
        finally {
            $listener.Stop()
            $listener.Close()
        }
    } -ArgumentList $FilePath, $BindIp, $Port, $Token
}

function Test-RemoteFileViaWmi {
    param([string]$ComputerName, $Credential, [string]$Path)
    $escaped = $Path.Replace('\', '\\')
    try {
        $f = Get-WmiObject -Class CIM_DataFile -ComputerName $ComputerName -Credential $Credential -Filter "Name='$escaped'" -ErrorAction Stop
        return [bool]$f
    }
    catch {
        return $false
    }
}

function Wait-ForWmiFlag {
    param([string]$ComputerName, $Credential, [string]$SuccessPath, [string]$FailedPath, [string]$ServiceName, [int]$TimeoutSeconds = 900, [int]$PollSeconds = 5)
    $start = Get-Date
    while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSeconds) {
        if (Test-RemoteFileViaWmi -ComputerName $ComputerName -Credential $Credential -Path $SuccessPath) { return "SUCCESS" }
        if (Test-RemoteFileViaWmi -ComputerName $ComputerName -Credential $Credential -Path $FailedPath) { return "FAILED" }
        if (Test-ServiceViaWmi -ComputerName $ComputerName -Credential $Credential -Name $ServiceName) { return "SUCCESS" }
        Start-Sleep -Seconds $PollSeconds
    }
    throw "WMI verification timed out after $TimeoutSeconds seconds. No success/failure flag detected."
}

function Install-ViaWmi {
    Emit-Step "WMI-Precheck"
    if (-not (Test-TcpPort -ComputerName $TargetHost -Port 135)) {
        throw "Port 135 (RPC/WMI) is not reachable on $TargetHost."
    }

    $bindIp = Get-LocalIpForTarget -TargetHostName $TargetHost
    $httpPort = Get-FreeTcpPort -BindIp $bindIp
    $token = [System.Guid]::NewGuid().ToString("N")
    $downloadUrl = "http://" + $bindIp + ":" + $httpPort + "/" + $token

    $stamp = (Get-Date -Format "yyyyMMddHHmmss") + "_" + (Get-Random -Maximum 9999)
    $remoteExit = Join-Path $RemoteDir "uems_wmi_exitcode_$stamp.txt"
    $remoteSuccess = Join-Path $RemoteDir "uems_wmi_ok_$stamp.flag"
    $remoteFailed = Join-Path $RemoteDir "uems_wmi_fail_$stamp.flag"

    Emit-Step "WMI-StartHttpServer"
    $job = Start-OneShotHttpServer -FilePath $InstallerPath -BindIp $bindIp -Port $httpPort -Token $token
    Write-Output "One-shot HTTP server bound to $bindIp`:$httpPort"

    try {
        $remotePsLines = @(
            '$ProgressPreference=''SilentlyContinue''',
            "Remove-Item -Path '$remoteSuccess' -ErrorAction SilentlyContinue",
            "Remove-Item -Path '$remoteFailed' -ErrorAction SilentlyContinue",
            "Remove-Item -Path '$remoteExit' -ErrorAction SilentlyContinue",
            "try {",
            "  `$wc = New-Object System.Net.WebClient",
            "  `$wc.DownloadFile('$downloadUrl', '$RemotePath')",
            "  `$p = Start-Process -FilePath '$RemotePath' -ArgumentList '$InstallArgs' -Wait -PassThru",
            "  Set-Content -Path '$remoteExit' -Value ([string]`$p.ExitCode)",
            "  if (`$p.ExitCode -eq 0) { New-Item -ItemType File -Path '$remoteSuccess' -Force | Out-Null } else { New-Item -ItemType File -Path '$remoteFailed' -Force | Out-Null }",
            "} catch {",
            "  Set-Content -Path '$remoteExit' -Value ('ERROR: ' + `$_.Exception.Message)",
            "  New-Item -ItemType File -Path '$remoteFailed' -Force | Out-Null",
            "}"
        )
        $remotePs = $remotePsLines -join "`n"
        $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($remotePs))
        $runLine = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"

        Emit-Step "WMI-LaunchRemote"
        $wmiResult = Invoke-WmiMethod -Class Win32_Process -Name Create -ComputerName $TargetHost -Credential $cred -ArgumentList $runLine -ErrorAction Stop
        Write-Output "WMI process create ReturnValue=$($wmiResult.ReturnValue) ProcessId=$($wmiResult.ProcessId)"
        if ($wmiResult.ReturnValue -ne 0) {
            throw "WMI remote process creation failed with ReturnValue=$($wmiResult.ReturnValue)."
        }

        Emit-Step "WMI-Verify"
        $result = Wait-ForWmiFlag -ComputerName $TargetHost -Credential $cred -SuccessPath $remoteSuccess -FailedPath $remoteFailed -ServiceName $ServiceName -TimeoutSeconds 900
        if ($result -ne "SUCCESS") {
            throw "WMI remote install reported failure."
        }
        Write-Output "WMI deployment succeeded."
    }
    finally {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        try {
            $cleanupCmd = "cmd /c del /f /q `"$remoteSuccess`" `"$remoteFailed`" `"$remoteExit`" 2>nul"
            Invoke-WmiMethod -Class Win32_Process -Name Create -ComputerName $TargetHost -Credential $cred -ArgumentList $cleanupCmd -ErrorAction SilentlyContinue | Out-Null
        }
        catch {}
    }
}

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------
function Invoke-Deploy {
    param([string]$SelectedMethod)

    $methods = [ordered]@{
        RemComStyle = { Install-ViaRemComStyle }
        WinRM       = { Install-ViaWinRM }
        PsExec      = { Install-ViaPsExec }
        WMI         = { Install-ViaWmi }
    }

    if ($SelectedMethod -ne "Auto") {
        & $methods[$SelectedMethod]
        return
    }

    $lastError = $null
    foreach ($name in $methods.Keys) {
        try {
            Write-Output "[Auto] Trying $name..."
            & $methods[$name]
            Write-Output "[Auto] Completed deployment via $name"
            return
        }
        catch {
            Write-Output "[Auto] $name failed: $($_.Exception.Message)"
            $lastError = $_
        }
    }
    throw "All deployment methods failed. Last error: $($lastError.Exception.Message)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
try {
    Emit-Step "Deploy"
    Invoke-Deploy -SelectedMethod $Method

    Emit-Step "Verify"
    $verified = $false
    $checkOrder = @($Method, "WinRM", "WMI") | Select-Object -Unique | Where-Object { $_ -ne "Auto" }
    foreach ($via in $checkOrder) {
        try {
            if (Test-AgentInstalled -Via $via) { $verified = $true; break }
        }
        catch {}
    }

    if (-not $verified) {
        Emit-Status "Warning" "Install completed but agent service '$ServiceName' not detected yet - verify manually."
        exit 0
    }

    Emit-Status "Success" "Agent deployed and service detected on $TargetHost."
    exit 0
}
catch {
    Emit-Status "Failed" $_.Exception.Message
    exit 1
}
