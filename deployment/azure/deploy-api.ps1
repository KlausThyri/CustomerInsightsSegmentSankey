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

$resolvedParameters = (Resolve-Path -LiteralPath $ParametersFile).ProviderPath
$deploymentArguments = @(
    'deployment', 'group', 'create'
    '--resource-group', $ResourceGroup
)

# A .bicepparam file carries its own "using" statement, so az rejects it when
# --template-file is also supplied.
if ([IO.Path]::GetExtension($resolvedParameters) -eq '.bicepparam') {
    $deploymentArguments += @('--parameters', $resolvedParameters)
}
else {
    $deploymentArguments += @(
        '--template-file', (Join-Path $PSScriptRoot 'main.bicep')
        '--parameters', "@$resolvedParameters"
    )
}

az @deploymentArguments --output table
if ($LASTEXITCODE -ne 0) {
    throw "az deployment group create failed with exit code $LASTEXITCODE."
}

az webapp deploy `
    --resource-group $ResourceGroup `
    --name $WebAppName `
    --src-path $archivePath `
    --type zip `
    --clean true `
    --restart true `
    --output table
if ($LASTEXITCODE -ne 0) {
    throw "az webapp deploy failed with exit code $LASTEXITCODE."
}

Write-Host "API deployment completed: https://$WebAppName.azurewebsites.net/api/health"
