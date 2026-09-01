<#
.SYNOPSIS
One-click, idempotent provisioning of the Customer Insights Segment Preview.

.DESCRIPTION
Install-SegmentPreview.ps1 is the single entry point for a new administrator.
It provisions and wires together every component that has a usable management
API:

  * Azure    - resource group, Bicep infrastructure, App Service, Application
               Insights, system-assigned managed identity, application settings,
               and the published ASP.NET Core API.
  * Fabric   - workspace and serving lakehouse discovery or creation, SQL
               analytics endpoint resolution, Dataverse cloud-connection
               discovery, workspace role assignment for the managed identity,
               and the scheduled serving bootstrap notebook.
  * Dataverse- managed solution import or upgrade, environment variable values,
               customization publish, and the end-to-end setup verification that
               the in-product setup center also runs.

The script is safe to run repeatedly. Completed steps are recorded in a resume
state file so an interrupted run continues where it stopped. Steps that are
already in the desired state are detected and skipped.

The server-side API key is generated with the operating system CSPRNG, is never
written to disk, and is never printed. Only a SHA-256 fingerprint is stored in
the resume state so that later runs can detect a rotation.

.PARAMETER ConfigFile
Optional JSON file with the same names as the script parameters. Explicit
parameters always win over the file.

.PARAMETER ConsentReportOnly
Prints the execution plan and the interactive-consent checklist, then exits
without contacting Azure, Fabric, or Dataverse.

.EXAMPLE
./deployment/Install-SegmentPreview.ps1 `
  -DataverseEnvironmentUrl https://contoso.crm4.dynamics.com `
  -ResourceGroup rg-segment-preview `
  -Location westeurope `
  -WebAppName contoso-segment-preview `
  -FabricWorkspaceName "Customer Insights Serving" `
  -FabricCapacityId 00000000-0000-0000-0000-000000000000

.EXAMPLE
./deployment/Install-SegmentPreview.ps1 -ConfigFile ./deployment/install-config.json

.NOTES
Requires PowerShell 7.2+, Azure CLI 2.50+, and the .NET 8 SDK.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string] $ConfigFile,

    [string] $DataverseEnvironmentUrl,

    [string] $SubscriptionId,

    [string] $ResourceGroup,

    [string] $Location = 'westeurope',

    [string] $WebAppName,

    [string] $FabricWorkspaceId,

    [string] $FabricWorkspaceName,

    [string] $FabricCapacityId,

    [string] $FabricCapacityResourceId,

    [string] $FabricServingLakehouseId,

    [string] $FabricServingLakehouseName = 'SegmentPreviewServing',

    [string] $FabricDataverseLakehouseId,

    [string] $FabricDataverseLakehouseName,

    [string] $FabricDataverseConnectionId,

    [string] $FabricDataverseDeltaFolder = 'deltalake',

    [string] $RequiredDataverseTables,

    [switch] $BusinessUnitScopingEnabled,

    [string] $SolutionPackagePath,

    [securestring] $BehavioralApiKey,

    [switch] $RotateApiKey,

    [string] $StateDirectory,

    [string] $DeploymentName,

    [ValidateSet('preflight', 'signin', 'fabric-discovery', 'fabric-notebook', 'secret',
        'azure-infra', 'fabric-permissions', 'azure-app', 'dataverse-import',
        'dataverse-config', 'verify')]
    [string] $FromStep,

    [switch] $SkipFabric,

    [switch] $SkipAzure,

    [switch] $SkipDataverse,

    [switch] $SkipApiDeployment,

    [switch] $SkipNotebook,

    [switch] $ConsentReportOnly,

    [switch] $NonInteractive,

    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'Continue'

$script:RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$script:ModulePath = Join-Path $PSScriptRoot 'modules\SegmentPreview.Provisioning\SegmentPreview.Provisioning.psd1'
Import-Module $script:ModulePath -Force

$script:FabricApiRoot = 'https://api.fabric.microsoft.com/v1'
$script:FabricResource = 'https://api.fabric.microsoft.com'
$script:TokenCache = @{}
$script:Config = @{}
$script:StatePath = $null
$script:EnvironmentDomain = $null
$script:DataverseApiRoot = $null
$script:DataverseResource = $null
$script:SolutionManifest = $null
$script:StepIndex = 0
$script:StepTotal = 0
$script:Quiet = $false
$script:ApiKey = $null
$script:StepFacts = $null
$script:StartedAt = [DateTime]::UtcNow
$script:Results = [System.Collections.Generic.List[pscustomobject]]::new()
$script:ManualActions = [System.Collections.Generic.List[string]]::new()

#region Console output

function Write-Banner {
    param([string] $Text)
    if ($script:Quiet) { return }
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
    Write-Host " $Text" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkCyan
}

function Write-StepHeader {
    param([pscustomobject] $Step)
    $script:StepIndex++
    $percent = if ($script:StepTotal -gt 0) { [int](100 * ($script:StepIndex - 1) / $script:StepTotal) } else { 0 }
    Write-Progress -Activity 'Segment Preview provisioning' -Status $Step.Name -PercentComplete $percent
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $script:StepIndex, $script:StepTotal, $Step.Name) -ForegroundColor White
    Write-Host ("       phase: {0} | step id: {1}" -f $Step.Phase, $Step.Id) -ForegroundColor DarkGray
}

function Write-Detail {
    param([string] $Message)
    Write-Host "       $Message" -ForegroundColor Gray
}

function Write-Ok {
    param([string] $Message)
    Write-Host "   ok  $Message" -ForegroundColor Green
}

function Write-Skipped {
    param([string] $Message)
    Write-Host "  skip $Message" -ForegroundColor DarkYellow
}

function Write-Manual {
    param([string] $Message)
    $script:ManualActions.Add($Message) | Out-Null
    Write-Host " admin $Message" -ForegroundColor Yellow
}

function Add-Result {
    param(
        [string] $StepId,
        [string] $Status,
        [string] $Message,
        [timespan] $Duration = [timespan]::Zero
    )

    $script:Results.Add([pscustomobject]@{
            Step     = $StepId
            Status   = $Status
            Duration = Format-SegmentPreviewDuration -Duration $Duration
            Message  = $Message
        }) | Out-Null
}

#endregion

#region External process helpers

function Invoke-ExternalCommand {
    <#
    .SYNOPSIS
    Runs a native executable and returns stdout, failing loudly on a non-zero exit.
    #>
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [switch] $AllowFailure,
        [string] $RedactValue
    )

    $stdout = [System.Collections.Generic.List[string]]::new()
    $stderr = [System.Collections.Generic.List[string]]::new()

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $stderr.Add([string] $_) | Out-Null
            }
            else {
                $stdout.Add([string] $_) | Out-Null
            }
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $detail = (($stderr + $stdout) -join [Environment]::NewLine)
        if ($RedactValue) { $detail = $detail.Replace($RedactValue, '***') }
        throw "'$FilePath $($Arguments[0])' failed with exit code $exitCode.$([Environment]::NewLine)$detail"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = ($stdout -join [Environment]::NewLine)
        Error    = ($stderr -join [Environment]::NewLine)
    }
}

function Invoke-AzJson {
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [switch] $AllowFailure,
        [string] $RedactValue
    )

    $result = Invoke-ExternalCommand -FilePath 'az' -Arguments ($Arguments + @('--output', 'json')) `
        -AllowFailure:$AllowFailure -RedactValue $RedactValue
    if ($result.ExitCode -ne 0) {
        return $null
    }
    if ([string]::IsNullOrWhiteSpace($result.Output)) {
        return $null
    }

    return ($result.Output | ConvertFrom-Json)
}

function Get-AccessToken {
    param([Parameter(Mandatory)] [string] $Resource)

    $cacheKey = $Resource.ToLowerInvariant()
    if ($script:TokenCache.ContainsKey($cacheKey) -and
        $script:TokenCache[$cacheKey].Expires -gt [DateTime]::UtcNow.AddMinutes(5)) {
        return $script:TokenCache[$cacheKey].Token
    }

    $result = Invoke-ExternalCommand -FilePath 'az' -Arguments @(
        'account', 'get-access-token', '--resource', $Resource, '--output', 'json'
    ) -AllowFailure
    if ($result.ExitCode -ne 0) {
        throw "An access token for '$Resource' could not be acquired. $($result.Error)"
    }

    $token = $result.Output | ConvertFrom-Json
    $expiry = [DateTime]::UtcNow.AddMinutes(50)
    $script:TokenCache[$cacheKey] = [pscustomobject]@{ Token = $token.accessToken; Expires = $expiry }
    return $token.accessToken
}

#endregion

#region REST helpers

function Invoke-RestApi {
    <#
    .SYNOPSIS
    Issues a REST call with retry, throttling support, and Fabric LRO polling.
    #>
    param(
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [string] $Resource,
        [object] $Body,
        [hashtable] $ExtraHeader,
        [int] $MaxAttempts = 5,
        [int[]] $SuccessStatus = @(200, 201, 202, 204),
        [int[]] $TolerateStatus = @()
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $headers = @{ Authorization = "Bearer $(Get-AccessToken -Resource $Resource)" }
        if ($ExtraHeader) {
            foreach ($key in $ExtraHeader.Keys) { $headers[$key] = $ExtraHeader[$key] }
        }

        $parameters = @{
            Method             = $Method
            Uri                = $Uri
            Headers            = $headers
            SkipHttpErrorCheck = $true
            ErrorAction        = 'Stop'
        }
        if ($null -ne $Body) {
            $parameters['Body'] = if ($Body -is [string]) { $Body } else { ($Body | ConvertTo-Json -Depth 20 -Compress) }
            $parameters['ContentType'] = 'application/json; charset=utf-8'
        }

        $response = Invoke-WebRequest @parameters
        $status = [int] $response.StatusCode

        if ($status -eq 429 -or $status -ge 500) {
            if ($attempt -eq $MaxAttempts) {
                throw "$Method $Uri failed with HTTP $status after $MaxAttempts attempts. $($response.Content)"
            }
            $wait = 2 * [Math]::Pow(2, $attempt - 1)
            if ($response.Headers.ContainsKey('Retry-After')) {
                $parsed = 0
                if ([int]::TryParse(($response.Headers['Retry-After'] | Select-Object -First 1), [ref] $parsed)) {
                    $wait = [Math]::Max($wait, $parsed)
                }
            }
            Write-Detail "HTTP $status received, retrying in $wait s (attempt $attempt/$MaxAttempts)."
            Start-Sleep -Seconds $wait
            continue
        }

        if ($TolerateStatus -contains $status) {
            return [pscustomobject]@{ StatusCode = $status; Content = $response.Content; Tolerated = $true }
        }

        if ($SuccessStatus -notcontains $status) {
            throw "$Method $Uri failed with HTTP $status. $($response.Content)"
        }

        if ($status -eq 202 -and $response.Headers.ContainsKey('Location')) {
            return (Wait-FabricOperation -Location ($response.Headers['Location'] | Select-Object -First 1) -Resource $Resource)
        }

        if ([string]::IsNullOrWhiteSpace($response.Content)) {
            return $null
        }

        return ($response.Content | ConvertFrom-Json)
    }
}

function Wait-FabricOperation {
    param(
        [Parameter(Mandatory)] [string] $Location,
        [Parameter(Mandatory)] [string] $Resource,
        [int] $TimeoutSeconds = 900
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 5
        $headers = @{ Authorization = "Bearer $(Get-AccessToken -Resource $Resource)" }
        $response = Invoke-WebRequest -Method Get -Uri $Location -Headers $headers -SkipHttpErrorCheck -ErrorAction Stop
        $status = [int] $response.StatusCode
        if ($status -ge 400) {
            throw "The Fabric long-running operation failed with HTTP $status. $($response.Content)"
        }

        $payload = if ([string]::IsNullOrWhiteSpace($response.Content)) { $null } else { $response.Content | ConvertFrom-Json }
        $state = if ($payload -and $payload.PSObject.Properties['status']) { [string] $payload.status } else { 'Succeeded' }

        switch ($state) {
            'Succeeded' {
                $resultUri = "$($Location.TrimEnd('/'))/result"
                $result = Invoke-WebRequest -Method Get -Uri $resultUri -Headers $headers -SkipHttpErrorCheck -ErrorAction Stop
                if ([int] $result.StatusCode -lt 400 -and -not [string]::IsNullOrWhiteSpace($result.Content)) {
                    return ($result.Content | ConvertFrom-Json)
                }
                return $payload
            }
            'Failed' {
                throw "The Fabric long-running operation failed. $($response.Content)"
            }
            default { Write-Detail "Fabric operation state: $state" }
        }
    }

    throw "The Fabric long-running operation did not complete within $TimeoutSeconds seconds."
}

function Invoke-FabricApi {
    param(
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [string] $Path,
        [object] $Body,
        [int[]] $TolerateStatus = @()
    )

    $uri = if ($Path -match '^https://') { $Path } else { "$script:FabricApiRoot/$($Path.TrimStart('/'))" }
    return Invoke-RestApi -Method $Method -Uri $uri -Resource $script:FabricResource -Body $Body -TolerateStatus $TolerateStatus
}

function Get-FabricCollection {
    <#
    .SYNOPSIS
    Reads a paged Fabric collection completely.
    #>
    param([Parameter(Mandatory)] [string] $Path)

    $items = [System.Collections.Generic.List[object]]::new()
    $next = $Path
    $guard = 0
    while ($next -and $guard -lt 100) {
        $guard++
        $page = Invoke-FabricApi -Method Get -Path $next
        if ($page -and $page.PSObject.Properties['value'] -and $page.value) {
            foreach ($item in $page.value) { $items.Add($item) | Out-Null }
        }

        $next = $null
        if ($page -and $page.PSObject.Properties['continuationUri'] -and $page.continuationUri) {
            $next = [string] $page.continuationUri
        }
        elseif ($page -and $page.PSObject.Properties['continuationToken'] -and $page.continuationToken) {
            $separator = if ($Path.Contains('?')) { '&' } else { '?' }
            $next = "$Path$separator" + 'continuationToken=' + [Uri]::EscapeDataString([string] $page.continuationToken)
        }
    }

    return $items.ToArray()
}

function Invoke-DataverseApi {
    param(
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [string] $Path,
        [object] $Body,
        [hashtable] $ExtraHeader
    )

    $uri = if ($Path -match '^https://') { $Path } else { "$script:DataverseApiRoot$($Path.TrimStart('/'))" }
    $headers = @{
        'OData-MaxVersion' = '4.0'
        'OData-Version'    = '4.0'
        'Accept'           = 'application/json'
    }
    if ($ExtraHeader) {
        foreach ($key in $ExtraHeader.Keys) { $headers[$key] = $ExtraHeader[$key] }
    }

    return Invoke-RestApi -Method $Method -Uri $uri -Resource $script:DataverseResource -Body $Body -ExtraHeader $headers
}

#endregion

#region Configuration

function Resolve-Configuration {
    param(
        # The caller passes the script's own $PSBoundParameters; inside a
        # function $PSBoundParameters would only describe the function call.
        [Parameter(Mandatory)]
        [object] $BoundParameter
    )

    $configuration = $null
    if ($ConfigFile) {
        $path = (Resolve-Path -LiteralPath $ConfigFile).ProviderPath
        $configuration = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Detail "Configuration file: $path"
    }

    $ignored = @(
        'ConfigFile', 'BehavioralApiKey', 'RotateApiKey', 'FromStep', 'Force',
        'SkipFabric', 'SkipAzure', 'SkipDataverse', 'SkipApiDeployment', 'SkipNotebook',
        'ConsentReportOnly', 'NonInteractive'
    ) + [System.Management.Automation.PSCmdlet]::CommonParameters +
        [System.Management.Automation.PSCmdlet]::OptionalCommonParameters

    $bound = @{}
    foreach ($key in $BoundParameter.Keys) {
        if ($ignored -contains $key) { continue }
        $bound[$key] = $BoundParameter[$key]
    }

    $defaults = @{
        Location                   = 'westeurope'
        FabricServingLakehouseName = 'SegmentPreviewServing'
        FabricDataverseDeltaFolder = 'deltalake'
        ResourceGroup              = 'rg-segment-preview'
    }

    return Merge-SegmentPreviewConfiguration -Configuration $configuration -BoundParameter $bound -Default $defaults
}

function Get-ConfigValue {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [object] $Fallback = $null
    )

    if ($script:Config.ContainsKey($Name) -and $null -ne $script:Config[$Name]) {
        $value = $script:Config[$Name]
        if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) { return $Fallback }
        return $value
    }

    return $Fallback
}

function Set-ConfigValue {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [object] $Value
    )

    $script:Config[$Name] = $Value
}

# Facts are the non-secret values a step discovered. They are stored in the
# state file under a camelCase name so that a resumed run can put them back into
# the configuration instead of letting later steps read a null.
$script:FactConfigName = [ordered]@{
    fabricWorkspaceId           = 'FabricWorkspaceId'
    fabricWorkspaceName         = 'FabricWorkspaceName'
    fabricServingLakehouseId    = 'FabricServingLakehouseId'
    fabricServingLakehouseName  = 'FabricServingLakehouseName'
    fabricSqlServer             = 'FabricSqlServer'
    fabricSqlDatabase           = 'FabricSqlDatabase'
    fabricDataverseLakehouseId  = 'FabricDataverseLakehouseId'
    fabricCapacityResourceId    = 'FabricCapacityResourceId'
    fabricDataverseConnectionId = 'FabricDataverseConnectionId'
    fabricNotebookId            = 'FabricNotebookId'
    apiBaseUrl                  = 'ApiBaseUrl'
    managedIdentityPrincipalId  = 'ManagedIdentityPrincipalId'
    resourceGroup               = 'ResourceGroup'
    webAppName                  = 'WebAppName'
}

function Get-StepFactSnapshot {
    param([Parameter(Mandatory)] [string[]] $Name)

    $facts = @{}
    foreach ($entry in $script:FactConfigName.GetEnumerator()) {
        if ($Name -notcontains $entry.Value) { continue }
        $value = Get-ConfigValue -Name $entry.Value
        if ($null -ne $value -and -not ([string]::IsNullOrWhiteSpace([string] $value))) {
            $facts[$entry.Key] = [string] $value
        }
    }

    return $facts
}

<#
.SYNOPSIS
    Puts the facts an earlier run recorded back into the live configuration.
.DESCRIPTION
    A resumed run skips the handler that discovered a value, so without this the
    later steps would read a null and either fail late or silently write an empty
    setting. Explicit parameters always win over a stored fact.
#>
function Restore-SegmentPreviewFact {
    param([hashtable] $Fact)

    $restored = [System.Collections.Generic.List[string]]::new()
    if (-not $Fact) { return $restored }

    foreach ($entry in $script:FactConfigName.GetEnumerator()) {
        if (-not $Fact.ContainsKey($entry.Key)) { continue }
        $value = [string] $Fact[$entry.Key]
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        if (Get-ConfigValue -Name $entry.Value) { continue }
        Set-ConfigValue -Name $entry.Value -Value $value
        $restored.Add($entry.Value) | Out-Null
    }

    return $restored
}

#endregion

#region Steps

function Step-Preflight {
    $missing = [System.Collections.Generic.List[string]]::new()

    foreach ($tool in @('az', 'dotnet')) {
        $command = Get-Command $tool -ErrorAction SilentlyContinue
        if ($command) {
            Write-Detail "$tool -> $($command.Source)"
        }
        else {
            $missing.Add($tool) | Out-Null
        }
    }

    if ($missing.Count -gt 0) {
        throw "Required tooling is missing: $($missing -join ', '). Install the Azure CLI and the .NET 8 SDK, then re-run."
    }

    if ($PSVersionTable.PSVersion -lt [version]'7.2') {
        throw "PowerShell 7.2 or newer is required, but $($PSVersionTable.PSVersion) is running."
    }

    $environmentUrl = Get-ConfigValue -Name 'DataverseEnvironmentUrl'
    if (-not $environmentUrl) {
        throw 'DataverseEnvironmentUrl is required. Pass -DataverseEnvironmentUrl or set it in the configuration file.'
    }

    $script:EnvironmentDomain = ConvertTo-SegmentPreviewEnvironmentDomain -EnvironmentUrl $environmentUrl
    $script:DataverseApiRoot = ConvertTo-SegmentPreviewDataverseApiRoot -EnvironmentUrl $environmentUrl
    $script:DataverseResource = "https://$script:EnvironmentDomain"
    Write-Detail "Dataverse environment: $script:EnvironmentDomain"

    $webAppName = Get-ConfigValue -Name 'WebAppName'
    if (-not $SkipAzure) {
        if (-not $webAppName) {
            throw 'WebAppName is required unless -SkipAzure is used.'
        }
        if (-not (Test-SegmentPreviewWebAppName -Name $webAppName)) {
            throw "'$webAppName' is not a valid Web App name. Use 2-40 lower-case letters, digits, and single hyphens."
        }
        Write-Detail "Azure Web App: $webAppName"
    }

    $tables = Get-SegmentPreviewRequiredTables -Value (Get-ConfigValue -Name 'RequiredDataverseTables')
    Set-ConfigValue -Name 'RequiredDataverseTables' -Value ($tables -join ',')
    Write-Detail "Required Dataverse shortcuts: $($tables -join ', ')"

    $packagePath = Get-ConfigValue -Name 'SolutionPackagePath' `
        -Fallback (Join-Path $PSScriptRoot 'dataverse\CustomerInsightsSegmentPreview_managed.zip')
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw "The managed solution package '$packagePath' was not found."
    }

    $script:SolutionManifest = Get-SegmentPreviewSolutionManifest -Path $packagePath
    Set-ConfigValue -Name 'SolutionPackagePath' -Value $script:SolutionManifest.Path
    Write-Detail ("Solution package: {0} {1} (managed: {2})" -f
        $script:SolutionManifest.UniqueName, $script:SolutionManifest.Version, $script:SolutionManifest.IsManaged)

    foreach ($guidName in @('FabricWorkspaceId', 'FabricServingLakehouseId', 'FabricDataverseLakehouseId',
            'FabricDataverseConnectionId', 'FabricCapacityId', 'SubscriptionId')) {
        $value = Get-ConfigValue -Name $guidName
        if ($value -and -not (Test-SegmentPreviewGuid -Value $value)) {
            throw "$guidName must be a GUID, but '$value' was supplied."
        }
    }
    $capacityResourceId = Get-ConfigValue -Name 'FabricCapacityResourceId'
    if ($capacityResourceId -and
        $capacityResourceId -notmatch '^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft\.Fabric/capacities/[^/]+/?$') {
        throw 'FabricCapacityResourceId must be the full Azure resource ID of a Microsoft.Fabric capacity.'
    }

    return 'Tooling, inputs, and packages validated.'
}

function Step-SignIn {
    $account = Invoke-AzJson -Arguments @('account', 'show') -AllowFailure
    if (-not $account) {
        if ($NonInteractive) {
            throw 'No Azure CLI session exists and -NonInteractive was requested. Run "az login" first.'
        }

        Write-Manual 'Interactive Azure sign-in is required. A browser or device-code prompt follows.'
        if ($PSCmdlet.ShouldProcess('Azure CLI', 'az login')) {
            Invoke-ExternalCommand -FilePath 'az' -Arguments @('login', '--output', 'none') | Out-Null
        }
        $account = Invoke-AzJson -Arguments @('account', 'show')
    }

    $subscriptionId = Get-ConfigValue -Name 'SubscriptionId'
    if ($subscriptionId -and $account.id -ne $subscriptionId) {
        Invoke-ExternalCommand -FilePath 'az' -Arguments @('account', 'set', '--subscription', $subscriptionId) | Out-Null
        $account = Invoke-AzJson -Arguments @('account', 'show')
    }

    Set-ConfigValue -Name 'SubscriptionId' -Value $account.id
    Set-ConfigValue -Name 'TenantId' -Value $account.tenantId
    Write-Detail "Subscription: $($account.name) ($($account.id))"
    Write-Detail "Signed in as: $($account.user.name)"

    return "Signed in to subscription $($account.name)."
}

function Step-FabricDiscovery {
    if ($SkipFabric) {
        Write-Skipped 'Fabric discovery skipped by request.'
        return 'Skipped.'
    }

    try {
        Get-AccessToken -Resource $script:FabricResource | Out-Null
    }
    catch {
        Write-Manual 'A Fabric access token could not be acquired. Confirm the Azure CLI consent for the Fabric API.'
        throw
    }

    $workspaceId = Get-ConfigValue -Name 'FabricWorkspaceId'
    $workspaceName = Get-ConfigValue -Name 'FabricWorkspaceName'
    $workspaces = Get-FabricCollection -Path 'workspaces'
    Write-Detail "$($workspaces.Count) accessible Fabric workspace(s) discovered."

    $workspace = $null
    if ($workspaceId) {
        $workspace = $workspaces | Where-Object { $_.id -eq $workspaceId } | Select-Object -First 1
        if (-not $workspace) {
            throw "The Fabric workspace '$workspaceId' is not accessible with the signed-in identity."
        }
    }
    elseif ($workspaceName) {
        $workspace = $workspaces | Where-Object { $_.displayName -eq $workspaceName } | Select-Object -First 1
    }
    else {
        throw 'Provide -FabricWorkspaceId or -FabricWorkspaceName, or use -SkipFabric with explicit Fabric identifiers.'
    }

    if (-not $workspace) {
        $capacityId = Get-ConfigValue -Name 'FabricCapacityId'
        if (-not $capacityId) {
            Write-Manual "The Fabric workspace '$workspaceName' does not exist and no -FabricCapacityId was provided. Create the workspace on a Fabric capacity, or re-run with -FabricCapacityId."
            throw "The Fabric workspace '$workspaceName' was not found."
        }

        if ($PSCmdlet.ShouldProcess("Fabric workspace '$workspaceName'", 'Create')) {
            $workspace = Invoke-FabricApi -Method Post -Path 'workspaces' -Body @{
                displayName = $workspaceName
                capacityId  = $capacityId
            }
            Write-Ok "Fabric workspace '$workspaceName' created."
        }
    }
    else {
        Write-Detail "Fabric workspace: $($workspace.displayName) ($($workspace.id))"
    }

    if (-not $workspace) {
        return "Fabric workspace '$workspaceName' would be created (WhatIf); discovery stopped."
    }

    Set-ConfigValue -Name 'FabricWorkspaceId' -Value $workspace.id
    Set-ConfigValue -Name 'FabricWorkspaceName' -Value $workspace.displayName

    $capacityResourceId = Get-ConfigValue -Name 'FabricCapacityResourceId'
    if (-not $capacityResourceId) {
        $workspaceCapacityId = if ($workspace.PSObject.Properties['capacityId']) {
            [string] $workspace.capacityId
        }
        else {
            Get-ConfigValue -Name 'FabricCapacityId'
        }
        $fabricCapacity = Get-FabricCollection -Path 'capacities' |
            Where-Object { ([string] $_.id) -eq $workspaceCapacityId } |
            Select-Object -First 1
        if (-not $fabricCapacity) {
            throw "The Fabric capacity '$workspaceCapacityId' could not be read."
        }
        $subscriptionId = Get-ConfigValue -Name 'SubscriptionId'
        $armCapacities = Invoke-AzJson -Arguments @(
            'rest', '--method', 'get', '--url',
            "https://management.azure.com/subscriptions/$subscriptionId/providers/Microsoft.Fabric/capacities?api-version=2023-11-01"
        )
        $matches = @($armCapacities.value | Where-Object {
            ([string] $_.name) -eq ([string] $fabricCapacity.displayName)
        })
        if ($matches.Count -ne 1) {
            throw "The Azure resource for Fabric capacity '$($fabricCapacity.displayName)' could not be resolved uniquely. Supply -FabricCapacityResourceId."
        }
        $capacityResourceId = [string] $matches[0].id
        Set-ConfigValue -Name 'FabricCapacityResourceId' -Value $capacityResourceId
    }

    $lakehouses = Get-FabricCollection -Path "workspaces/$($workspace.id)/lakehouses"
    $servingId = Get-ConfigValue -Name 'FabricServingLakehouseId'
    $servingName = Get-ConfigValue -Name 'FabricServingLakehouseName'

    $serving = $null
    if ($servingId) {
        $serving = $lakehouses | Where-Object { $_.id -eq $servingId } | Select-Object -First 1
        if (-not $serving) {
            throw "The serving lakehouse '$servingId' does not exist in workspace '$($workspace.displayName)'."
        }
    }
    else {
        $serving = $lakehouses | Where-Object { $_.displayName -eq $servingName } | Select-Object -First 1
    }

    if (-not $serving) {
        if ($PSCmdlet.ShouldProcess("Fabric lakehouse '$servingName'", 'Create')) {
            $serving = Invoke-FabricApi -Method Post -Path "workspaces/$($workspace.id)/lakehouses" -Body @{
                displayName = $servingName
                description = 'Serving lakehouse for the Customer Insights Segment Preview.'
            }
            Write-Ok "Serving lakehouse '$servingName' created."
        }
    }

    if (-not $serving) {
        if ($WhatIfPreference) {
            return "Serving lakehouse '$servingName' would be created (WhatIf); discovery stopped."
        }
        throw "The serving lakehouse '$servingName' could not be resolved."
    }

    Set-ConfigValue -Name 'FabricServingLakehouseId' -Value $serving.id
    Set-ConfigValue -Name 'FabricServingLakehouseName' -Value $serving.displayName
    Write-Detail "Serving lakehouse: $($serving.displayName) ($($serving.id))"

    $details = Invoke-FabricApi -Method Get -Path "workspaces/$($workspace.id)/lakehouses/$($serving.id)"
    $sqlEndpoint = $null
    if ($details -and $details.PSObject.Properties['properties'] -and $details.properties -and
        $details.properties.PSObject.Properties['sqlEndpointProperties']) {
        $sqlEndpoint = $details.properties.sqlEndpointProperties
    }

    if (-not $sqlEndpoint -or -not $sqlEndpoint.connectionString) {
        Write-Manual "The SQL analytics endpoint of '$($serving.displayName)' is still provisioning. Re-run the same command once it reports 'Success' in the Fabric portal."
        throw 'The Fabric SQL analytics endpoint is not available yet.'
    }

    Set-ConfigValue -Name 'FabricSqlServer' -Value (ConvertTo-SegmentPreviewFabricSqlServer -ConnectionString $sqlEndpoint.connectionString)
    Set-ConfigValue -Name 'FabricSqlDatabase' -Value ([string] $sqlEndpoint.id)
    Write-Detail "Fabric SQL endpoint: $(Get-ConfigValue -Name 'FabricSqlServer')"

    $mirrorId = Get-ConfigValue -Name 'FabricDataverseLakehouseId'
    $mirrorName = Get-ConfigValue -Name 'FabricDataverseLakehouseName'
    if (-not $mirrorId -and $mirrorName) {
        $mirror = $lakehouses | Where-Object { $_.displayName -eq $mirrorName } | Select-Object -First 1
        if ($mirror) { $mirrorId = $mirror.id }
    }
    if (-not $mirrorId) {
        $mirror = $lakehouses |
            Where-Object { $_.id -ne $serving.id -and $_.displayName -match '(?i)dataverse' } |
            Select-Object -First 1
        if ($mirror) {
            $mirrorId = $mirror.id
            Write-Detail "Dataverse mirror lakehouse detected by name: $($mirror.displayName)"
        }
    }
    if ($mirrorId) {
        Set-ConfigValue -Name 'FabricDataverseLakehouseId' -Value $mirrorId
    }
    else {
        Write-Manual 'The Dataverse mirror lakehouse was not found. Enable "Link to Microsoft Fabric" in the Power Platform maker portal, then re-run the same command or pass -FabricDataverseLakehouseId.'
    }

    $connectionId = Get-ConfigValue -Name 'FabricDataverseConnectionId'
    if (-not $connectionId) {
        $connections = @()
        try {
            $connections = Get-FabricCollection -Path 'connections'
        }
        catch {
            Write-Detail "The Fabric connections could not be listed: $($_.Exception.Message)"
        }

        $connection = Select-SegmentPreviewDataverseConnection -Connection $connections -EnvironmentDomain $script:EnvironmentDomain
        if ($connection) {
            $connectionId = $connection.id
            Write-Detail "Dataverse cloud connection: $($connection.displayName) ($connectionId)"
            Set-ConfigValue -Name 'FabricDataverseConnectionId' -Value $connectionId
        }
        else {
            Write-Manual "No Fabric cloud connection for '$script:EnvironmentDomain' exists. Create a Dataverse connection in the Fabric portal (Settings > Manage connections and gateways), then re-run the same command or pass -FabricDataverseConnectionId."
        }
    }

    $script:StepFacts = Get-StepFactSnapshot -Name @(
        'FabricWorkspaceId', 'FabricWorkspaceName', 'FabricServingLakehouseId', 'FabricServingLakehouseName',
        'FabricSqlServer', 'FabricSqlDatabase', 'FabricDataverseLakehouseId', 'FabricDataverseConnectionId',
        'FabricCapacityResourceId')

    return "Fabric workspace '$($workspace.displayName)' and serving lakehouse resolved."
}

function Step-FabricNotebook {
    if ($SkipFabric -or $SkipNotebook) {
        Write-Skipped 'Bootstrap notebook publication skipped by request.'
        return 'Skipped.'
    }

    $workspaceId = Get-ConfigValue -Name 'FabricWorkspaceId'
    $servingId = Get-ConfigValue -Name 'FabricServingLakehouseId'
    $mirrorId = Get-ConfigValue -Name 'FabricDataverseLakehouseId'
    if (-not $workspaceId -or -not $servingId) {
        Write-Skipped 'The workspace or serving lakehouse is unknown; the notebook is not published.'
        return 'Skipped.'
    }

    if (-not $mirrorId) {
        Write-Manual 'The bootstrap notebook is published without a Dataverse mirror lakehouse id. Re-run this step after "Link to Microsoft Fabric" is enabled.'
        $mirrorId = '00000000-0000-0000-0000-000000000000'
    }

    $notebookSource = Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'Fabric\bootstrap-events.py') -Raw -Encoding UTF8
    $parameterized = Set-SegmentPreviewNotebookParameter -Source $notebookSource -Parameter @{
        WORKSPACE_ID           = $workspaceId
        SERVING_LAKEHOUSE_ID   = $servingId
        DATAVERSE_LAKEHOUSE_ID = $mirrorId
        REQUIRED_DATAVERSE_TABLES = Get-ConfigValue -Name 'RequiredDataverseTables'
    }
    if ($parameterized.Missing.Count -gt 0) {
        throw "The bootstrap notebook does not declare: $($parameterized.Missing -join ', ')."
    }

    $platform = Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'Fabric\bootstrap-events.platform.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $displayName = [string] $platform.metadata.displayName
    $description = [string] $platform.metadata.description

    $payload = [Convert]::ToBase64String(
        [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-SegmentPreviewNotebookIpynb -Source $parameterized.Content)))
    $definition = @{
        format = 'ipynb'
        parts  = @(
            @{ path = 'notebook-content.ipynb'; payload = $payload; payloadType = 'InlineBase64' }
        )
    }

    $notebooks = Get-FabricCollection -Path "workspaces/$workspaceId/notebooks"
    $existing = $notebooks | Where-Object { $_.displayName -eq $displayName } | Select-Object -First 1
    $notebookId = $null

    if ($existing) {
        if ($PSCmdlet.ShouldProcess("Fabric notebook '$displayName'", 'Update definition')) {
            Invoke-FabricApi -Method Post `
                -Path "workspaces/$workspaceId/notebooks/$($existing.id)/updateDefinition?updateMetadata=true" `
                -Body @{ definition = $definition } | Out-Null
            Write-Ok "Bootstrap notebook '$displayName' updated."
        }
        $notebookId = $existing.id
    }
    else {
        if ($PSCmdlet.ShouldProcess("Fabric notebook '$displayName'", 'Create')) {
            $created = Invoke-FabricApi -Method Post -Path "workspaces/$workspaceId/notebooks" -Body @{
                displayName = $displayName
                description = $description
                definition  = $definition
            }
            $notebookId = $created.id
            Write-Ok "Bootstrap notebook '$displayName' created."
        }
    }

    if (-not $notebookId) {
        return 'Notebook not published (WhatIf).'
    }

    Set-ConfigValue -Name 'FabricNotebookId' -Value $notebookId
    $script:StepFacts = Get-StepFactSnapshot -Name @('FabricNotebookId')

    $scheduleFile = Join-Path $script:RepositoryRoot 'Fabric\bootstrap-events.schedules.json'
    $schedule = (Get-Content -LiteralPath $scheduleFile -Raw -Encoding UTF8 | ConvertFrom-Json).schedules | Select-Object -First 1
    if (-not $schedule) {
        return "Bootstrap notebook '$displayName' published without a schedule."
    }

    $existingSchedules = @()
    try {
        $existingSchedules = Get-FabricCollection -Path "workspaces/$workspaceId/items/$notebookId/jobs/Execute/schedules"
    }
    catch {
        Write-Detail "Existing notebook schedules could not be read: $($_.Exception.Message)"
    }

    if ($existingSchedules.Count -gt 0) {
        Write-Skipped "The notebook already has $($existingSchedules.Count) schedule(s); no new schedule is created."
        return "Bootstrap notebook '$displayName' published; existing schedule kept."
    }

    if ($PSCmdlet.ShouldProcess("Fabric notebook '$displayName'", 'Create daily schedule')) {
        $configuration = @{
            type             = [string] $schedule.configuration.type
            startDateTime    = [string] $schedule.configuration.startDateTime
            endDateTime      = [string] $schedule.configuration.endDateTime
            localTimeZoneId  = [string] $schedule.configuration.localTimeZoneId
            times            = @($schedule.configuration.times)
        }
        Invoke-FabricApi -Method Post `
            -Path "workspaces/$workspaceId/items/$notebookId/jobs/Execute/schedules" `
            -Body @{ enabled = $true; configuration = $configuration } | Out-Null
        Write-Ok 'Daily bootstrap schedule created.'
    }

    return "Bootstrap notebook '$displayName' published and scheduled."
}

function Step-Secret {
    if ($SkipAzure -and -not $BehavioralApiKey) {
        Write-Skipped 'Azure is skipped; the existing API key must be supplied through -BehavioralApiKey.'
        return 'Skipped.'
    }

    if ($BehavioralApiKey) {
        $script:ApiKey = [System.Net.NetworkCredential]::new('', $BehavioralApiKey).Password
        Write-Detail 'Using the API key supplied through -BehavioralApiKey.'
    }
    elseif (-not $RotateApiKey) {
        $existing = Invoke-AzJson -Arguments @(
            'webapp', 'config', 'appsettings', 'list',
            '--resource-group', (Get-ConfigValue -Name 'ResourceGroup'),
            '--name', (Get-ConfigValue -Name 'WebAppName')
        ) -AllowFailure
        if ($existing) {
            $setting = $existing | Where-Object { $_.name -eq 'BEHAVIORAL_API_KEY' } | Select-Object -First 1
            if ($setting -and -not [string]::IsNullOrWhiteSpace($setting.value)) {
                $script:ApiKey = [string] $setting.value
                Write-Detail 'Reusing the API key already configured on the Web App.'
            }
        }
    }

    if (-not $script:ApiKey) {
        $script:ApiKey = New-SegmentPreviewApiKey
        Write-Detail 'A new 384-bit API key was generated with the operating system CSPRNG.'
    }

    $fingerprint = Get-SegmentPreviewFingerprint -Value $script:ApiKey
    Write-Detail "API key fingerprint: $fingerprint"
    $script:StepFacts = @{ apiKeyFingerprint = $fingerprint }
    return 'Server-side API key resolved.'
}

function Step-AzureInfrastructure {
    if ($SkipAzure) {
        Write-Skipped 'Azure deployment skipped by request.'
        return 'Skipped.'
    }

    $resourceGroup = Get-ConfigValue -Name 'ResourceGroup'
    $location = Get-ConfigValue -Name 'Location'
    $webAppName = Get-ConfigValue -Name 'WebAppName'

    $required = @{
        fabricSqlServer              = Get-ConfigValue -Name 'FabricSqlServer'
        fabricSqlDatabase            = Get-ConfigValue -Name 'FabricSqlDatabase'
        fabricWorkspaceId            = Get-ConfigValue -Name 'FabricWorkspaceId'
        fabricServingLakehouseId     = Get-ConfigValue -Name 'FabricServingLakehouseId'
        fabricCapacityResourceId     = Get-ConfigValue -Name 'FabricCapacityResourceId'
        fabricDataverseLakehouseId   = Get-ConfigValue -Name 'FabricDataverseLakehouseId'
        fabricDataverseConnectionId  = Get-ConfigValue -Name 'FabricDataverseConnectionId'
        fabricDataverseDeltaFolder   = Get-ConfigValue -Name 'FabricDataverseDeltaFolder'
        dataverseEnvironmentUrl      = "https://$script:EnvironmentDomain"
    }

    $unresolved = $required.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key }
    if ($unresolved) {
        throw ("The Azure deployment needs values that could not be resolved: {0}. " -f ($unresolved -join ', ')) +
        'Complete the Fabric prerequisites or supply the values explicitly.'
    }

    if ($PSCmdlet.ShouldProcess("Resource group '$resourceGroup'", 'Create or update')) {
        Invoke-ExternalCommand -FilePath 'az' -Arguments @(
            'group', 'create', '--name', $resourceGroup, '--location', $location, '--output', 'none'
        ) | Out-Null
    }

    $templateFile = Join-Path $PSScriptRoot 'azure\main.bicep'
    $deploymentName = Get-ConfigValue -Name 'DeploymentName' -Fallback "segment-preview-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"

    $arguments = @(
        'deployment', 'group', 'create',
        '--resource-group', $resourceGroup,
        '--name', $deploymentName,
        '--template-file', $templateFile,
        '--parameters',
        "webAppName=$webAppName",
        "location=$location",
        "fabricSqlServer=$($required.fabricSqlServer)",
        "fabricSqlDatabase=$($required.fabricSqlDatabase)",
        "fabricWorkspaceId=$($required.fabricWorkspaceId)",
        "fabricServingLakehouseId=$($required.fabricServingLakehouseId)",
        "fabricCapacityResourceId=$($required.fabricCapacityResourceId)",
        "fabricDataverseLakehouseId=$($required.fabricDataverseLakehouseId)",
        "fabricDataverseConnectionId=$($required.fabricDataverseConnectionId)",
        "fabricDataverseDeltaFolder=$($required.fabricDataverseDeltaFolder)",
        "dataverseEnvironmentUrl=$($required.dataverseEnvironmentUrl)",
        "requiredDataverseTables=$(Get-ConfigValue -Name 'RequiredDataverseTables')",
        "behavioralApiKey=$script:ApiKey"
    )

    if (-not $PSCmdlet.ShouldProcess("Azure deployment '$deploymentName'", 'Deploy Bicep template')) {
        return 'Azure infrastructure not deployed (WhatIf).'
    }

    Write-Detail "Deploying $templateFile ..."
    $result = Invoke-AzJson -Arguments $arguments -RedactValue $script:ApiKey
    if (-not $result) {
        throw 'The Azure deployment returned no result.'
    }

    $outputs = $result.properties.outputs
    Set-ConfigValue -Name 'ApiBaseUrl' -Value ([string] $outputs.webAppUrl.value)
    Set-ConfigValue -Name 'ManagedIdentityPrincipalId' -Value ([string] $outputs.managedIdentityPrincipalId.value)
    Write-Detail "API base URL: $(Get-ConfigValue -Name 'ApiBaseUrl')"
    Write-Detail "Managed identity principal: $(Get-ConfigValue -Name 'ManagedIdentityPrincipalId')"

    $script:StepFacts = @{
        apiBaseUrl                 = Get-ConfigValue -Name 'ApiBaseUrl'
        managedIdentityPrincipalId = Get-ConfigValue -Name 'ManagedIdentityPrincipalId'
        resourceGroup              = $resourceGroup
        webAppName                 = $webAppName
    }

    return "Azure infrastructure deployed into '$resourceGroup'."
}

function Step-FabricPermissions {
    if ($SkipFabric) {
        Write-Skipped 'Fabric permission assignment skipped by request.'
        return 'Skipped.'
    }

    $workspaceId = Get-ConfigValue -Name 'FabricWorkspaceId'
    $principalId = Get-ConfigValue -Name 'ManagedIdentityPrincipalId'
    if (-not $workspaceId -or -not $principalId) {
        Write-Skipped 'The workspace or managed identity is unknown; no role assignment is attempted.'
        return 'Skipped.'
    }

    $assignments = @()
    try {
        $assignments = Get-FabricCollection -Path "workspaces/$workspaceId/roleAssignments"
    }
    catch {
        Write-Manual "The workspace role assignments of '$workspaceId' could not be read. Grant the managed identity ($principalId) the Contributor role in the Fabric workspace manually. Details: $($_.Exception.Message)"
        return 'Manual role assignment required.'
    }

    $existing = $assignments |
        Where-Object { $_.principal -and ([string] $_.principal.id) -eq $principalId } |
        Select-Object -First 1
    if ($existing) {
        Write-Skipped "The managed identity already holds the '$($existing.role)' workspace role."
    }
    elseif ($PSCmdlet.ShouldProcess("Fabric workspace '$workspaceId'", "Assign Contributor to $principalId")) {
        try {
            Invoke-FabricApi -Method Post -Path "workspaces/$workspaceId/roleAssignments" -Body @{
                principal = @{ id = $principalId; type = 'ServicePrincipal' }
                role      = 'Contributor'
            } | Out-Null
            Write-Ok 'The managed identity was granted the Contributor workspace role.'
        }
        catch {
            Write-Manual "The role assignment failed. Add the managed identity ($principalId) as a workspace Contributor in the Fabric portal, and confirm that the tenant setting 'Service principals can use Fabric APIs' is enabled. Details: $($_.Exception.Message)"
            return 'Manual role assignment required.'
        }
    }

    $capacityResourceId = Get-ConfigValue -Name 'FabricCapacityResourceId'
    if (-not $capacityResourceId) {
        Write-Manual 'The Fabric capacity resource ID is unknown. Supply -FabricCapacityResourceId and install again.'
        return 'Manual capacity permission assignment required.'
    }
    $capacityAssignments = @(Invoke-AzJson -Arguments @(
        'role', 'assignment', 'list',
        '--assignee', $principalId,
        '--scope', $capacityResourceId
    ))
    $capacityAccess = $capacityAssignments | Where-Object {
        $_.roleDefinitionName -in @('Contributor', 'Owner')
    } | Select-Object -First 1
    if ($capacityAccess) {
        Write-Skipped "The managed identity already holds the '$($capacityAccess.roleDefinitionName)' role on the Fabric capacity."
    }
    elseif ($PSCmdlet.ShouldProcess($capacityResourceId, "Assign Contributor to $principalId")) {
        try {
            Invoke-ExternalCommand -FilePath 'az' -Arguments @(
                'role', 'assignment', 'create',
                '--assignee-object-id', $principalId,
                '--assignee-principal-type', 'ServicePrincipal',
                '--role', 'Contributor',
                '--scope', $capacityResourceId,
                '--output', 'none'
            ) | Out-Null
            Write-Ok 'The managed identity can read and start the Fabric capacity.'
        }
        catch {
            Write-Manual "The capacity role assignment failed. Grant the managed identity ($principalId) Contributor on '$capacityResourceId'. Details: $($_.Exception.Message)"
            return 'Manual capacity permission assignment required.'
        }
    }
    return 'Managed identity has workspace access and capacity start permission.'
}

function Step-AzureApp {
    if ($SkipAzure -or $SkipApiDeployment) {
        Write-Skipped 'API build and deployment skipped by request.'
        return 'Skipped.'
    }

    $resourceGroup = Get-ConfigValue -Name 'ResourceGroup'
    $webAppName = Get-ConfigValue -Name 'WebAppName'
    $publishDirectory = Join-Path $script:RepositoryRoot 'artifacts\fabric-api'
    $archivePath = Join-Path $script:RepositoryRoot 'artifacts\fabric-api.zip'

    if (-not $PSCmdlet.ShouldProcess("Web App '$webAppName'", 'Build and deploy the API')) {
        return 'API not deployed (WhatIf).'
    }

    Write-Detail 'Publishing the ASP.NET Core API ...'
    if (Test-Path -LiteralPath $publishDirectory) {
        Remove-Item -LiteralPath $publishDirectory -Recurse -Force
    }
    Invoke-ExternalCommand -FilePath 'dotnet' -Arguments @(
        'publish',
        (Join-Path $script:RepositoryRoot 'FabricApi\CustomerInsightsSegmentSankey.FabricApi.csproj'),
        '--configuration', 'Release',
        '--output', $publishDirectory,
        '--nologo', '--verbosity', 'minimal'
    ) | Out-Null

    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    Compress-Archive -Path (Join-Path $publishDirectory '*') -DestinationPath $archivePath

    Write-Detail 'Uploading the package to App Service ...'
    Invoke-ExternalCommand -FilePath 'az' -Arguments @(
        'webapp', 'deploy',
        '--resource-group', $resourceGroup,
        '--name', $webAppName,
        '--src-path', $archivePath,
        '--type', 'zip',
        '--clean', 'true',
        '--restart', 'true',
        '--output', 'none'
    ) | Out-Null

    $healthUrl = "https://$webAppName.azurewebsites.net/api/health"
    Write-Detail "Waiting for $healthUrl ..."
    $healthy = $false
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            $response = Invoke-WebRequest -Method Get -Uri $healthUrl -SkipHttpErrorCheck -TimeoutSec 30 -ErrorAction Stop
            if ([int] $response.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        }
        catch {
            Write-Debug $_.Exception.Message
        }
        Start-Sleep -Seconds 10
    }

    if (-not $healthy) {
        throw "The health endpoint $healthUrl did not respond with HTTP 200 within about three minutes."
    }

    Write-Ok "The API is healthy at $healthUrl."
    return 'Segment Preview API deployed and healthy.'
}

function Step-DataverseImport {
    if ($SkipDataverse) {
        Write-Skipped 'Dataverse import skipped by request.'
        return 'Skipped.'
    }

    try {
        Get-AccessToken -Resource $script:DataverseResource | Out-Null
    }
    catch {
        Write-Manual "A Dataverse access token for $script:DataverseResource could not be acquired. Approve the one-time Azure CLI consent for Dataverse, then re-run the same command."
        throw
    }

    $manifest = $script:SolutionManifest
    $uniqueName = $manifest.UniqueName
    $installed = Invoke-DataverseApi -Method Get `
        -Path ("solutions?`$select=uniquename,version,ismanaged,friendlyname&`$filter=uniquename eq '$uniqueName'")
    $current = if ($installed -and $installed.value) { $installed.value | Select-Object -First 1 } else { $null }

    $installedVersion = $null
    $installedIsManaged = $true
    if ($current) {
        $installedVersion = [string] $current.version
        $installedIsManaged = [bool] $current.ismanaged
    }

    $action = Resolve-SegmentPreviewSolutionImportAction `
        -InstalledVersion $installedVersion `
        -InstalledIsManaged $installedIsManaged `
        -PackageVersion $manifest.Version `
        -Force:$Force

    switch ($action) {
        'skip' {
            Write-Skipped "Version $($manifest.Version) of '$uniqueName' is already installed."
            return "Solution $uniqueName $($manifest.Version) already installed."
        }
        'conflict' {
            throw "An unmanaged solution '$uniqueName' already exists in this environment. Remove it before importing the managed package."
        }
        'downgrade-blocked' {
            throw "Version $($current.version) of '$uniqueName' is installed, which is newer than the package version $($manifest.Version). Use -Force to import anyway."
        }
    }

    if (-not $PSCmdlet.ShouldProcess("Dataverse solution '$uniqueName'", $action)) {
        return "Solution import not performed (WhatIf, planned action: $action)."
    }

    $customizationFile = [Convert]::ToBase64String([IO.File]::ReadAllBytes($manifest.Path))
    $importJobId = [guid]::NewGuid().ToString()

    if ($action -eq 'upgrade') {
        Write-Detail "Staging and upgrading '$uniqueName' to $($manifest.Version) ..."
        $operationPath = 'StageAndUpgradeAsync'
    }
    else {
        Write-Detail "Importing '$uniqueName' $($manifest.Version) ..."
        $operationPath = 'ImportSolutionAsync'
    }

    $body = @{
        OverwriteUnmanagedCustomizations = $false
        PublishWorkflows                 = $true
        CustomizationFile                = $customizationFile
        ImportJobId                      = $importJobId
        ConvertToManaged                 = $false
        SkipProductUpdateDependencies    = $false
        HoldingSolution                  = $false
    }

    $operation = Invoke-DataverseApi -Method Post -Path $operationPath -Body $body
    $asyncOperationId = if ($operation -and $operation.PSObject.Properties['AsyncOperationId']) {
        [string] $operation.AsyncOperationId
    }
    else {
        $null
    }

    if (-not $asyncOperationId) {
        throw "The Dataverse $operationPath call returned no asynchronous operation id."
    }

    Wait-DataverseAsyncOperation -AsyncOperationId $asyncOperationId -ImportJobId $importJobId
    Write-Ok "Solution '$uniqueName' $($manifest.Version) imported ($action)."

    return "Solution $uniqueName $($manifest.Version) $action completed."
}

function Wait-DataverseAsyncOperation {
    param(
        [Parameter(Mandatory)] [string] $AsyncOperationId,
        [string] $ImportJobId,
        [int] $TimeoutMinutes = 45
    )

    $deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
    $lastProgress = -1
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 10
        $operation = Invoke-DataverseApi -Method Get `
            -Path "asyncoperations($AsyncOperationId)?`$select=statecode,statuscode,friendlymessage,message"

        if ($ImportJobId) {
            try {
                $job = Invoke-DataverseApi -Method Get -Path "importjobs($ImportJobId)?`$select=progress"
                if ($job -and $job.PSObject.Properties['progress'] -and $null -ne $job.progress) {
                    $progress = [int][Math]::Round([double] $job.progress)
                    if ($progress -ne $lastProgress) {
                        $lastProgress = $progress
                        Write-Detail "Import progress: $progress %"
                    }
                }
            }
            catch {
                Write-Debug $_.Exception.Message
            }
        }

        # statecode 3 = Completed
        if ([int] $operation.statecode -eq 3) {
            # statuscode 30 = Succeeded
            if ([int] $operation.statuscode -eq 30) {
                return
            }

            $reason = if ($operation.PSObject.Properties['friendlymessage'] -and $operation.friendlymessage) {
                [string] $operation.friendlymessage
            }
            else {
                [string] $operation.message
            }
            throw "The Dataverse solution import failed (statuscode $($operation.statuscode)): $reason"
        }
    }

    throw "The Dataverse solution import did not complete within $TimeoutMinutes minutes."
}

function Step-DataverseConfiguration {
    if ($SkipDataverse) {
        Write-Skipped 'Dataverse configuration skipped by request.'
        return 'Skipped.'
    }

    $apiBaseUrl = Get-ConfigValue -Name 'ApiBaseUrl'
    if (-not $apiBaseUrl) {
        $webAppName = Get-ConfigValue -Name 'WebAppName'
        if ($webAppName) {
            $apiBaseUrl = ConvertTo-SegmentPreviewApiBaseUrl -HostName "$webAppName.azurewebsites.net"
        }
    }

    if (-not $apiBaseUrl -or -not $script:ApiKey) {
        throw 'The API base URL or the API key is unknown. Run the Azure steps, or pass -BehavioralApiKey.'
    }

    $values = @(
        [pscustomobject]@{ SchemaName = 'klth_FabricBehavioralApiUrl'; Value = $apiBaseUrl; Secret = $false }
        [pscustomobject]@{ SchemaName = 'klth_FabricBehavioralApiKey'; Value = $script:ApiKey; Secret = $true }
        [pscustomobject]@{
            SchemaName = 'klth_BusinessUnitScopingEnabled'
            Value = ([bool](Get-ConfigValue -Name 'BusinessUnitScopingEnabled')).ToString().ToLowerInvariant()
            Secret = $false
        }
    )

    foreach ($item in $values) {
        $definition = Invoke-DataverseApi -Method Get -Path (
            "environmentvariabledefinitions?`$select=environmentvariabledefinitionid,schemaname" +
            "&`$expand=environmentvariabledefinition_environmentvariablevalue(`$select=environmentvariablevalueid,value)" +
            "&`$filter=schemaname eq '$($item.SchemaName)'")

        $record = if ($definition -and $definition.value) { $definition.value | Select-Object -First 1 } else { $null }
        if (-not $record) {
            throw "The environment variable definition '$($item.SchemaName)' does not exist. Import the solution first."
        }

        $existingValues = @()
        if ($record.PSObject.Properties['environmentvariabledefinition_environmentvariablevalue']) {
            $existingValues = @($record.environmentvariabledefinition_environmentvariablevalue)
        }
        $existing = $existingValues | Select-Object -First 1

        $displayValue = if ($item.Secret) { Get-SegmentPreviewFingerprint -Value $item.Value } else { $item.Value }

        if ($existing -and ([string] $existing.value) -eq $item.Value) {
            Write-Skipped "$($item.SchemaName) already has the intended value ($displayValue)."
            continue
        }

        if (-not $PSCmdlet.ShouldProcess("Environment variable '$($item.SchemaName)'", 'Set value')) {
            continue
        }

        if ($existing) {
            Invoke-DataverseApi -Method Patch `
                -Path "environmentvariablevalues($($existing.environmentvariablevalueid))" `
                -Body @{ value = $item.Value } | Out-Null
        }
        else {
            Invoke-DataverseApi -Method Post -Path 'environmentvariablevalues' -Body @{
                value                                     = $item.Value
                'EnvironmentVariableDefinitionId@odata.bind' = "/environmentvariabledefinitions($($record.environmentvariabledefinitionid))"
            } | Out-Null
        }

        Write-Ok "$($item.SchemaName) set to $displayValue."
    }

    if ($PSCmdlet.ShouldProcess('Dataverse customizations', 'Publish all')) {
        Write-Detail 'Publishing all customizations ...'
        try {
            Invoke-DataverseApi -Method Post -Path 'PublishAllXmlAsync' -Body @{} | Out-Null
        }
        catch {
            Invoke-DataverseApi -Method Post -Path 'PublishAllXml' -Body @{} | Out-Null
        }
    }

    return 'Dataverse environment variables configured and customizations published.'
}

function Step-Verify {
    if ($SkipDataverse -and $SkipAzure) {
        Write-Skipped 'Nothing to verify.'
        return 'Skipped.'
    }

    $apiBaseUrl = Get-ConfigValue -Name 'ApiBaseUrl'
    if (-not $apiBaseUrl -or -not $script:ApiKey) {
        Write-Skipped 'The API base URL or key is unknown; the setup status is not queried.'
        return 'Skipped.'
    }

    $statusUri = "$($apiBaseUrl.TrimEnd('/'))/setup/status"
    $response = Invoke-WebRequest -Method Get -Uri $statusUri `
        -Headers @{ 'x-api-key' = $script:ApiKey } -SkipHttpErrorCheck -TimeoutSec 120 -ErrorAction Stop
    if ([int] $response.StatusCode -ne 200) {
        throw "The setup status endpoint returned HTTP $($response.StatusCode). $($response.Content)"
    }

    $status = $response.Content | ConvertFrom-Json
    Write-Host ''
    Write-Host '       Component readiness' -ForegroundColor White
    foreach ($component in $status.components) {
        $colour = switch ($component.state) {
            'ready' { 'Green' }
            'partial' { 'Yellow' }
            'notConfigured' { 'Yellow' }
            default { 'Red' }
        }
        Write-Host ("       {0,-14} {1,-26} {2}" -f $component.state, $component.name, $component.message) -ForegroundColor $colour
        if ($component.state -ne 'ready' -and $component.PSObject.Properties['detail'] -and $component.detail) {
            Write-Host ("       {0,-14} {1}" -f '', $component.detail) -ForegroundColor DarkGray
        }
    }

    if ($status.overallState -ne 'ready') {
        Write-Manual 'The setup center reports components that are not ready. Open Customer Insights - Journeys > Settings > Overview > Segment Preview and follow the listed guidance.'
    }

    Set-ConfigValue -Name 'OverallState' -Value ([string] $status.overallState)
    return "Setup status: $($status.overallState)."
}

#endregion

#region Reporting

function Write-ConsentReport {
    Write-Banner 'Interactive consent and tenant prerequisites'
    foreach ($item in (Get-SegmentPreviewConsentChecklist)) {
        $marker = if ($item.Automatable) { 'automated' } else { 'manual   ' }
        $colour = if ($item.Automatable) { 'Green' } else { 'Yellow' }
        Write-Host ("  [{0}] {1}" -f $marker, $item.Title) -ForegroundColor $colour
        Write-Host ("             role: {0}" -f $item.Role) -ForegroundColor DarkGray
        Write-Host ("             {0}" -f $item.Guidance) -ForegroundColor Gray
    }
}

function Write-Summary {
    Write-Banner 'Provisioning summary'
    $script:Results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

    if ($script:ManualActions.Count -gt 0) {
        Write-Host '  Remaining administrator actions:' -ForegroundColor Yellow
        $index = 1
        foreach ($action in $script:ManualActions) {
            Write-Host ("   {0}. {1}" -f $index, $action) -ForegroundColor Yellow
            $index++
        }
    }
    else {
        Write-Host '  No further administrator action is required.' -ForegroundColor Green
    }

    $elapsed = [DateTime]::UtcNow - $script:StartedAt
    Write-Host ''
    Write-Host ("  Total time: {0}" -f (Format-SegmentPreviewDuration -Duration $elapsed)) -ForegroundColor DarkGray
    Write-Host ("  Resume state: {0}" -f $script:StatePath) -ForegroundColor DarkGray
    if (Get-ConfigValue -Name 'ApiBaseUrl') {
        Write-Host ("  API base URL: {0}" -f (Get-ConfigValue -Name 'ApiBaseUrl')) -ForegroundColor DarkGray
    }
    Write-Host '  Open Customer Insights - Journeys > Settings > Overview > Segment Preview to review the live status.' -ForegroundColor DarkGray
}

function Get-CurrentReleaseIdentity {
    $solutionPath = Get-ConfigValue -Name 'SolutionPackagePath' `
        -Fallback (Join-Path $PSScriptRoot 'dataverse\CustomerInsightsSegmentPreview_managed.zip')
    $paths = @(
        $solutionPath
        $PSCommandPath
        (Join-Path $PSScriptRoot 'azure\main.bicep')
        (Join-Path $PSScriptRoot 'modules\SegmentPreview.Provisioning\SegmentPreview.Provisioning.psm1')
        (Join-Path (Split-Path $PSScriptRoot -Parent) 'CustomerInsightsSegmentSankey.csproj')
    )
    $paths += @(Get-ChildItem -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'Fabric') -File)
    $paths += @(Get-ChildItem -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'FabricApi') -File)

    $hashes = @(
        foreach ($path in $paths) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                throw "The release identity cannot be calculated because '$path' is missing."
            }
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    ) | Sort-Object

    $bytes = [Text.Encoding]::UTF8.GetBytes(($hashes -join "`n"))
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

#endregion

#region Main

Write-Banner 'Customer Insights Segment Preview - one-click provisioning'

$script:Config = Resolve-Configuration -BoundParameter $PSBoundParameters

$stateDirectory = Get-ConfigValue -Name 'StateDirectory' -Fallback (Join-Path $PSScriptRoot '.provisioning-state')
$deploymentTarget = Get-ConfigValue -Name 'DeploymentName' -Fallback (
    Get-ConfigValue -Name 'WebAppName' -Fallback (Get-ConfigValue -Name 'ResourceGroup' -Fallback 'segment-preview'))
$script:StatePath = Get-SegmentPreviewStateFilePath -StateDirectory $stateDirectory -DeploymentName $deploymentTarget
$state = Read-SegmentPreviewState -Path $script:StatePath

if ($Force) {
    $state = Reset-SegmentPreviewStateFrom -State $state -StepId 'preflight'
    Write-Detail 'The resume state was cleared because -Force was requested.'
}
elseif ($FromStep) {
    $state = Reset-SegmentPreviewStateFrom -State $state -StepId $FromStep
    Write-Detail "The resume state was cleared from step '$FromStep'."
}

$releaseIdentity = Get-CurrentReleaseIdentity
$storedReleaseIdentity = if ($state.PSObject.Properties['releaseIdentity']) {
    [string] $state.releaseIdentity
}
else {
    ''
}
$hasCompletedSteps = @($state.steps.PSObject.Properties).Count -gt 0
if ($hasCompletedSteps -and $storedReleaseIdentity -ne $releaseIdentity) {
    $state = Reset-SegmentPreviewStateFrom -State $state -StepId 'fabric-notebook'
    Write-Detail 'The release artifacts changed; resume state was invalidated from the Fabric notebook step.'
}
if ($state.PSObject.Properties['releaseIdentity']) {
    $state.releaseIdentity = $releaseIdentity
}
else {
    Add-Member -InputObject $state -NotePropertyName 'releaseIdentity' -NotePropertyValue $releaseIdentity
}

$catalog = Get-SegmentPreviewStepCatalog
$script:StepTotal = $catalog.Count

Write-ConsentReport

if ($ConsentReportOnly) {
    Write-Banner 'Planned steps'
    foreach ($step in $catalog) {
        $completed = Test-SegmentPreviewStepCompleted -State $state -StepId $step.Id
        $marker = if ($completed) { 'done   ' } else { 'planned' }
        Write-Host ("  [{0}] {1,-18} {2}" -f $marker, $step.Id, $step.Name)
    }
    Write-Host ''
    Write-Host '  -ConsentReportOnly was requested; nothing was changed.' -ForegroundColor Cyan
    return
}

$handlers = @{
    'preflight'          = { Step-Preflight }
    'signin'             = { Step-SignIn }
    'fabric-discovery'   = { Step-FabricDiscovery }
    'fabric-notebook'    = { Step-FabricNotebook }
    'secret'             = { Step-Secret }
    'azure-infra'        = { Step-AzureInfrastructure }
    'fabric-permissions' = { Step-FabricPermissions }
    'azure-app'          = { Step-AzureApp }
    'dataverse-import'   = { Step-DataverseImport }
    'dataverse-config'   = { Step-DataverseConfiguration }
    'verify'             = { Step-Verify }
}

# Steps that only compute in-memory context must always run so that a resumed
# invocation has the same facts as a fresh one.
$alwaysRun = @('preflight', 'signin', 'secret')

# A resumed run skips the handlers that discovered the workspace, the deployed
# API and the managed identity, so those values are put back into the
# configuration before any step reads them. Explicit parameters keep priority.
$storedFacts = @{}
if ($state.facts) {
    foreach ($property in $state.facts.PSObject.Properties) {
        $storedFacts[$property.Name] = $property.Value
    }
}
$restoredFacts = Restore-SegmentPreviewFact -Fact $storedFacts
if ($restoredFacts.Count -gt 0) {
    Write-Host "  Restored from the earlier run: $($restoredFacts -join ', ')." -ForegroundColor DarkGray
}

try {
    foreach ($step in $catalog) {
        Write-StepHeader -Step $step
        $stepStarted = [DateTime]::UtcNow

        if ((Test-SegmentPreviewStepCompleted -State $state -StepId $step.Id) -and $alwaysRun -notcontains $step.Id) {
            Write-Skipped 'Already completed in an earlier run. Use -FromStep or -Force to repeat it.'
            Add-Result -StepId $step.Id -Status 'resumed' -Message 'Completed in an earlier run.'
            continue
        }

        $script:StepFacts = $null
        $message = & $handlers[$step.Id]
        $duration = [DateTime]::UtcNow - $stepStarted

        $facts = @{}
        if ($script:StepFacts) { $facts = $script:StepFacts }
        $state = Set-SegmentPreviewStepCompleted -State $state -StepId $step.Id -Fact $facts
        if (-not $WhatIfPreference) {
            Save-SegmentPreviewState -State $state -Path $script:StatePath
        }

        $status = if ($message -eq 'Skipped.') { 'skipped' } else { 'ok' }
        Add-Result -StepId $step.Id -Status $status -Message $message -Duration $duration
        if ($status -eq 'ok') { Write-Ok $message }
    }

    Write-Progress -Activity 'Segment Preview provisioning' -Completed
    Write-Summary
}
catch {
    Write-Progress -Activity 'Segment Preview provisioning' -Completed
    Add-Result -StepId $catalog[[Math]::Max(0, $script:StepIndex - 1)].Id -Status 'failed' -Message $_.Exception.Message
    Write-Summary
    Write-Host ''
    Write-Host "  The run stopped at step '$($catalog[[Math]::Max(0, $script:StepIndex - 1)].Id)'." -ForegroundColor Red
    Write-Host '  Fix the reported cause and re-run the same command; completed steps are skipped automatically.' -ForegroundColor Red
    throw
}
finally {
    if ($script:ApiKey) {
        $script:ApiKey = $null
        [GC]::Collect()
    }
}

#endregion
