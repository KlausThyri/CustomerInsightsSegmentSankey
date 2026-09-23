#requires -Version 7.2
<#
.SYNOPSIS
Runs every hermetic test suite and build in a deterministic order.

.DESCRIPTION
The projects share generated plugin and Solution Packager output, so build and
packaging steps are intentionally serial. This script is the local equivalent
of the repository CI validation.
#>
[CmdletBinding()]
param(
    [switch] $SkipSolutionPackage,
    [switch] $Detailed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath

function Invoke-Step {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [scriptblock] $Action
    )

    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "'$Name' failed with exit code $LASTEXITCODE."
    }
}

Invoke-Step 'CustomApi tests' {
    dotnet test (Join-Path $repositoryRoot 'CustomApi.Tests\CustomerInsightsSegmentSankey.CustomApi.Tests.csproj') `
        --configuration Release --nologo
}

Invoke-Step 'FabricApi tests' {
    dotnet test (Join-Path $repositoryRoot 'FabricApi.Tests\CustomerInsightsSegmentSankey.FabricApi.Tests.csproj') `
        --configuration Release --nologo
}

Invoke-Step 'Broker tests' {
    dotnet test (Join-Path $repositoryRoot 'Broker.Tests\CustomerInsightsSegmentSankey.Broker.Tests.csproj') `
        --configuration Release --nologo
}

Invoke-Step 'Webresource tests' {
    $testFiles = Get-ChildItem (Join-Path $repositoryRoot 'webresources\tests') -Filter '*.test.cjs' |
        Sort-Object FullName |
        Select-Object -ExpandProperty FullName
    if ($testFiles.Count -eq 0) {
        throw 'No webresource test files were found.'
    }
    node --test @testFiles
}

Invoke-Step 'Provisioning tests' {
    $arguments = @{
        Detailed = $Detailed
    }
    & (Join-Path $repositoryRoot 'deployment\tests\Invoke-ProvisioningTests.ps1') @arguments
}

if (-not $SkipSolutionPackage) {
    Invoke-Step 'Plugin build' {
        dotnet build (Join-Path $repositoryRoot 'CustomerInsightsSegmentSankey.csproj') `
            --configuration Release --nologo
    }

    Invoke-Step 'Solution package build' {
        & (Join-Path $repositoryRoot 'solution\build-solution.ps1') -Configuration Release
    }
}

Write-Host "`nAll validation steps passed." -ForegroundColor Green
