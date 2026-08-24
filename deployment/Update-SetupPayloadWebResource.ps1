<#
.SYNOPSIS
Regenerates the setup payload web resource from the repository sources.

.DESCRIPTION
The browser Setup Center provisions everything from the Dataverse web resource,
so the artefacts it has to upload must travel inside the managed solution. This
script converts

  * Fabric/bootstrap-events.py              -> an .ipynb item definition
  * Fabric/bootstrap-events.platform.json   -> the notebook display name
  * Fabric/bootstrap-events.schedules.json  -> the daily job schedule

into webresources/segment-preview-payload.js and copies the result into the
solution source tree. The Setup Center base64-encodes the notebook and calls the
Fabric item-definition API directly; no desktop tooling is involved at install
time.

The API package is *not* embedded - a published ZIP is far too large for a web
resource. Instead the payload carries the package URL together with the SHA-256
of that exact file. The Setup Center downloads the package in the browser,
verifies the digest, uploads the verified bytes into a storage account in the
customer's own resource group and points WEBSITE_RUN_FROM_PACKAGE at that copy,
so the running Web App never depends on the publisher.

Pass -ApiPackageUrl together with either -ApiPackageSha256 or -ApiPackagePath
(which computes the digest from the built ZIP) when cutting a release, after the
release asset has actually been published. A URL without a digest is rejected:
the browser refuses to deploy a package it cannot verify. The shipped default is
empty, so the Setup Center never points a Web App at a URL that does not exist.

.EXAMPLE
pwsh -File deployment/Update-SetupPayloadWebResource.ps1

.EXAMPLE
pwsh -File deployment/Update-SetupPayloadWebResource.ps1 `
    -ApiPackageUrl 'https://github.com/KlausThyri/CustomerInsightsSegmentSankey/releases/download/v1.1.0/segment-preview-api-1.1.0.zip' `
    -ApiPackagePath 'artifacts/segment-preview-api-1.1.0.zip'
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $ApiPackageUrl = '',

    [string] $ApiPackageSha256 = '',

    # The built ZIP the URL points at. Its SHA-256 is computed and used, which
    # removes the chance of pinning a digest that belongs to another build.
    [string] $ApiPackagePath = '',

    [string] $ApiVersion,

    [switch] $AsString
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$modulePath = Join-Path $repositoryRoot 'deployment\modules\SegmentPreview.Provisioning\SegmentPreview.Provisioning.psd1'
Import-Module -Name $modulePath -Force

if ($ApiPackageUrl -and $ApiPackageUrl -notmatch '^https://') {
    throw 'The API package URL must be an absolute https URL.'
}

if ($ApiPackagePath) {
    $resolved = (Resolve-Path -LiteralPath $ApiPackagePath).ProviderPath
    $computed = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ApiPackageSha256 -and $ApiPackageSha256.ToLowerInvariant() -ne $computed) {
        throw "The supplied SHA-256 does not match '$resolved' (computed $computed)."
    }
    $ApiPackageSha256 = $computed
    Write-Host "SHA-256 of $resolved is $computed" -ForegroundColor Green
}

if ($ApiPackageSha256 -and $ApiPackageSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'The API package SHA-256 must be 64 hexadecimal characters.'
}

if ($ApiPackageUrl -and -not $ApiPackageSha256) {
    throw 'An API package URL needs a SHA-256 digest. Pass -ApiPackagePath or -ApiPackageSha256; the browser refuses to deploy a package it cannot verify.'
}

if ($ApiPackageSha256 -and -not $ApiPackageUrl) {
    throw 'An API package SHA-256 needs the URL the package is published at. Pass -ApiPackageUrl.'
}

$ApiPackageSha256 = $ApiPackageSha256.ToLowerInvariant()

if (-not $ApiVersion) {
    $solutionXml = [xml](Get-Content -LiteralPath (Join-Path $repositoryRoot 'solution\src\Other\Solution.xml') -Raw)
    $ApiVersion = [string] $solutionXml.ImportExportXml.SolutionManifest.Version
}

$notebookSource = Get-Content -LiteralPath (Join-Path $repositoryRoot 'Fabric\bootstrap-events.py') -Raw -Encoding UTF8
$platform = Get-Content -LiteralPath (Join-Path $repositoryRoot 'Fabric\bootstrap-events.platform.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$schedules = Get-Content -LiteralPath (Join-Path $repositoryRoot 'Fabric\bootstrap-events.schedules.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$parameters = @('WORKSPACE_ID', 'SERVING_LAKEHOUSE_ID', 'DATAVERSE_LAKEHOUSE_ID')
foreach ($name in $parameters) {
    if ($notebookSource -notmatch ('(?m)^' + [regex]::Escape($name) + '\s*=\s*"[^"]*"')) {
        throw "The bootstrap notebook does not declare the constant '$name'."
    }
}

$ipynb = ConvertTo-SegmentPreviewNotebookIpynb -Source $notebookSource
$notebookContent = $ipynb | ConvertFrom-Json

$schedule = $schedules.schedules | Select-Object -First 1
$scheduleObject = $null
if ($schedule) {
    # ConvertFrom-Json turns ISO 8601 strings into [datetime]; re-render them in
    # the exact round-trip shape the Fabric scheduler expects.
    $isoDate = {
        param($value)
        if ($value -is [datetime]) { return $value.ToString('yyyy-MM-ddTHH:mm:ss') }
        return [string] $value
    }

    $scheduleObject = [ordered]@{
        enabled       = [bool] $schedule.enabled
        jobType       = [string] $schedule.jobType
        configuration = [ordered]@{
            type            = [string] $schedule.configuration.type
            startDateTime   = & $isoDate $schedule.configuration.startDateTime
            endDateTime     = & $isoDate $schedule.configuration.endDateTime
            localTimeZoneId = [string] $schedule.configuration.localTimeZoneId
            times           = @($schedule.configuration.times)
        }
    }
}

$payload = [ordered]@{
    contentVersion = [string] $ApiVersion
    notebook       = [ordered]@{
        displayName = [string] $platform.metadata.displayName
        description = [string] $platform.metadata.description
        format      = 'ipynb'
        path        = 'notebook-content.ipynb'
        platform    = $platform
        parameters  = @($parameters)
        schedule    = $scheduleObject
        content     = $notebookContent
    }
    api            = [ordered]@{
        version            = [string] $ApiVersion
        packageUrl         = [string] $ApiPackageUrl
        sha256             = [string] $ApiPackageSha256
        packageUrlTemplate = 'https://github.com/KlausThyri/CustomerInsightsSegmentSankey/releases/download/v{version}/segment-preview-api-{version}.zip'
    }
}

$json = $payload | ConvertTo-Json -Depth 24
$indented = ($json -split "`r?`n" | ForEach-Object { if ($_.Length -gt 0) { '  ' + $_ } else { $_ } }) -join "`r`n"

$header = @'
/*!
 * Segment Preview - setup payload.
 *
 * GENERATED FILE - do not edit by hand.
 * Sources:    Fabric/bootstrap-events.py
 *             Fabric/bootstrap-events.platform.json
 *             Fabric/bootstrap-events.schedules.json
 * Regenerate: pwsh -File deployment/Update-SetupPayloadWebResource.ps1
 *
 * Carries the artefacts the browser Setup Center uploads on its own: the Fabric
 * bootstrap notebook definition and the API package descriptor (URL plus the
 * SHA-256 the browser verifies before it copies the package into the customer's
 * own storage account). No secret and no credential belongs in this file.
 */
(function (root, factory) {
  "use strict";
  var payload = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = payload;
  }
  if (root) {
    root.SegmentPreviewPayload = payload;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  return
'@

$content = ($header.TrimEnd() + "`r`n" + $indented.TrimStart() + ";`r`n});`r`n")
# The JSON body is emitted after "return " on the same line.
$content = $content -replace "(?m)^  return\r?\n", '  return '

if ($AsString) {
    return $content
}

$targets = @(
    (Join-Path $repositoryRoot 'webresources\segment-preview-payload.js'),
    (Join-Path $repositoryRoot 'solution\src\WebResources\klth_\SegmentSankey\segment-preview-payload.js')
)

foreach ($target in $targets) {
    if ($PSCmdlet.ShouldProcess($target, 'Write setup payload web resource')) {
        [System.IO.File]::WriteAllText($target, $content, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Wrote $target" -ForegroundColor Green
    }
}
