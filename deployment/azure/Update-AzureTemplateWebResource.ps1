<#
.SYNOPSIS
    Compiles main.bicep and regenerates the browser copy of the ARM template.

.DESCRIPTION
    The Setup Center web resource deploys the Azure infrastructure straight from
    the browser and therefore needs the compiled ARM template as a JavaScript web
    resource (Dataverse has no JSON web resource type).

    This script is a maintainer tool. Run it whenever main.bicep changes and
    commit both generated files:

        deployment/azure/main.json
        webresources/segment-preview-azure-template.js

    The unit test suite fails if the two files drift apart.

.PARAMETER SkipBicepBuild
    Reuse the existing main.json instead of invoking 'az bicep build'. Useful on
    machines without the Azure CLI.
#>
[CmdletBinding()]
param(
    [switch] $SkipBicepBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$azureDir = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $azureDir)
$bicepPath = Join-Path $azureDir 'main.bicep'
$jsonPath = Join-Path $azureDir 'main.json'
$webResourcePath = Join-Path $repoRoot 'webresources/segment-preview-azure-template.js'

if (-not (Test-Path -LiteralPath $bicepPath)) {
    throw "main.bicep was not found at '$bicepPath'."
}

if (-not $SkipBicepBuild) {
    Write-Host 'Compiling main.bicep...' -ForegroundColor Cyan
    & az bicep build --file $bicepPath --outfile $jsonPath
    if ($LASTEXITCODE -ne 0) {
        throw "'az bicep build' failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $jsonPath)) {
    throw "main.json was not found at '$jsonPath'. Run without -SkipBicepBuild."
}

$json = Get-Content -LiteralPath $jsonPath -Raw
$null = $json | ConvertFrom-Json

$indented = ($json.TrimEnd() -split "`r?`n" | ForEach-Object {
        if ($_.Length -eq 0) { '' } else { '  ' + $_ }
    }) -join "`n"
$indented = $indented.TrimStart()

$builder = [System.Text.StringBuilder]::new()
[void]$builder.AppendLine('/*!')
[void]$builder.AppendLine(' * Segment Preview - Azure Resource Manager template.')
[void]$builder.AppendLine(' *')
[void]$builder.AppendLine(' * GENERATED FILE - do not edit by hand.')
[void]$builder.AppendLine(' * Source:     deployment/azure/main.bicep')
[void]$builder.AppendLine(' * Regenerate: pwsh -File deployment/azure/Update-AzureTemplateWebResource.ps1')
[void]$builder.AppendLine(' */')
[void]$builder.AppendLine('(function (root, factory) {')
[void]$builder.AppendLine('  "use strict";')
[void]$builder.AppendLine('  var template = factory();')
[void]$builder.AppendLine('  if (typeof module === "object" && module && module.exports) {')
[void]$builder.AppendLine('    module.exports = template;')
[void]$builder.AppendLine('  }')
[void]$builder.AppendLine('  if (root) {')
[void]$builder.AppendLine('    root.SegmentPreviewAzureTemplate = template;')
[void]$builder.AppendLine('  }')
[void]$builder.AppendLine('})(typeof globalThis !== "undefined" ? globalThis : this, function () {')
[void]$builder.AppendLine('  "use strict";')
[void]$builder.AppendLine('  return ' + $indented + ';')
[void]$builder.AppendLine('});')

$content = $builder.ToString() -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($webResourcePath, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host "Wrote $webResourcePath" -ForegroundColor Green
