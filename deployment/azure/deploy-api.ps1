[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $ResourceGroup,

    [Parameter(Mandatory)]
    [string] $WebAppName,

    [Parameter(Mandatory)]
    [string] $ParametersFile
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$publishDirectory = Join-Path $repositoryRoot 'artifacts\fabric-api'
$archivePath = Join-Path $repositoryRoot 'artifacts\fabric-api.zip'

dotnet publish `
    (Join-Path $repositoryRoot 'FabricApi\CustomerInsightsSegmentSankey.FabricApi.csproj') `
    --configuration Release `
    --output $publishDirectory

if (Test-Path $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}
Compress-Archive -Path (Join-Path $publishDirectory '*') -DestinationPath $archivePath

az deployment group create `
    --resource-group $ResourceGroup `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters $ParametersFile `
    --output table

az webapp deploy `
    --resource-group $ResourceGroup `
    --name $WebAppName `
    --src-path $archivePath `
    --type zip `
    --clean true `
    --restart true `
    --output table

Write-Host "API deployment completed: https://$WebAppName.azurewebsites.net/api/health"
