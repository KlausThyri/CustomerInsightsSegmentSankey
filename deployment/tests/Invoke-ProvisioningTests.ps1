#requires -Version 7.2
<#
.SYNOPSIS
Runs the Segment Preview provisioning test suite.

.DESCRIPTION
Installs Pester 5 for the current user when it is missing, then runs every
Pester test under deployment/tests. The tests are hermetic: no Azure, Fabric,
or Dataverse call is made.

.EXAMPLE
./deployment/tests/Invoke-ProvisioningTests.ps1

.EXAMPLE
./deployment/tests/Invoke-ProvisioningTests.ps1 -Detailed
#>
[CmdletBinding()]
param(
    # Emit per-test output instead of the default summary.
    [switch] $Detailed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pester = Get-Module -ListAvailable -Name Pester |
    Where-Object { $_.Version -ge [version] '5.0.0' } |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $pester) {
    Write-Host 'Installing Pester 5 for the current user...' -ForegroundColor Yellow
    Install-Module -Name Pester -MinimumVersion 5.0.0 -Scope CurrentUser -Force -SkipPublisherCheck
    $pester = Get-Module -ListAvailable -Name Pester |
        Where-Object { $_.Version -ge [version] '5.0.0' } |
        Sort-Object Version -Descending |
        Select-Object -First 1
}

Import-Module $pester.Path -Force

$configuration = New-PesterConfiguration
$configuration.Run.Path = $PSScriptRoot
$configuration.Run.PassThru = $true
$configuration.Output.Verbosity = if ($Detailed) { 'Detailed' } else { 'Normal' }

$result = Invoke-Pester -Configuration $configuration
if ($result.FailedCount -gt 0) {
    exit 1
}
