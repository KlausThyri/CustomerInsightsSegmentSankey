[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string] $Configuration = 'Release',

    # Cutting a public release requires a verifiable API package, so the payload
    # must already carry the published URL and its SHA-256.
    [switch] $Release
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$solutionRoot = Join-Path $PSScriptRoot 'src'
$webResourceRoot = Join-Path $solutionRoot 'WebResources\klth_\SegmentSankey'
$pluginRoot = Join-Path $solutionRoot 'PluginAssemblies\CustomerInsightsSegmentSankey-458B9DC7-1D9A-F111-B8DC-7CED8D762587'

function Update-ZipXmlEntry {
    param(
        [Parameter(Mandatory)] [string] $ArchivePath,
        [Parameter(Mandatory)] [string] $EntryName,
        [Parameter(Mandatory)] [scriptblock] $Transform
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open(
        $ArchivePath,
        [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $archive.GetEntry($EntryName)
        if (-not $entry) {
            throw "The solution archive does not contain '$EntryName'."
        }

        $reader = [IO.StreamReader]::new($entry.Open())
        try {
            [xml] $document = $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }

        & $Transform $document
        $entry.Delete()
        $replacement = $archive.CreateEntry(
            $EntryName,
            [IO.Compression.CompressionLevel]::Optimal)
        $writer = [IO.StreamWriter]::new(
            $replacement.Open(),
            [Text.UTF8Encoding]::new($false))
        try {
            $document.Save($writer)
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Remove-UnmanagedMarketingAppSitemap {
    param([Parameter(Mandatory)] [string] $ArchivePath)

    Update-ZipXmlEntry -ArchivePath $ArchivePath -EntryName 'solution.xml' -Transform {
        param([xml] $document)
        $component = $document.SelectSingleNode(
            "/ImportExportXml/SolutionManifest/RootComponents/RootComponent[@type='62' and @schemaName='msdyncrm_MarketingSMBApp']")
        if (-not $component) {
            throw 'The unmanaged solution does not declare the expected Marketing app sitemap component.'
        }
        [void] $component.ParentNode.RemoveChild($component)
    }

    Update-ZipXmlEntry -ArchivePath $ArchivePath -EntryName 'customizations.xml' -Transform {
        param([xml] $document)
        $siteMap = $document.SelectSingleNode(
            "/ImportExportXml/AppModuleSiteMaps/AppModuleSiteMap[SiteMapUniqueName='msdyncrm_MarketingSMBApp']")
        if (-not $siteMap) {
            throw 'The unmanaged solution does not contain the expected Marketing app sitemap patch.'
        }
        $container = $siteMap.ParentNode
        [void] $container.RemoveChild($siteMap)
        if ($container.SelectNodes('AppModuleSiteMap').Count -eq 0) {
            [void] $container.ParentNode.RemoveChild($container)
        }
    }
}

dotnet build `
    (Join-Path $repositoryRoot 'CustomerInsightsSegmentSankey.csproj') `
    --configuration $Configuration

$templateSource = Join-Path $repositoryRoot 'deployment\azure\main.json'
$templateWebResource = Join-Path $repositoryRoot 'webresources\segment-preview-azure-template.js'
if ((Test-Path -LiteralPath $templateSource) -and (Test-Path -LiteralPath $templateWebResource)) {
    $script = Get-Content -LiteralPath $templateWebResource -Raw
    $marker = 'return '
    $start = $script.LastIndexOf($marker)
    $end = $script.LastIndexOf('};') + 1
    $embedded = $script.Substring($start + $marker.Length, $end - $start - $marker.Length)
    $expected = (Get-Content -LiteralPath $templateSource -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 64 -Compress)
    $actual = ($embedded | ConvertFrom-Json | ConvertTo-Json -Depth 64 -Compress)
    if ($expected -ne $actual) {
        throw "The Azure template web resource is out of date. Run 'pwsh -File deployment/azure/Update-AzureTemplateWebResource.ps1'."
    }
}

$payloadWebResource = Join-Path $repositoryRoot 'webresources\segment-preview-payload.js'
$notebookSource = Join-Path $repositoryRoot 'Fabric\bootstrap-events.py'
if ((Test-Path -LiteralPath $notebookSource) -and (Test-Path -LiteralPath $payloadWebResource)) {
    if ((Get-Item -LiteralPath $notebookSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $payloadWebResource).LastWriteTimeUtc) {
        throw "The setup payload web resource is older than Fabric/bootstrap-events.py. Run 'pwsh -File deployment/Update-SetupPayloadWebResource.ps1'."
    }
}

if ($Release) {
    # The Setup Center refuses to deploy a package it cannot verify, so shipping
    # a payload without the URL and digest would leave the API step manual.
    $payloadText = Get-Content -LiteralPath $payloadWebResource -Raw
    $returnMarker = [Environment]::NewLine + '  return {'
    $start = $payloadText.LastIndexOf($returnMarker)
    $end = $payloadText.LastIndexOf('};') + 1
    if ($start -lt 0 -or $end -le $start) {
        throw 'The setup payload does not contain the expected generated return object.'
    }
    $payloadJson = $payloadText.Substring(
        $start + $returnMarker.Length - 1,
        $end - $start - $returnMarker.Length + 1) | ConvertFrom-Json
    if (-not $payloadJson.api.packageUrl -or $payloadJson.api.packageUrl -notmatch '^https://') {
        throw "The setup payload carries no API package URL. Publish the release asset, then run 'pwsh -File deployment/Update-SetupPayloadWebResource.ps1 -ApiPackageUrl <url> -ApiPackagePath <zip>'."
    }
    if ($payloadJson.api.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw "The setup payload carries no API package SHA-256. Re-run 'pwsh -File deployment/Update-SetupPayloadWebResource.ps1 -ApiPackageUrl <url> -ApiPackagePath <zip>'."
    }
}

$webResources = @{
    'webresources\cis_SegmentSankeyLauncher.js' = 'launcher.js'
    'webresources\segment-sankey.html' = 'segment-sankey.html'
    'webresources\segment-members.html' = 'segment-members.html'
    'webresources\segment-preview-setup.html' = 'segment-preview-setup.html'
    'webresources\segment-preview-provisioning.js' = 'segment-preview-provisioning.js'
    'webresources\segment-preview-azure-template.js' = 'segment-preview-azure-template.js'
    'webresources\segment-preview-payload.js' = 'segment-preview-payload.js'
    'webresources\segment-sankey-icon.svg' = 'segment-sankey-icon.svg'
}
foreach ($entry in $webResources.GetEnumerator()) {
    Copy-Item `
        -LiteralPath (Join-Path $repositoryRoot $entry.Key) `
        -Destination (Join-Path $webResourceRoot $entry.Value) `
        -Force
}

Copy-Item `
    -LiteralPath (Join-Path $repositoryRoot "bin\$Configuration\net462\CustomerInsightsSegmentSankey.dll") `
    -Destination (Join-Path $pluginRoot 'CustomerInsightsSegmentSankey.dll') `
    -Force

dotnet build `
    (Join-Path $PSScriptRoot 'CustomerInsightsSegmentPreview.cdsproj') `
    --configuration $Configuration

$unmanagedPackage = Join-Path $PSScriptRoot "bin\$Configuration\CustomerInsightsSegmentPreview.zip"
Remove-UnmanagedMarketingAppSitemap -ArchivePath $unmanagedPackage

$artifactRoot = Join-Path $repositoryRoot 'artifacts'
$releaseRoot = Join-Path $repositoryRoot 'deployment\dataverse'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item `
    -LiteralPath $unmanagedPackage `
    -Destination (Join-Path $artifactRoot 'CustomerInsightsSegmentPreview.zip') `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $PSScriptRoot "bin\$Configuration\CustomerInsightsSegmentPreview_managed.zip") `
    -Destination (Join-Path $artifactRoot 'CustomerInsightsSegmentPreview_managed.zip') `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $artifactRoot 'CustomerInsightsSegmentPreview.zip') `
    -Destination (Join-Path $releaseRoot 'CustomerInsightsSegmentPreview.zip') `
    -Force
Copy-Item `
    -LiteralPath (Join-Path $artifactRoot 'CustomerInsightsSegmentPreview_managed.zip') `
    -Destination (Join-Path $releaseRoot 'CustomerInsightsSegmentPreview_managed.zip') `
    -Force
