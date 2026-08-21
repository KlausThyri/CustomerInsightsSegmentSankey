Set-StrictMode -Version Latest

<#
.SYNOPSIS
Deterministic helper functions for the Segment Preview provisioning orchestrator.

.DESCRIPTION
Every function in this module is side-effect free except for the state-file
helpers. The orchestrator in Install-SegmentPreview.ps1 keeps all network calls
so that this module stays unit testable without Azure, Fabric, or Dataverse.
#>

$script:StateSchemaVersion = 1

#region Secrets

function New-SegmentPreviewApiKey {
    <#
    .SYNOPSIS
    Creates a cryptographically random, URL-safe server-side API key.

    .DESCRIPTION
    Uses the operating system CSPRNG. The alphabet is restricted to RFC 4648
    URL-safe base64 without padding so that the value is safe inside HTTP
    headers, Bicep parameters, and az CLI key=value arguments.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [ValidateRange(32, 128)]
        [int] $ByteCount = 48
    )

    $bytes = [byte[]]::new($ByteCount)
    try {
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        return [Convert]::ToBase64String($bytes).
            Replace('+', '-').
            Replace('/', '_').
            TrimEnd('=')
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Get-SegmentPreviewFingerprint {
    <#
    .SYNOPSIS
    Returns a non-reversible fingerprint used to record which secret is active.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Value
    )

    if ([string]::IsNullOrEmpty($Value)) {
        return 'sha256:none'
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))
        return 'sha256:' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
    }
    finally {
        $sha.Dispose()
    }
}

#endregion

#region Validation and normalization

function Test-SegmentPreviewGuid {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string] $Value
    )

    $parsed = [guid]::Empty
    return [guid]::TryParse($Value, [ref] $parsed) -and $parsed -ne [guid]::Empty
}

function Test-SegmentPreviewWebAppName {
    <#
    .SYNOPSIS
    Validates an Azure Web App name against the globally unique DNS label rules.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string] $Name
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
        return $false
    }

    # 2-40 characters keeps the derived '<name>-insights' and '<name>-plan'
    # resource names inside their own Azure length limits.
    return [bool]($Name -cmatch '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$') -and -not $Name.Contains('--')
}

function ConvertTo-SegmentPreviewEnvironmentDomain {
    <#
    .SYNOPSIS
    Normalizes a Dataverse environment URL to its bare host name.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $EnvironmentUrl
    )

    $candidate = $EnvironmentUrl.Trim()
    if ($candidate -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
        $candidate = "https://$candidate"
    }

    $uri = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref] $uri)) {
        throw "'$EnvironmentUrl' is not a valid Dataverse environment URL."
    }

    if ($uri.Scheme -ne 'https') {
        throw "The Dataverse environment URL must use HTTPS, but '$EnvironmentUrl' does not."
    }

    return $uri.Host.ToLowerInvariant()
}

function ConvertTo-SegmentPreviewDataverseApiRoot {
    <#
    .SYNOPSIS
    Returns the Dataverse Web API root for an environment URL.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $EnvironmentUrl,

        [ValidatePattern('^v\d+\.\d+$')]
        [string] $ApiVersion = 'v9.2'
    )

    $domain = ConvertTo-SegmentPreviewEnvironmentDomain -EnvironmentUrl $EnvironmentUrl
    return "https://$domain/api/data/$ApiVersion/"
}

function ConvertTo-SegmentPreviewApiBaseUrl {
    <#
    .SYNOPSIS
    Returns the Segment Preview API base URL used by the Dataverse plugin.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $HostName
    )

    $trimmed = $HostName.Trim().TrimEnd('/')
    if ($trimmed -match '^https://') {
        return ($trimmed -replace '/api$', '') + '/api/'
    }

    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        throw 'The Web App host name is empty.'
    }

    return "https://$trimmed/api/"
}

function ConvertTo-SegmentPreviewFabricSqlServer {
    <#
    .SYNOPSIS
    Extracts the bare SQL endpoint host from a Fabric connection string.

    .DESCRIPTION
    The Fabric REST API returns the SQL analytics endpoint either as a bare host
    or as a full ADO.NET connection string. Both forms are reduced to the host
    that the FABRIC_SQL_SERVER application setting expects.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $ConnectionString
    )

    $value = $ConnectionString.Trim()
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw 'The Fabric SQL connection string is empty.'
    }

    foreach ($part in ($value -split ';')) {
        if ($part -match '^\s*(Data Source|Server|Address|Addr|Network Address)\s*=\s*(?<host>.+?)\s*$') {
            $value = $Matches['host']
            break
        }
    }

    $value = $value -replace '^tcp:', ''
    $value = ($value -split ',')[0]
    return $value.Trim().Trim('"').ToLowerInvariant()
}

function Get-SegmentPreviewRequiredTables {
    <#
    .SYNOPSIS
    Normalizes the SEGMENT_PREVIEW_REQUIRED_TABLES value.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string] $Value
    )

    $default = @('contact', 'msdynmkt_contactpointconsent4', 'msdynmkt_purpose', 'msdynmkt_topic')
    $source = if ([string]::IsNullOrWhiteSpace($Value)) { $default } else { $Value -split ',' }

    $result = $source |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_.Length -gt 0 } |
        Sort-Object -Unique -CaseSensitive:$false

    foreach ($table in $result) {
        if ($table -notmatch '^[A-Za-z][A-Za-z0-9_]*$') {
            throw "'$table' is not a valid Dataverse table name."
        }
    }

    return [string[]] $result
}

function Compare-SegmentPreviewVersion {
    <#
    .SYNOPSIS
    Compares two Dataverse solution versions. Returns -1, 0, or 1.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)]
        [string] $Left,

        [Parameter(Mandatory)]
        [string] $Right
    )

    $normalize = {
        param($value)
        $parts = @($value.Trim() -split '\.' | ForEach-Object { [int] ($_ -replace '[^\d]', '0') })
        while ($parts.Count -lt 4) { $parts += 0 }
        return [version]::new($parts[0], $parts[1], $parts[2], $parts[3])
    }

    return [int] ((& $normalize $Left).CompareTo((& $normalize $Right)))
}

#endregion

#region Solution package

function Get-SegmentPreviewSolutionManifest {
    <#
    .SYNOPSIS
    Reads unique name, version, and managed flag from a Dataverse solution zip.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    $archive = [System.IO.Compression.ZipFile]::OpenRead($resolved)
    try {
        $entry = $archive.Entries |
            Where-Object { $_.FullName -ieq 'solution.xml' } |
            Select-Object -First 1
        if (-not $entry) {
            throw "The solution package '$Path' does not contain solution.xml."
        }

        $reader = [System.IO.StreamReader]::new($entry.Open())
        try {
            $xml = [xml] $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $archive.Dispose()
    }

    $manifest = $xml.ImportExportXml.SolutionManifest
    return [pscustomobject]@{
        UniqueName = [string] $manifest.UniqueName
        Version    = [string] $manifest.Version
        # Managed == 2 marks a package that can be imported as managed.
        IsManaged  = ([string] $manifest.Managed) -eq '1'
        Publisher  = [string] $manifest.Publisher.UniqueName
        Path       = $resolved
    }
}

function Resolve-SegmentPreviewSolutionImportAction {
    <#
    .SYNOPSIS
    Decides how an already installed solution must be handled.

    .OUTPUTS
    install, upgrade, reinstall, skip, conflict, or downgrade-blocked.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [AllowNull()]
        [string] $InstalledVersion,

        [bool] $InstalledIsManaged = $true,

        [Parameter(Mandatory)]
        [string] $PackageVersion,

        [switch] $Force
    )

    if ([string]::IsNullOrWhiteSpace($InstalledVersion)) {
        return 'install'
    }

    if (-not $InstalledIsManaged) {
        return 'conflict'
    }

    $comparison = Compare-SegmentPreviewVersion -Left $PackageVersion -Right $InstalledVersion
    if ($comparison -gt 0) {
        return 'upgrade'
    }

    if ($comparison -lt 0) {
        if ($Force) { return 'reinstall' }
        return 'downgrade-blocked'
    }

    if ($Force) { return 'reinstall' }
    return 'skip'
}

#endregion

#region Fabric

function Select-SegmentPreviewDataverseConnection {
    <#
    .SYNOPSIS
    Finds the Fabric cloud connection that points at a Dataverse environment.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [AllowNull()]
        [object[]] $Connection,

        [Parameter(Mandatory)]
        [string] $EnvironmentDomain
    )

    if (-not $Connection) {
        return $null
    }

    $domain = $EnvironmentDomain.Trim().ToLowerInvariant()
    $dataverseTypes = @('dataverse', 'commondataservice', 'cds')

    foreach ($candidate in $Connection) {
        $details = $candidate.PSObject.Properties['connectionDetails']
        if (-not $details -or -not $details.Value) {
            continue
        }

        $type = [string] $details.Value.type
        if ($dataverseTypes -notcontains $type.ToLowerInvariant()) {
            continue
        }

        $path = ([string] $details.Value.path).Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }

        $pathHost = ($path -replace '^[a-z]+://', '').TrimEnd('/')
        if ($pathHost -eq $domain) {
            return $candidate
        }
    }

    return $null
}

function Set-SegmentPreviewNotebookParameter {
    <#
    .SYNOPSIS
    Replaces the top-level placeholder constants of the bootstrap notebook.

    .DESCRIPTION
    Only assignments of the form NAME = "value" at the start of a line are
    rewritten, and only with values that cannot terminate the Python literal.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Source,

        [Parameter(Mandatory)]
        [hashtable] $Parameter
    )

    $content = $Source
    $applied = [System.Collections.Generic.List[string]]::new()
    $missing = [System.Collections.Generic.List[string]]::new()

    foreach ($name in ($Parameter.Keys | Sort-Object)) {
        if ($name -notmatch '^[A-Z][A-Z0-9_]*$') {
            throw "'$name' is not a valid notebook constant name."
        }

        $value = [string] $Parameter[$name]
        if ($value -notmatch '^[A-Za-z0-9 ._/\-]+$') {
            throw "The value for the notebook constant '$name' contains unsupported characters."
        }

        $pattern = '(?m)^(?<prefix>' + [regex]::Escape($name) + '\s*=\s*)"[^"]*"'
        if ($content -notmatch $pattern) {
            $missing.Add($name) | Out-Null
            continue
        }

        $content = [regex]::Replace($content, $pattern, ('${prefix}"' + $value + '"'))
        $applied.Add($name) | Out-Null
    }

    return [pscustomobject]@{
        Content = $content
        Applied = [string[]] $applied
        Missing = [string[]] $missing
    }
}

function ConvertTo-SegmentPreviewNotebookIpynb {
    <#
    .SYNOPSIS
    Converts a Fabric ".py notebook source" file into an .ipynb payload.

    .DESCRIPTION
    The Fabric item-definition API accepts notebooks in the documented "ipynb"
    format. The repository keeps the notebook in the Git-friendly Python source
    format, so the orchestrator converts it before upload.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $Source
    )

    $lines = $Source -split "`r?`n"
    $cells = [System.Collections.Generic.List[pscustomobject]]::new()
    $currentType = $null
    $buffer = [System.Collections.Generic.List[string]]::new()

    $flush = {
        if ($null -eq $currentType) {
            return
        }

        while ($buffer.Count -gt 0 -and [string]::IsNullOrWhiteSpace($buffer[0])) {
            $buffer.RemoveAt(0)
        }
        while ($buffer.Count -gt 0 -and [string]::IsNullOrWhiteSpace($buffer[$buffer.Count - 1])) {
            $buffer.RemoveAt($buffer.Count - 1)
        }

        if ($buffer.Count -gt 0) {
            $cells.Add([pscustomobject]@{ Type = $currentType; Lines = @($buffer) }) | Out-Null
        }

        $buffer.Clear()
    }

    foreach ($line in $lines) {
        if ($line -match '^#\s*(?<kind>[A-Z]+)\s*\*{4,}\s*$') {
            & $flush
            $kind = $Matches['kind']
            $currentType = switch ($kind) {
                'CELL' { 'code' }
                'MARKDOWN' { 'markdown' }
                default { $null }
            }
            continue
        }

        if ($null -eq $currentType) {
            continue
        }

        if ($currentType -eq 'markdown') {
            $buffer.Add(($line -replace '^#\s?', '')) | Out-Null
        }
        else {
            $buffer.Add($line) | Out-Null
        }
    }

    & $flush

    $notebookCells = foreach ($cell in $cells) {
        $cellSource = @()
        for ($index = 0; $index -lt $cell.Lines.Count; $index++) {
            $suffix = if ($index -lt $cell.Lines.Count - 1) { "`n" } else { '' }
            $cellSource += ($cell.Lines[$index] + $suffix)
        }

        if ($cell.Type -eq 'code') {
            [ordered]@{
                cell_type       = 'code'
                execution_count = $null
                metadata        = [ordered]@{}
                outputs         = @()
                source          = [string[]] $cellSource
            }
        }
        else {
            [ordered]@{
                cell_type = 'markdown'
                metadata  = [ordered]@{}
                source    = [string[]] $cellSource
            }
        }
    }

    $notebook = [ordered]@{
        nbformat       = 4
        nbformat_minor = 5
        metadata       = [ordered]@{
            language_info = [ordered]@{ name = 'python' }
            kernelspec    = [ordered]@{
                name         = 'synapse_pyspark'
                display_name = 'Synapse PySpark'
                language     = 'Python'
            }
            kernel_info   = [ordered]@{ name = 'synapse_pyspark' }
        }
        cells          = @($notebookCells)
    }

    return ($notebook | ConvertTo-Json -Depth 12)
}

#endregion

#region Steps, consent, and state

function Get-SegmentPreviewStepCatalog {
    <#
    .SYNOPSIS
    Returns the ordered orchestrator steps.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject[]])]
    param()

    return @(
        [pscustomobject]@{ Id = 'preflight'; Phase = 'Preflight'; Name = 'Validate tooling, inputs, and consent prerequisites' }
        [pscustomobject]@{ Id = 'signin'; Phase = 'Preflight'; Name = 'Sign in to Azure and select the subscription' }
        [pscustomobject]@{ Id = 'fabric-discovery'; Phase = 'Fabric'; Name = 'Discover or create the Fabric workspace and lakehouse' }
        [pscustomobject]@{ Id = 'fabric-notebook'; Phase = 'Fabric'; Name = 'Publish and schedule the serving bootstrap notebook' }
        [pscustomobject]@{ Id = 'secret'; Phase = 'Azure'; Name = 'Resolve or generate the server-side API key' }
        [pscustomobject]@{ Id = 'azure-infra'; Phase = 'Azure'; Name = 'Deploy the Azure infrastructure' }
        [pscustomobject]@{ Id = 'fabric-permissions'; Phase = 'Fabric'; Name = 'Grant the managed identity access to Fabric' }
        [pscustomobject]@{ Id = 'azure-app'; Phase = 'Azure'; Name = 'Build and deploy the Segment Preview API' }
        [pscustomobject]@{ Id = 'dataverse-import'; Phase = 'Dataverse'; Name = 'Import the managed Dataverse solution' }
        [pscustomobject]@{ Id = 'dataverse-config'; Phase = 'Dataverse'; Name = 'Set the Dataverse environment variable values' }
        [pscustomobject]@{ Id = 'verify'; Phase = 'Verify'; Name = 'Run the end-to-end setup verification' }
    )
}

function Get-SegmentPreviewConsentChecklist {
    <#
    .SYNOPSIS
    Returns every action that cannot be automated without a human decision.

    .DESCRIPTION
    Each entry states whether the orchestrator can detect the state, whether it
    can change the state, and which role has to approve it.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject[]])]
    param()

    return @(
        [pscustomobject]@{
            Id           = 'azure-sign-in'
            Title        = 'Interactive Azure sign-in and multi-factor authentication'
            Role         = 'Deploying administrator'
            Automatable  = $false
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'The orchestrator runs "az login" when no usable Azure CLI session exists. Conditional access and MFA prompts cannot be suppressed.'
        }
        [pscustomobject]@{
            Id           = 'azure-cli-dataverse-consent'
            Title        = 'First-time consent for the Azure CLI to call Dataverse'
            Role         = 'Deploying administrator (tenant admin if admin consent is required)'
            Automatable  = $false
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'The first "az account get-access-token --resource https://<environment>.crm.dynamics.com" in a tenant can require a one-time consent. Approve it once, then re-run the same command.'
        }
        [pscustomobject]@{
            Id           = 'fabric-service-principal-apis'
            Title        = 'Fabric tenant setting "Service principals can use Fabric APIs"'
            Role         = 'Fabric tenant administrator'
            Automatable  = $false
            Detectable   = $false
            Blocking     = $true
            Guidance     = 'Enable the setting in the Fabric admin portal and add the Web App managed identity to the allowed security group. Microsoft exposes no public write API for tenant settings.'
        }
        [pscustomobject]@{
            Id           = 'fabric-capacity'
            Title        = 'Fabric capacity assignment for the workspace'
            Role         = 'Fabric capacity administrator'
            Automatable  = $true
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'Provide -FabricCapacityId to let the orchestrator create the workspace on that capacity. Purchasing or resuming a capacity remains a manual commercial decision.'
        }
        [pscustomobject]@{
            Id           = 'fabric-dataverse-connection'
            Title        = 'Fabric cloud connection to the Dataverse environment'
            Role         = 'Fabric workspace administrator'
            Automatable  = $false
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'A Dataverse cloud connection is created through an interactive OAuth consent dialog in the Fabric portal. The orchestrator discovers an existing connection and fails with instructions when none exists.'
        }
        [pscustomobject]@{
            Id           = 'dataverse-link-to-fabric'
            Title        = 'Dataverse "Link to Microsoft Fabric" and the Journeys export'
            Role         = 'Power Platform / Customer Insights administrator'
            Automatable  = $false
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'The Dataverse mirror and the Customer Insights - Journeys data export to Fabric are enabled in the maker and Customer Insights portals. Neither has a documented public provisioning API.'
        }
        [pscustomobject]@{
            Id           = 'dataverse-solution-privileges'
            Title        = 'System administrator privileges in the target Dataverse environment'
            Role         = 'Dataverse system administrator'
            Automatable  = $false
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'Importing a managed solution, registering plugins, and writing environment variable values require the System Administrator role for the signed-in user.'
        }
        [pscustomobject]@{
            Id           = 'fabric-workspace-identity-role'
            Title        = 'Fabric workspace role for the Web App managed identity'
            Role         = 'Fabric workspace administrator'
            Automatable  = $true
            Detectable   = $true
            Blocking     = $true
            Guidance     = 'The orchestrator assigns the Contributor workspace role to the managed identity through the Fabric REST API when the signed-in user administers the workspace.'
        }
    )
}

function Get-SegmentPreviewStateFilePath {
    <#
    .SYNOPSIS
    Returns the resume-state file for one deployment target.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string] $StateDirectory,

        [Parameter(Mandatory)]
        [string] $DeploymentName
    )

    $safeName = ($DeploymentName.ToLowerInvariant() -replace '[^a-z0-9._-]', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($safeName)) {
        $safeName = 'segment-preview'
    }

    return (Join-Path $StateDirectory "$safeName.state.json")
}

function Read-SegmentPreviewState {
    <#
    .SYNOPSIS
    Loads the resume state, or returns a new empty state.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    if (Test-Path -LiteralPath $Path) {
        try {
            $loaded = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($loaded -and $loaded.PSObject.Properties['schemaVersion'] -and
                [int] $loaded.schemaVersion -eq $script:StateSchemaVersion) {
                if (-not $loaded.PSObject.Properties['steps']) {
                    Add-Member -InputObject $loaded -NotePropertyName 'steps' -NotePropertyValue ([pscustomobject]@{})
                }
                if (-not $loaded.PSObject.Properties['facts']) {
                    Add-Member -InputObject $loaded -NotePropertyName 'facts' -NotePropertyValue ([pscustomobject]@{})
                }
                return $loaded
            }
        }
        catch {
            Write-Warning "The resume state '$Path' is unreadable and is ignored: $($_.Exception.Message)"
        }
    }

    return [pscustomobject]@{
        schemaVersion = $script:StateSchemaVersion
        createdAt     = [DateTime]::UtcNow.ToString('o')
        updatedAt     = [DateTime]::UtcNow.ToString('o')
        steps         = [pscustomobject]@{}
        facts         = [pscustomobject]@{}
    }
}

function Save-SegmentPreviewState {
    <#
    .SYNOPSIS
    Writes the resume state atomically.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [pscustomobject] $State,

        [Parameter(Mandatory)]
        [string] $Path
    )

    $State.updatedAt = [DateTime]::UtcNow.ToString('o')
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $temporary = "$Path.tmp"
    ($State | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $temporary -Encoding UTF8 -NoNewline
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Test-SegmentPreviewStepCompleted {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [pscustomobject] $State,

        [Parameter(Mandatory)]
        [string] $StepId
    )

    $property = $State.steps.PSObject.Properties[$StepId]
    return [bool]($property -and $property.Value -and $property.Value.status -eq 'completed')
}

function Set-SegmentPreviewStepCompleted {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [pscustomobject] $State,

        [Parameter(Mandatory)]
        [string] $StepId,

        [string] $Status = 'completed',

        [AllowNull()]
        [hashtable] $Fact
    )

    $entry = [pscustomobject]@{
        status      = $Status
        completedAt = [DateTime]::UtcNow.ToString('o')
    }

    if ($State.steps.PSObject.Properties[$StepId]) {
        $State.steps.$StepId = $entry
    }
    else {
        Add-Member -InputObject $State.steps -NotePropertyName $StepId -NotePropertyValue $entry
    }

    if ($Fact) {
        foreach ($key in $Fact.Keys) {
            if ($State.facts.PSObject.Properties[$key]) {
                $State.facts.$key = $Fact[$key]
            }
            else {
                Add-Member -InputObject $State.facts -NotePropertyName $key -NotePropertyValue $Fact[$key]
            }
        }
    }

    return $State
}

function Reset-SegmentPreviewStateFrom {
    <#
    .SYNOPSIS
    Clears the completion marker of one step and every later step.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [pscustomobject] $State,

        [Parameter(Mandatory)]
        [string] $StepId
    )

    $catalog = Get-SegmentPreviewStepCatalog
    $index = [array]::FindIndex([object[]] $catalog, [Predicate[object]] { param($item) $item.Id -eq $StepId })
    if ($index -lt 0) {
        throw "'$StepId' is not a known provisioning step."
    }

    foreach ($step in $catalog[$index..($catalog.Count - 1)]) {
        if ($State.steps.PSObject.Properties[$step.Id]) {
            $State.steps.PSObject.Properties.Remove($step.Id)
        }
    }

    return $State
}

function Merge-SegmentPreviewConfiguration {
    <#
    .SYNOPSIS
    Merges a configuration file with explicitly bound parameters.

    .DESCRIPTION
    Explicit parameters always win. Empty and null configuration values are
    ignored so that a partially filled template stays usable.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [AllowNull()]
        [object] $Configuration,

        [AllowNull()]
        [hashtable] $BoundParameter,

        [AllowNull()]
        [hashtable] $Default
    )

    $result = @{}
    if ($Default) {
        foreach ($key in $Default.Keys) {
            $result[$key] = $Default[$key]
        }
    }

    if ($Configuration) {
        $properties = if ($Configuration -is [hashtable]) {
            $Configuration.Keys | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $Configuration[$_] } }
        }
        else {
            $Configuration.PSObject.Properties
        }

        foreach ($property in $properties) {
            if ($property.Name.StartsWith('$') -or $property.Name.StartsWith('_')) {
                continue
            }
            if ($null -eq $property.Value) {
                continue
            }
            if ($property.Value -is [string] -and [string]::IsNullOrWhiteSpace($property.Value)) {
                continue
            }
            if ($property.Value -is [string] -and $property.Value -match '^<.*>$') {
                continue
            }

            $result[$property.Name] = $property.Value
        }
    }

    if ($BoundParameter) {
        foreach ($key in $BoundParameter.Keys) {
            $result[$key] = $BoundParameter[$key]
        }
    }

    return $result
}

function Format-SegmentPreviewDuration {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [timespan] $Duration
    )

    if ($Duration.TotalSeconds -lt 1) {
        return '{0} ms' -f [int] $Duration.TotalMilliseconds
    }

    if ($Duration.TotalMinutes -lt 1) {
        return [string]::Format([cultureinfo]::InvariantCulture, '{0:0.0} s', $Duration.TotalSeconds)
    }

    return [string]::Format([cultureinfo]::InvariantCulture, '{0}m {1:00}s', [int] $Duration.TotalMinutes, $Duration.Seconds)
}

#endregion

Export-ModuleMember -Function @(
    'Compare-SegmentPreviewVersion'
    'ConvertTo-SegmentPreviewApiBaseUrl'
    'ConvertTo-SegmentPreviewDataverseApiRoot'
    'ConvertTo-SegmentPreviewEnvironmentDomain'
    'ConvertTo-SegmentPreviewFabricSqlServer'
    'ConvertTo-SegmentPreviewNotebookIpynb'
    'Format-SegmentPreviewDuration'
    'Get-SegmentPreviewConsentChecklist'
    'Get-SegmentPreviewFingerprint'
    'Get-SegmentPreviewRequiredTables'
    'Get-SegmentPreviewSolutionManifest'
    'Get-SegmentPreviewStateFilePath'
    'Get-SegmentPreviewStepCatalog'
    'Merge-SegmentPreviewConfiguration'
    'New-SegmentPreviewApiKey'
    'Read-SegmentPreviewState'
    'Reset-SegmentPreviewStateFrom'
    'Resolve-SegmentPreviewSolutionImportAction'
    'Save-SegmentPreviewState'
    'Select-SegmentPreviewDataverseConnection'
    'Set-SegmentPreviewNotebookParameter'
    'Set-SegmentPreviewStepCompleted'
    'Test-SegmentPreviewGuid'
    'Test-SegmentPreviewStepCompleted'
    'Test-SegmentPreviewWebAppName'
)
