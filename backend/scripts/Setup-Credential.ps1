<#
.SYNOPSIS
    One-time setup: securely stores the deployment service account credential
    on THIS machine (the one that will run the Node.js backend).

.DESCRIPTION
    Run this manually, once, as the same Windows user/account that the
    Node.js backend process will run as. It uses Export-Clixml, which
    encrypts the password with Windows DPAPI tied to that user + machine.
    Only that exact user account on that exact machine can decrypt it again.

    This means the deployment service account's password is NEVER stored in
    plaintext, never passed on the command line, and never held by the
    Node.js process itself - Node only ever passes a file PATH to PowerShell,
    which does the decryption in its own process.

.EXAMPLE
    .\Setup-Credential.ps1 -OutputPath "C:\Deploy\deploy-credential.xml"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$cred = Get-Credential -Message "Enter the service account used to remotely install the agent (e.g. DOMAIN\svc-deploy)"
$cred | Export-Clixml -Path $OutputPath

Write-Host "Credential saved to $OutputPath" -ForegroundColor Green
Write-Host "Set DEPLOY_CREDENTIAL_FILE=$OutputPath in backend/.env" -ForegroundColor Cyan
Write-Host "Remember: this file can only be decrypted by your current Windows user account on this machine." -ForegroundColor Yellow
