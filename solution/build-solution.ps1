[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string] $Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$solutionRoot = Join-Path $PSScriptRoot 'src'
$webResourceRoot = Join-Path $solutionRoot 'WebResources\klth_\SegmentSankey'
$pluginRoot = Join-Path $solutionRoot 'PluginAssemblies\CustomerInsightsSegmentSankey-458B9DC7-1D9A-F111-B8DC-7CED8D762587'

dotnet build `
    (Join-Path $repositoryRoot 'CustomerInsightsSegmentSankey.csproj') `
    --configuration $Configuration

$webResources = @{
    'webresources\cis_SegmentSankeyLauncher.js' = 'launcher.js'
    'webresources\segment-sankey.html' = 'segment-sankey.html'
    'webresources\segment-members.html' = 'segment-members.html'
    'webresources\segment-preview-setup.html' = 'segment-preview-setup.html'
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

$artifactRoot = Join-Path $repositoryRoot 'artifacts'
$releaseRoot = Join-Path $repositoryRoot 'deployment\dataverse'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item `
    -LiteralPath (Join-Path $PSScriptRoot "bin\$Configuration\CustomerInsightsSegmentPreview.zip") `
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
