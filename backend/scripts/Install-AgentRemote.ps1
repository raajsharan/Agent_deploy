<#
.SYNOPSIS
    Copies the Endpoint Central agent installer to a single remote Windows
    Server and runs it silently, via PowerShell Remoting. Invoked by the
    Node.js backend once per target server (not run manually in normal use).

.PARAMETER TargetHost
    Hostname or IP of the server to deploy to.

.PARAMETER InstallerPath
    Local path (on this machine) to the agent installer (.msi or .exe).

.PARAMETER CredentialFile
    Path to a PSCredential exported via Export-Clixml (see Setup-Credential.ps1).

.NOTES
    Prints single-line progress markers ("STEP: ...", "STATUS: ...") that the
    Node.js backend parses to update job status and stream logs to the UI.
    Keep these markers if you modify this script.
#>
param(
    [Parameter(Mandatory = $true)][string]$TargetHost,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$CredentialFile,
    [string]$RemoteStagingDir = "C$\Temp\EPCAgent",
    [bool]$InstallerIsMsi = $true,
    [string]$InstallArgsMsi = "/qn /norestart"
)

$ErrorActionPreference = "Stop"

function Emit-Step($step) { Write-Output "STEP: $step" }
function Emit-Status($status, $message) { Write-Output "STATUS: $status | $message" }

try {
    if (-not (Test-Path $CredentialFile)) {
        Emit-Status "Failed" "Credential file not found at $CredentialFile. Run Setup-Credential.ps1 first."
        exit 1
    }
    $cred = Import-Clixml -Path $CredentialFile

    Emit-Step "ConnectivityCheck"
    if (-not (Test-Connection -ComputerName $TargetHost -Count 1 -Quiet)) {
        Emit-Status "Failed" "Server unreachable (ping failed)."
        exit 1
    }
    Write-Output "Ping succeeded."

    Emit-Step "CopyInstaller"
    $remoteDirUnc = "\\$TargetHost\$RemoteStagingDir"
    $remoteFileUnc = Join-Path $remoteDirUnc (Split-Path $InstallerPath -Leaf)

    if (-not (Test-Path $remoteDirUnc)) {
        New-Item -ItemType Directory -Path $remoteDirUnc -Force | Out-Null
    }
    Copy-Item -Path $InstallerPath -Destination $remoteFileUnc -Force
    Write-Output "Installer copied to $remoteFileUnc"

    Emit-Step "RemoteInstall"
    $localInstallerPath = "C:\Temp\EPCAgent\$(Split-Path $InstallerPath -Leaf)"

    $exitCode = Invoke-Command -ComputerName $TargetHost -Credential $cred -ScriptBlock {
        param($path, $isMsi, $msiArgs)
        if ($isMsi) {
            $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$path`" $msiArgs" -Wait -PassThru
        }
        else {
            $proc = Start-Process -FilePath $path -ArgumentList "/silent" -Wait -PassThru
        }
        return $proc.ExitCode
    } -ArgumentList $localInstallerPath, $InstallerIsMsi, $InstallArgsMsi

    Write-Output "Installer process exit code: $exitCode"
    if ($exitCode -ne 0) {
        Emit-Status "Failed" "Installer returned non-zero exit code $exitCode."
        exit 1
    }

    Emit-Step "Verify"
    $serviceCheck = Invoke-Command -ComputerName $TargetHost -Credential $cred -ScriptBlock {
        Get-Service -Name "*Endpoint Central*", "*DesktopCentral*" -ErrorAction SilentlyContinue
    }

    if (-not $serviceCheck) {
        Emit-Status "Warning" "Install completed but agent service not detected yet - verify manually."
        exit 0
    }

    Emit-Status "Success" "Agent deployed and service detected on $TargetHost."
    exit 0
}
catch {
    Emit-Status "Failed" $_.Exception.Message
    exit 1
}
