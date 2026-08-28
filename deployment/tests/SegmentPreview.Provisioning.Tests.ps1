#requires -Version 7.2
<#
.SYNOPSIS
Pester tests for the Segment Preview provisioning helpers and orchestrator plan.

.DESCRIPTION
Run with:
    ./deployment/tests/Invoke-ProvisioningTests.ps1
The tests are hermetic: they never contact Azure, Fabric, or Dataverse.
#>

BeforeAll {
    $script:DeploymentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
    $script:RepositoryRoot = (Resolve-Path (Join-Path $script:DeploymentRoot '..')).ProviderPath
    $script:OrchestratorPath = Join-Path $script:DeploymentRoot 'Install-SegmentPreview.ps1'
    Import-Module (Join-Path $script:DeploymentRoot 'modules\SegmentPreview.Provisioning\SegmentPreview.Provisioning.psd1') -Force
}

Describe 'New-SegmentPreviewApiKey' {
    It 'produces a URL-safe key of the expected length' {
        $key = New-SegmentPreviewApiKey
        $key | Should -Match '^[A-Za-z0-9_-]+$'
        $key.Length | Should -Be 64
    }

    It 'produces a different key on every call' {
        $keys = 1..25 | ForEach-Object { New-SegmentPreviewApiKey }
        ($keys | Sort-Object -Unique).Count | Should -Be 25
    }

    It 'honours a custom byte count' {
        (New-SegmentPreviewApiKey -ByteCount 32).Length | Should -Be 43
    }

    It 'never contains characters that break az CLI key=value parsing' {
        $joined = (1..25 | ForEach-Object { New-SegmentPreviewApiKey }) -join ''
        $joined | Should -Not -Match '[=+/]'
    }
}

Describe 'Get-SegmentPreviewFingerprint' {
    It 'is deterministic' {
        Get-SegmentPreviewFingerprint -Value 'abc' | Should -Be (Get-SegmentPreviewFingerprint -Value 'abc')
    }

    It 'differs for different secrets' {
        Get-SegmentPreviewFingerprint -Value 'abc' | Should -Not -Be (Get-SegmentPreviewFingerprint -Value 'abd')
    }

    It 'does not leak the secret' {
        $secret = New-SegmentPreviewApiKey
        Get-SegmentPreviewFingerprint -Value $secret | Should -Not -Match ([regex]::Escape($secret.Substring(0, 8)))
    }

    It 'handles an empty value' {
        Get-SegmentPreviewFingerprint -Value '' | Should -Be 'sha256:none'
    }
}

Describe 'Test-SegmentPreviewWebAppName' {
    It 'accepts <name>' -ForEach @(
        @{ name = 'contoso-segment-preview' }
        @{ name = 'seg1' }
        @{ name = 'a1' }
    ) {
        Test-SegmentPreviewWebAppName -Name $name | Should -BeTrue
    }

    It 'rejects <name>' -ForEach @(
        @{ name = '' }
        @{ name = 'A-Upper-Case' }
        @{ name = '-leading' }
        @{ name = 'trailing-' }
        @{ name = 'double--hyphen' }
        @{ name = 'has_underscore' }
        @{ name = 'x' }
        @{ name = ('a' * 41) }
    ) {
        Test-SegmentPreviewWebAppName -Name $name | Should -BeFalse
    }
}

Describe 'ConvertTo-SegmentPreviewEnvironmentDomain' {
    It 'normalizes <url> to <expected>' -ForEach @(
        @{ url = 'https://contoso.crm4.dynamics.com'; expected = 'contoso.crm4.dynamics.com' }
        @{ url = 'https://Contoso.CRM4.dynamics.com/'; expected = 'contoso.crm4.dynamics.com' }
        @{ url = 'contoso.crm4.dynamics.com'; expected = 'contoso.crm4.dynamics.com' }
        @{ url = ' https://contoso.crm4.dynamics.com/main.aspx '; expected = 'contoso.crm4.dynamics.com' }
    ) {
        ConvertTo-SegmentPreviewEnvironmentDomain -EnvironmentUrl $url | Should -Be $expected
    }

    It 'rejects non-HTTPS URLs' {
        { ConvertTo-SegmentPreviewEnvironmentDomain -EnvironmentUrl 'http://contoso.crm4.dynamics.com' } |
            Should -Throw -ExpectedMessage '*HTTPS*'
    }
}

Describe 'ConvertTo-SegmentPreviewDataverseApiRoot' {
    It 'builds the Web API root' {
        ConvertTo-SegmentPreviewDataverseApiRoot -EnvironmentUrl 'https://contoso.crm4.dynamics.com' |
            Should -Be 'https://contoso.crm4.dynamics.com/api/data/v9.2/'
    }
}

Describe 'ConvertTo-SegmentPreviewApiBaseUrl' {
    It 'builds the API base URL from a host name' {
        ConvertTo-SegmentPreviewApiBaseUrl -HostName 'seg.azurewebsites.net' |
            Should -Be 'https://seg.azurewebsites.net/api/'
    }

    It 'is idempotent for an already complete URL' {
        ConvertTo-SegmentPreviewApiBaseUrl -HostName 'https://seg.azurewebsites.net/api/' |
            Should -Be 'https://seg.azurewebsites.net/api/'
    }
}

Describe 'ConvertTo-SegmentPreviewFabricSqlServer' {
    It 'extracts the host from <text>' -ForEach @(
        @{ text = 'abc.datawarehouse.fabric.microsoft.com'; expected = 'abc.datawarehouse.fabric.microsoft.com' }
        @{ text = 'Data Source=tcp:abc.datawarehouse.fabric.microsoft.com,1433;Initial Catalog=lh'; expected = 'abc.datawarehouse.fabric.microsoft.com' }
        @{ text = 'Server=ABC.datawarehouse.fabric.microsoft.com;Database=lh'; expected = 'abc.datawarehouse.fabric.microsoft.com' }
    ) {
        ConvertTo-SegmentPreviewFabricSqlServer -ConnectionString $text | Should -Be $expected
    }
}

Describe 'Get-SegmentPreviewRequiredTables' {
    It 'returns the documented defaults' {
        Get-SegmentPreviewRequiredTables -Value $null |
            Should -Be @('contact', 'msdynmkt_contactpointconsent4', 'msdynmkt_purpose', 'msdynmkt_topic')
    }

    It 'trims, de-duplicates, and sorts' {
        Get-SegmentPreviewRequiredTables -Value ' lead , contact ,lead' | Should -Be @('contact', 'lead')
    }

    It 'rejects table names that are unsafe for SQL and shortcut paths' {
        { Get-SegmentPreviewRequiredTables -Value 'contact,drop table' } | Should -Throw
        { Get-SegmentPreviewRequiredTables -Value 'contact,1bad' } | Should -Throw
    }
}

Describe 'Compare-SegmentPreviewVersion' {
    It 'compares <left> and <right> to <expected>' -ForEach @(
        @{ left = '1.0.0.0'; right = '1.0.0.0'; expected = 0 }
        @{ left = '1.0.1.0'; right = '1.0.0.0'; expected = 1 }
        @{ left = '1.0.0.0'; right = '1.0.1.0'; expected = -1 }
        @{ left = '1.2'; right = '1.2.0.0'; expected = 0 }
        @{ left = '2.0'; right = '1.9.9.9'; expected = 1 }
    ) {
        Compare-SegmentPreviewVersion -Left $left -Right $right | Should -Be $expected
    }
}

Describe 'Resolve-SegmentPreviewSolutionImportAction' {
    It 'installs when nothing is present' {
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion $null -PackageVersion '1.0.0.0' |
            Should -Be 'install'
    }

    It 'upgrades a lower managed version' {
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion '1.0.0.0' -PackageVersion '1.1.0.0' |
            Should -Be 'upgrade'
    }

    It 'skips an identical version' {
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion '1.0.0.0' -PackageVersion '1.0.0.0' |
            Should -Be 'skip'
    }

    It 'reinstalls an identical version when forced' {
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion '1.0.0.0' -PackageVersion '1.0.0.0' -Force |
            Should -Be 'reinstall'
    }

    It 'blocks a downgrade unless forced' {
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion '2.0.0.0' -PackageVersion '1.0.0.0' |
            Should -Be 'downgrade-blocked'
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion '2.0.0.0' -PackageVersion '1.0.0.0' -Force |
            Should -Be 'reinstall'
    }

    It 'reports a conflict when an unmanaged solution owns the unique name' {
        Resolve-SegmentPreviewSolutionImportAction -InstalledVersion '1.0.0.0' -InstalledIsManaged $false -PackageVersion '1.1.0.0' |
            Should -Be 'conflict'
    }
}

Describe 'Get-SegmentPreviewSolutionManifest' {
    It 'reads the shipped managed package' {
        $manifest = Get-SegmentPreviewSolutionManifest -Path (Join-Path $script:DeploymentRoot 'dataverse\CustomerInsightsSegmentPreview_managed.zip')
        $manifest.UniqueName | Should -Be 'klth_SegmentPreview'
        $manifest.Version | Should -Match '^\d+\.\d+\.\d+\.\d+$'
        $manifest.Publisher | Should -Be 'KlausThyri'
    }
}

Describe 'Select-SegmentPreviewDataverseConnection' {
    BeforeAll {
        $script:Connections = @(
            [pscustomobject]@{ id = '1'; displayName = 'sql'; connectionDetails = [pscustomobject]@{ type = 'SQL'; path = 'contoso.crm4.dynamics.com' } }
            [pscustomobject]@{ id = '2'; displayName = 'other dv'; connectionDetails = [pscustomobject]@{ type = 'Dataverse'; path = 'fabrikam.crm4.dynamics.com' } }
            [pscustomobject]@{ id = '3'; displayName = 'target dv'; connectionDetails = [pscustomobject]@{ type = 'Dataverse'; path = 'https://Contoso.crm4.dynamics.com/' } }
        )
    }

    It 'selects the connection for the target environment' {
        (Select-SegmentPreviewDataverseConnection -Connection $script:Connections -EnvironmentDomain 'contoso.crm4.dynamics.com').id |
            Should -Be '3'
    }

    It 'returns nothing when no Dataverse connection matches' {
        Select-SegmentPreviewDataverseConnection -Connection $script:Connections -EnvironmentDomain 'northwind.crm4.dynamics.com' |
            Should -BeNullOrEmpty
    }

    It 'tolerates an empty list' {
        Select-SegmentPreviewDataverseConnection -Connection @() -EnvironmentDomain 'contoso.crm4.dynamics.com' |
            Should -BeNullOrEmpty
    }
}

Describe 'Set-SegmentPreviewNotebookParameter' {
    BeforeAll {
        $script:NotebookSource = Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'Fabric\bootstrap-events.py') -Raw -Encoding UTF8
    }

    It 'replaces every placeholder of the shipped bootstrap notebook' {
        $result = Set-SegmentPreviewNotebookParameter -Source $script:NotebookSource -Parameter @{
            WORKSPACE_ID           = '11111111-1111-1111-1111-111111111111'
            SERVING_LAKEHOUSE_ID   = '22222222-2222-2222-2222-222222222222'
            DATAVERSE_LAKEHOUSE_ID = '33333333-3333-3333-3333-333333333333'
        }

        $result.Missing | Should -BeNullOrEmpty
        $result.Applied.Count | Should -Be 3
        $result.Content | Should -Not -Match '<fabric-workspace-id>'
        $result.Content | Should -Not -Match '<serving-lakehouse-id>'
        $result.Content | Should -Not -Match '<dataverse-mirror-lakehouse-id>'
        $result.Content | Should -Match 'WORKSPACE_ID = "11111111-1111-1111-1111-111111111111"'
    }

    It 'reports constants that the notebook does not declare' {
        $result = Set-SegmentPreviewNotebookParameter -Source $script:NotebookSource -Parameter @{ NOT_PRESENT = 'x' }
        $result.Missing | Should -Be @('NOT_PRESENT')
    }

    It 'rejects values that could terminate the Python string literal' {
        { Set-SegmentPreviewNotebookParameter -Source $script:NotebookSource -Parameter @{ WORKSPACE_ID = 'a"; import os; x="' } } |
            Should -Throw -ExpectedMessage '*unsupported characters*'
    }

    It 'rejects constant names that are not upper-case identifiers' {
        { Set-SegmentPreviewNotebookParameter -Source $script:NotebookSource -Parameter @{ 'bad name' = 'x' } } | Should -Throw
    }
}

Describe 'ConvertTo-SegmentPreviewNotebookIpynb' {
    BeforeAll {
        $script:Ipynb = ConvertTo-SegmentPreviewNotebookIpynb -Source (
            Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'Fabric\bootstrap-events.py') -Raw -Encoding UTF8)
        $script:Notebook = $script:Ipynb | ConvertFrom-Json
    }

    It 'produces a valid nbformat 4 document' {
        $script:Notebook.nbformat | Should -Be 4
        $script:Notebook.metadata.kernelspec.name | Should -Be 'synapse_pyspark'
    }

    It 'keeps the markdown documentation and the code cell' {
        @($script:Notebook.cells).Count | Should -Be 2
        $script:Notebook.cells[0].cell_type | Should -Be 'markdown'
        $script:Notebook.cells[1].cell_type | Should -Be 'code'
    }

    It 'emits source as an array of newline-terminated lines' {
        @($script:Notebook.cells[1].source).Count | Should -BeGreaterThan 100
        $script:Notebook.cells[1].source[0] | Should -Be "from datetime import datetime, timezone`n"
    }

    It 'drops the Fabric METADATA marker blocks' {
        $script:Ipynb | Should -Not -Match 'synapse_pyspark\\"\s*\\n\s*#\s*META'
        ($script:Notebook.cells[1].source -join '') | Should -Not -Match '# META '
    }

    It 'preserves the shortcut REST endpoint of the notebook' {
        ($script:Notebook.cells[1].source -join '') | Should -Match 'api\.fabric\.microsoft\.com'
    }
}

Describe 'Merge-SegmentPreviewConfiguration' {
    It 'lets explicit parameters win over the configuration file' {
        $merged = Merge-SegmentPreviewConfiguration `
            -Configuration ([pscustomobject]@{ Location = 'northeurope'; WebAppName = 'from-file' }) `
            -BoundParameter @{ WebAppName = 'from-parameter' } `
            -Default @{ Location = 'westeurope'; ResourceGroup = 'rg-default' }

        $merged['WebAppName'] | Should -Be 'from-parameter'
        $merged['Location'] | Should -Be 'northeurope'
        $merged['ResourceGroup'] | Should -Be 'rg-default'
    }

    It 'ignores unfilled template placeholders and blank values' {
        $merged = Merge-SegmentPreviewConfiguration `
            -Configuration ([pscustomobject]@{ WebAppName = '<globally-unique-name>'; Location = '   '; SubscriptionId = $null }) `
            -BoundParameter @{} `
            -Default @{ Location = 'westeurope' }

        $merged.ContainsKey('WebAppName') | Should -BeFalse
        $merged.ContainsKey('SubscriptionId') | Should -BeFalse
        $merged['Location'] | Should -Be 'westeurope'
    }

    It 'ignores comment properties' {
        $merged = Merge-SegmentPreviewConfiguration `
            -Configuration ([pscustomobject]@{ '_comment' = 'ignore me'; '$schema' = 'x'; Location = 'uksouth' }) `
            -BoundParameter @{} -Default @{}

        $merged.Keys | Should -Be @('Location')
    }
}

Describe 'Resume state' {
    BeforeEach {
        $script:StateRoot = Join-Path ([IO.Path]::GetDirectoryName($script:OrchestratorPath)) '.provisioning-state-tests'
        if (Test-Path -LiteralPath $script:StateRoot) {
            Remove-Item -LiteralPath $script:StateRoot -Recurse -Force
        }
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:StateRoot) {
            Remove-Item -LiteralPath $script:StateRoot -Recurse -Force
        }
    }

    It 'derives a file-system safe state path' {
        Get-SegmentPreviewStateFilePath -StateDirectory $script:StateRoot -DeploymentName 'Contoso Segment/Preview' |
            Should -Be (Join-Path $script:StateRoot 'contoso-segment-preview.state.json')
    }

    It 'round-trips completed steps and facts' {
        $path = Get-SegmentPreviewStateFilePath -StateDirectory $script:StateRoot -DeploymentName 'demo'
        $state = Read-SegmentPreviewState -Path $path
        $state = Set-SegmentPreviewStepCompleted -State $state -StepId 'preflight' -Fact @{ apiKeyFingerprint = 'sha256:abc' }
        Save-SegmentPreviewState -State $state -Path $path

        $reloaded = Read-SegmentPreviewState -Path $path
        Test-SegmentPreviewStepCompleted -State $reloaded -StepId 'preflight' | Should -BeTrue
        Test-SegmentPreviewStepCompleted -State $reloaded -StepId 'verify' | Should -BeFalse
        $reloaded.facts.apiKeyFingerprint | Should -Be 'sha256:abc'
    }

    It 'never stores the secret itself' {
        $path = Get-SegmentPreviewStateFilePath -StateDirectory $script:StateRoot -DeploymentName 'demo'
        $secret = New-SegmentPreviewApiKey
        $state = Read-SegmentPreviewState -Path $path
        $state = Set-SegmentPreviewStepCompleted -State $state -StepId 'secret' -Fact @{
            apiKeyFingerprint = Get-SegmentPreviewFingerprint -Value $secret
        }
        Save-SegmentPreviewState -State $state -Path $path

        (Get-Content -LiteralPath $path -Raw) | Should -Not -Match ([regex]::Escape($secret))
    }

    It 'clears the requested step and every later step' {
        $path = Get-SegmentPreviewStateFilePath -StateDirectory $script:StateRoot -DeploymentName 'demo'
        $state = Read-SegmentPreviewState -Path $path
        foreach ($step in (Get-SegmentPreviewStepCatalog)) {
            $state = Set-SegmentPreviewStepCompleted -State $state -StepId $step.Id
        }

        $state = Reset-SegmentPreviewStateFrom -State $state -StepId 'azure-infra'
        Test-SegmentPreviewStepCompleted -State $state -StepId 'secret' | Should -BeTrue
        Test-SegmentPreviewStepCompleted -State $state -StepId 'azure-infra' | Should -BeFalse
        Test-SegmentPreviewStepCompleted -State $state -StepId 'verify' | Should -BeFalse
    }

    It 'rejects an unknown step id' {
        $state = Read-SegmentPreviewState -Path (Join-Path $script:StateRoot 'demo.state.json')
        { Reset-SegmentPreviewStateFrom -State $state -StepId 'not-a-step' } | Should -Throw
    }

    It 'falls back to an empty state when the file is corrupt' {
        $path = Get-SegmentPreviewStateFilePath -StateDirectory $script:StateRoot -DeploymentName 'demo'
        New-Item -ItemType Directory -Path $script:StateRoot -Force | Out-Null
        Set-Content -LiteralPath $path -Value '{ not json' -Encoding UTF8

        $state = Read-SegmentPreviewState -Path $path -WarningAction SilentlyContinue
        Test-SegmentPreviewStepCompleted -State $state -StepId 'preflight' | Should -BeFalse
    }
}

Describe 'Step catalog' {
    BeforeAll {
        $script:Catalog = Get-SegmentPreviewStepCatalog
        $script:Order = @{}
        for ($index = 0; $index -lt $script:Catalog.Count; $index++) {
            $script:Order[$script:Catalog[$index].Id] = $index
        }
    }

    It 'has unique step ids' {
        ($script:Catalog.Id | Sort-Object -Unique).Count | Should -Be $script:Catalog.Count
    }

    It 'resolves Fabric identifiers before the Azure deployment consumes them' {
        $script:Order['fabric-discovery'] | Should -BeLessThan $script:Order['azure-infra']
    }

    It 'creates the managed identity before granting it Fabric access' {
        $script:Order['azure-infra'] | Should -BeLessThan $script:Order['fabric-permissions']
    }

    It 'imports the solution before writing environment variable values' {
        $script:Order['dataverse-import'] | Should -BeLessThan $script:Order['dataverse-config']
    }

    It 'verifies last' {
        $script:Catalog[-1].Id | Should -Be 'verify'
    }
}

Describe 'Consent checklist' {
    BeforeAll { $script:Consent = Get-SegmentPreviewConsentChecklist }

    It 'documents every entry completely' {
        foreach ($item in $script:Consent) {
            $item.Id | Should -Not -BeNullOrEmpty
            $item.Title | Should -Not -BeNullOrEmpty
            $item.Role | Should -Not -BeNullOrEmpty
            $item.Guidance | Should -Not -BeNullOrEmpty
        }
    }

    It 'records the Fabric tenant setting as not automatable' {
        ($script:Consent | Where-Object Id -EQ 'fabric-service-principal-apis').Automatable | Should -BeFalse
    }

    It 'records the workspace role assignment as automatable' {
        ($script:Consent | Where-Object Id -EQ 'fabric-workspace-identity-role').Automatable | Should -BeTrue
    }
}

Describe 'Format-SegmentPreviewDuration' {
    It 'formats <seconds> s as <expected>' -ForEach @(
        @{ seconds = 0.25; expected = '250 ms' }
        @{ seconds = 3.5; expected = '3.5 s' }
        @{ seconds = 125; expected = '2m 05s' }
    ) {
        Format-SegmentPreviewDuration -Duration ([timespan]::FromSeconds($seconds)) | Should -Be $expected
    }
}

Describe 'Install-SegmentPreview.ps1' {
    BeforeAll {
        $parseErrors = $null
        $tokens = $null
        $script:Ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:OrchestratorPath, [ref] $tokens, [ref] $parseErrors)
        $script:ParseErrors = $parseErrors
        $script:Catalog = Get-SegmentPreviewStepCatalog
    }

    It 'parses without errors' {
        $script:ParseErrors | Should -BeNullOrEmpty
    }

    It 'implements a handler for every catalog step' {
        $hashtable = $script:Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                $node.Left.Extent.Text -eq '$handlers'
            }, $true) | Select-Object -First 1

        $keys = $hashtable.Right.Expression.KeyValuePairs |
            ForEach-Object { $_.Item1.Extent.Text.Trim("'", '"') }

        foreach ($step in $script:Catalog) {
            $keys | Should -Contain $step.Id
        }
        $keys.Count | Should -Be $script:Catalog.Count
    }

    It 'offers -FromStep for every catalog step' {
        $parameter = $script:Ast.ParamBlock.Parameters |
            Where-Object { $_.Name.VariablePath.UserPath -eq 'FromStep' }
        $validate = $parameter.Attributes |
            Where-Object { $_.TypeName.Name -eq 'ValidateSet' } |
            Select-Object -First 1
        $allowed = $validate.PositionalArguments | ForEach-Object { $_.Value }

        foreach ($step in $script:Catalog) {
            $allowed | Should -Contain $step.Id
        }
    }

    It 'supports -WhatIf through SupportsShouldProcess' {
        $script:Ast.ParamBlock.Attributes.Extent.Text -join ' ' | Should -Match 'SupportsShouldProcess'
    }

    It 'never writes the API key to a parameter file on disk' {
        $content = Get-Content -LiteralPath $script:OrchestratorPath -Raw
        $content | Should -Not -Match 'bicepparam'
        $content | Should -Match 'behavioralApiKey=\$script:ApiKey'
    }

    It 'passes the script bound parameters into the configuration resolver' {
        # $PSBoundParameters inside a function describes the function call, so
        # the orchestrator must forward the script-level dictionary explicitly.
        $content = Get-Content -LiteralPath $script:OrchestratorPath -Raw
        $content | Should -Match 'Resolve-Configuration -BoundParameter \$PSBoundParameters'
    }

    It 'contains no literal secret material' {
        $content = Get-Content -LiteralPath $script:OrchestratorPath -Raw
        $content | Should -Not -Match "(?i)(password|client_secret|clientsecret)\s*=\s*['`"][^'`"]{8,}"
    }
}

Describe 'Managed solution packaging' {
    BeforeAll {
        $script:SolutionSource = Join-Path $script:RepositoryRoot 'solution\src'
        $script:SetupVariables = @(
            'klth_SetupProvisioningMode',
            'klth_SetupBrokerUrl',
            'klth_SetupBrokerScope',
            'klth_SetupEntraClientId',
            'klth_SetupConfiguration',
            'klth_SetupApiPackageUrl',
            'klth_BusinessUnitScopingEnabled'
        )
    }

    It 'keeps every solution XML file well formed' {
        $files = Get-ChildItem -LiteralPath $script:SolutionSource -Recurse -Filter '*.xml' -File
        $files.Count | Should -BeGreaterThan 0
        foreach ($file in $files) {
            { [xml](Get-Content -LiteralPath $file.FullName -Raw) } | Should -Not -Throw -Because $file.FullName
        }
    }

    It 'declares the browser provisioning web resources as root components' {
        $solutionXml = [xml](Get-Content -LiteralPath (Join-Path $script:SolutionSource 'Other\Solution.xml') -Raw)
        $names = $solutionXml.ImportExportXml.SolutionManifest.RootComponents.RootComponent |
            Where-Object { $_.type -eq '61' } |
            ForEach-Object { $_.schemaName }
        $names | Should -Contain 'klth_/SegmentSankey/segment-preview-provisioning.js'
        $names | Should -Contain 'klth_/SegmentSankey/segment-preview-azure-template.js'
        $names | Should -Contain 'klth_/SegmentSankey/segment-preview-payload.js'
    }

    It 'raises the solution version above the shipped 1.0.0.0 package' {
        $solutionXml = [xml](Get-Content -LiteralPath (Join-Path $script:SolutionSource 'Other\Solution.xml') -Raw)
        [version]$solutionXml.ImportExportXml.SolutionManifest.Version | Should -BeGreaterThan ([version]'1.0.0.0')
    }

    It 'ships the setup center variables as optional strings without defaults' {
        foreach ($name in $script:SetupVariables) {
            $path = Join-Path $script:SolutionSource "environmentvariabledefinitions\$name\environmentvariabledefinition.xml"
            Test-Path -LiteralPath $path | Should -BeTrue -Because $name
            $definition = [xml](Get-Content -LiteralPath $path -Raw)
            $definition.environmentvariabledefinition.schemaname | Should -Be $name
            $definition.environmentvariabledefinition.type | Should -Be '100000000'
            $definition.environmentvariabledefinition.isrequired | Should -Be '0'
            $definition.environmentvariabledefinition.PSObject.Properties['defaultvalue'] | Should -BeNullOrEmpty
        }
    }

    It 'keeps the packaged web resources identical to the sources' {
        $map = @{
            'segment-preview-setup.html'        = 'webresources\segment-preview-setup.html'
            'segment-preview-provisioning.js'   = 'webresources\segment-preview-provisioning.js'
            'segment-preview-azure-template.js' = 'webresources\segment-preview-azure-template.js'
            'segment-preview-payload.js'        = 'webresources\segment-preview-payload.js'
        }

        foreach ($entry in $map.GetEnumerator()) {
            $packaged = Join-Path $script:SolutionSource "WebResources\klth_\SegmentSankey\$($entry.Key)"
            $source = Join-Path $script:RepositoryRoot $entry.Value
            Test-Path -LiteralPath $packaged | Should -BeTrue -Because $entry.Key
            (Get-FileHash -LiteralPath $packaged).Hash | Should -Be (Get-FileHash -LiteralPath $source).Hash
        }
    }

    It 'ships the app sitemap only as a managed additive patch' {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        function Read-SolutionArchiveXml {
            param(
                [Parameter(Mandatory)] [string] $ArchivePath,
                [Parameter(Mandatory)] [string] $EntryName
            )

            $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
            try {
                $entry = $archive.GetEntry($EntryName)
                $entry | Should -Not -BeNullOrEmpty
                $reader = [IO.StreamReader]::new($entry.Open())
                try {
                    return [xml] $reader.ReadToEnd()
                }
                finally {
                    $reader.Dispose()
                }
            }
            finally {
                $archive.Dispose()
            }
        }

        $unmanagedPath = Join-Path $script:RepositoryRoot 'deployment\dataverse\CustomerInsightsSegmentPreview.zip'
        $managedPath = Join-Path $script:RepositoryRoot 'deployment\dataverse\CustomerInsightsSegmentPreview_managed.zip'
        $unmanagedSolution = Read-SolutionArchiveXml $unmanagedPath 'solution.xml'
        $unmanagedCustomizations = Read-SolutionArchiveXml $unmanagedPath 'customizations.xml'
        $managedSolution = Read-SolutionArchiveXml $managedPath 'solution.xml'
        $managedCustomizations = Read-SolutionArchiveXml $managedPath 'customizations.xml'

        $unmanagedSolution.SelectNodes(
            "/ImportExportXml/SolutionManifest/RootComponents/RootComponent[@type='62' and @schemaName='msdyncrm_MarketingSMBApp']").Count |
            Should -Be 0
        $unmanagedCustomizations.SelectNodes(
            "/ImportExportXml/AppModuleSiteMaps/AppModuleSiteMap[SiteMapUniqueName='msdyncrm_MarketingSMBApp']").Count |
            Should -Be 0

        $managedSolution.SelectNodes(
            "/ImportExportXml/SolutionManifest/RootComponents/RootComponent[@type='62' and @schemaName='msdyncrm_MarketingSMBApp']").Count |
            Should -Be 1
        $managedSiteMap = $managedCustomizations.SelectSingleNode(
            "/ImportExportXml/AppModuleSiteMaps/AppModuleSiteMap[SiteMapUniqueName='msdyncrm_MarketingSMBApp']/SiteMap")
        $managedSiteMap | Should -Not -BeNullOrEmpty
        $managedSiteMap.SelectNodes('.//SubArea').Count | Should -Be 1
        $managedSiteMap.SelectSingleNode(
            ".//SubArea[@Id='klth_SegmentPreviewSetup' and @solutionaction='Added']") |
            Should -Not -BeNullOrEmpty
        $managedSiteMap.SelectSingleNode(".//Group[@Id='Overview_Group']").solutionaction |
            Should -Be 'Modified'
    }
}

Describe 'Documentation entry point' {
    BeforeAll {
        $script:DocRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
    }

    It 'presents the setup center web resource as the only required entry point' {
        $docs = @(
            (Join-Path $script:DocRoot 'README.md'),
            (Join-Path $script:DocRoot 'deployment\README.md'),
            (Join-Path $script:DocRoot 'documentation\setup-center-contract.md')
        )
        foreach ($doc in $docs) {
            Test-Path -LiteralPath $doc | Should -BeTrue -Because $doc
            $text = Get-Content -LiteralPath $doc -Raw
            $text | Should -Match 'Setup Center|setup center'
            $text | Should -Not -Match '(?im)^\s*[-*]?\s*(Required|Step\s*1)[^\r\n]*Install-SegmentPreview\.ps1'
        }
    }

    It 'marks the PowerShell orchestrator as optional in the deployment guide' {
        $text = Get-Content -LiteralPath (Join-Path $script:DocRoot 'deployment\README.md') -Raw
        $text | Should -Match '(?i)optional'
        $text | Should -Match '(?i)never required|not required|optional path'
    }

    It 'never presents a hosted provisioning service as already available or required' {
        $docs = @(
            (Join-Path $script:DocRoot 'README.md'),
            (Join-Path $script:DocRoot 'deployment\README.md'),
            (Join-Path $script:DocRoot 'documentation\setup-center-contract.md')
        )
        foreach ($doc in $docs) {
            $text = Get-Content -LiteralPath $doc -Raw
            $text | Should -Match '(?i)(no (such |publisher |hosted )*(provisioning )?service is (published|deployed|hosted))|(no (hosted )?instance is hosted)|(not deployed)|(does not exist yet)' -Because $doc
            $text | Should -Match '(?i)(never required)|(none is required)|(not required)|(optional)' -Because $doc
        }
    }

    It 'presents the tenant-owned self-service path as the primary installation' {
        $docs = @(
            (Join-Path $script:DocRoot 'README.md'),
            (Join-Path $script:DocRoot 'deployment\README.md'),
            (Join-Path $script:DocRoot 'documentation\setup-center-contract.md')
        )
        foreach ($doc in $docs) {
            $text = Get-Content -LiteralPath $doc -Raw
            $text | Should -Match '(?i)own tenant' -Because $doc
            $text | Should -Match '(?i)tenant and subscription' -Because $doc
        }
    }

    It 'documents the broker contract at the version the engine implements' {
        $contract = Get-Content -LiteralPath (Join-Path $script:DocRoot 'documentation\setup-center-contract.md') -Raw
        $engine = Get-Content -LiteralPath (Join-Path $script:DocRoot 'webresources\segment-preview-provisioning.js') -Raw
        $engine | Should -Match 'CONTRACT_VERSION\s*=\s*"[0-9.]+"'
        $version = [regex]::Match($engine, 'CONTRACT_VERSION\s*=\s*"(?<v>[0-9.]+)"').Groups['v'].Value
        $contract | Should -Match ([regex]::Escape("Contract version: **$version**"))
        $contract | Should -Match '(?i)/v1/sessions'
        $contract | Should -Match 'segment-preview-broker-session'
    }

    It 'keeps the setup environment variable definitions free of default values' {
        $root = Join-Path $script:DocRoot 'solution\src\environmentvariabledefinitions'
        Get-ChildItem -LiteralPath $root -Directory -Filter 'klth_Setup*' | ForEach-Object {
            $file = Join-Path $_.FullName 'environmentvariabledefinition.xml'
            Test-Path -LiteralPath $file | Should -BeTrue -Because $file
            $xml = [xml](Get-Content -LiteralPath $file -Raw)
            $xml.SelectSingleNode('/environmentvariabledefinition/defaultvalue') | Should -BeNullOrEmpty -Because $_.Name
            $xml.environmentvariabledefinition.description.default | Should -Not -BeNullOrEmpty -Because $_.Name
        }
    }
}

Describe 'Browser-only notebook and API deployment' {
    BeforeAll {
        $script:BrowserRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
        $script:Engine = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'webresources\segment-preview-provisioning.js') -Raw
        $script:Payload = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'webresources\segment-preview-payload.js') -Raw
    }

    It 'ships the bootstrap notebook inside the solution payload web resource' {
        $script:Payload | Should -Match 'SegmentPreviewPayload'
        $script:Payload | Should -Match '"format":\s*"ipynb"'
        foreach ($name in @('WORKSPACE_ID', 'SERVING_LAKEHOUSE_ID', 'DATAVERSE_LAKEHOUSE_ID')) {
            $script:Payload | Should -Match $name -Because $name
        }
    }

    It 'keeps the payload web resource in sync with the notebook source' {
        $source = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'Fabric\bootstrap-events.py') -Raw
        $platform = [IO.File]::ReadAllText((Join-Path $script:BrowserRoot 'Fabric\bootstrap-events.platform.json'))
        $displayName = ([regex]::Match($platform, '"displayName"\s*:\s*"(?<n>[^"]+)"')).Groups['n'].Value
        $displayName | Should -Not -BeNullOrEmpty
        $script:Payload | Should -Match ([regex]::Escape($displayName))
        $marker = ([regex]::Match($source, '(?m)^def\s+(?<n>\w+)')).Groups['n'].Value
        if ($marker) { $script:Payload | Should -Match ([regex]::Escape($marker)) }
    }

    It 'creates query-facing Dataverse shortcuts directly from validated target metadata' {
        $source = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'Fabric\bootstrap-events.py') -Raw
        $source | Should -Match '"dataverse"\s*:\s*\{'
        $source | Should -Match '"connectionId"\s*:\s*dataverse_target\.get'
        $source | Should -Match '"deltaLakeFolder"\s*:\s*dataverse_target\.get'
        $source | Should -Match '"environmentDomain"\s*:\s*dataverse_target\.get'
        $source | Should -Match '"tableName"\s*:\s*table_name'
    }

    It 'discovers Journeys Delta folders directly under the serving Files root' {
        $source = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'Fabric\bootstrap-events.py') -Raw
        $source | Should -Match 'EVENT_SOURCE_CANDIDATES\s*=\s*\[[\s\S]*"Files"'
        $source | Should -Match 'list_serving_shortcuts\("Files"\)'
        $source | Should -Match 'item\.get\("path",\s*""\)'
        $source | Should -Match 'request_url\s*=\s*page\.get\("continuationUri"\)'
        $source | Should -Match 'source_root == "Files" and event_name not in root_shortcuts'
        $source | Should -Match 'mssparkutils\.fs\.ls\(f"\{source_root\}/\{event_name\}/_delta_log"\)'
        $source | Should -Match '"target":\s*source_target'
        $source | Should -Match 'def creatable_shortcut_target\(target\)'
        $source | Should -Match 'return \{arm:\s*target\[arm\]\}'
        $source | Should -Not -Match '"target":\s*\{\s*"type"'
    }

    It 'does not depend on Spark SQL registry tables to provision shortcuts' {
        $source = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'Fabric\bootstrap-events.py') -Raw
        $source | Should -Not -Match 'spark\.sql'
        $source | Should -Not -Match 'saveAsTable'
        $source | Should -Not -Match 'createDataFrame'
        $source | Should -Match 'Bootstrap completed with incomplete shortcuts'
    }

    It 'publishes the notebook from the browser through the Fabric definition API' {
        $script:Engine | Should -Match '/updateDefinition\?updateMetadata='
        $script:Engine | Should -Match 'definition\.parts\.some'
        $script:Engine | Should -Match 'InlineBase64'
        $script:Engine | Should -Match 'jobs/'
        $script:Engine | Should -Match 'buildNotebookDefinition'
    }

    It 'deploys the API package from the browser through the Web App settings' {
        $script:Engine | Should -Match 'WEBSITE_RUN_FROM_PACKAGE'
        $script:Engine | Should -Match 'config/appsettings/list'
        $script:Engine | Should -Match '/restart'
        $script:Engine | Should -Match 'klth_SetupApiPackageUrl'
    }

    It 'has the Azure deployment copy the package instead of the browser' {
        $bicep = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'deployment\azure\main.bicep') -Raw
        foreach ($needle in @(
                'apiPackageUrl',
                'apiPackageSha256',
                'Microsoft.ContainerInstance/containerGroups',
                'Microsoft.Network/privateEndpoints',
                'Microsoft.Network/privateDnsZones',
                'virtualNetworkSubnetId',
                'sha256sum',
                '--auth-mode login',
                'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID')) {
            $bicep | Should -Match ([regex]::Escape($needle)) -Because $needle
        }
        $bicep | Should -Match 'allowSharedKeyAccess:\s*false'
        $bicep | Should -Match 'allowBlobPublicAccess:\s*false'
        $bicep | Should -Match "publicNetworkAccess:\s*'Disabled'"
        $bicep | Should -Not -Match '(?i)listServiceSas|listAccountSas'
    }

    It 'never fetches the release asset cross origin from the page' {
        $script:Engine | Should -Not -Match 'fetchBytes'
        $script:Engine | Should -Not -Match 'putBlob'
        $script:Engine | Should -Match 'apiPackageSha256'
        $script:Engine | Should -Match 'shared access signature'
    }

    It 'never refers the administrator to a local script for these steps' {
        $script:Engine | Should -Not -Match '(?i)deploy-api\.ps1'
        $script:Engine | Should -Not -Match '(?i)offline script'
        $script:Engine | Should -Not -Match '(?i)Install-SegmentPreview\.ps1'
    }

    It 'refuses to deploy the template when no verified package is pinned' {
        $script:Engine | Should -Match 'No verified API package'
        $bicep = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'deployment\azure\main.bicep') -Raw
        $bicep | Should -Match 'dependsOn:\s*deployPackage\s*\?\s*\[\s*packageCopy\s*\]'
    }

    It 'waits for the API to answer before reporting it as installed' {
        $script:Engine | Should -Match 'apiHealth'
        $script:Engine | Should -Match 'HEALTH_ATTEMPTS'
        $script:Engine | Should -Match 'HEALTH_DELAY_MS'
    }

    It 'opens only the health and authenticated key-check probes to the setup origin' {
        $cors = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'FabricApi\SetupHealthCors.cs.txt') -Raw
        $program = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'FabricApi\Program.cs.txt') -Raw
        $cors | Should -Not -Match 'AllowAnyOrigin'
        $program | Should -Match 'DATAVERSE_ENVIRONMENT_URL'
        $program | Should -Match 'RequireCors\(SetupHealthCors\.PolicyName\)'
        $program | Should -Match 'RequireCors\(SetupHealthCors\.KeyCheckPolicyName\)'
        $program | Should -Match '"/api/setup/key-check"'
        $program | Should -Match '\.WithHeaders\("Accept", "x-api-key"\)'
        $program | Should -Match 'WithMethods\("GET"\)'
        ([regex]::Matches($program, 'RequireCors\(')).Count | Should -Be 2
    }

    It 'sends the pinned package to the optional provisioning service too' {
        $script:Engine | Should -Match 'apiPackage:'
        $contracts = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'Broker\Contracts.cs.txt') -Raw
        $contracts | Should -Match 'class ApiPackage'
        $executor = Get-Content -LiteralPath (Join-Path $script:BrowserRoot 'Broker\AzureFabricProvisioningExecutor.cs.txt') -Raw
        $executor | Should -Match 'VerifyPackageSettings'
        $executor | Should -Match 'apiPackageSha256'
    }

    It 'installs the missing Dataverse shortcuts inside the same run' {
        $script:Engine | Should -Match 'needsShortcutProvisioning'
        $script:Engine | Should -Match 'PROVISION_SHORTCUTS_ACTION'
        $script:Engine | Should -Match 'provision-shortcuts'
    }

    It 'asks for no delegated Fabric permission beyond the least-privilege set' {
        $scopes = ([regex]::Match(
                $script:Engine,
                'FABRIC_DELEGATED_SCOPES\s*=\s*\[(?<body>[^\]]*)\]')).Groups['body'].Value
        $scopes | Should -Not -BeNullOrEmpty
        $names = [regex]::Matches($scopes, '"(?<n>[^"]+)"') | ForEach-Object { $_.Groups['n'].Value }
        $names | Should -Be @('Workspace.ReadWrite.All', 'Item.ReadWrite.All', 'Item.Execute.All', 'Capacity.Read.All', 'OneLake.Read.All', 'Connection.ReadWrite.All')
    }
}

Describe 'Resume fact hydration' {
    BeforeAll {
        $errors = $null
        $tokens = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:OrchestratorPath, [ref] $tokens, [ref] $errors)

        $wanted = @('Get-ConfigValue', 'Set-ConfigValue', 'Get-StepFactSnapshot', 'Restore-SegmentPreviewFact')
        $functions = $ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
            }, $true) | Where-Object { $wanted -contains $_.Name }

        $map = $ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                $node.Left.Extent.Text -eq '$script:FactConfigName'
            }, $true) | Select-Object -First 1

        # The helpers live in the orchestrator, so they are lifted out of its
        # syntax tree and evaluated in isolation instead of running the script.
        $body = @(
            'param([hashtable] $Config, [hashtable] $Fact)'
            (($functions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)
            $map.Extent.Text
            '$script:Config = $Config'
            '$restored = Restore-SegmentPreviewFact -Fact $Fact'
            '[pscustomobject]@{ Restored = @($restored); Config = $script:Config }'
        ) -join [Environment]::NewLine
        $script:FactHarness = [scriptblock]::Create($body)
    }

    It 'restores every configuration value a later step reads' {
        $result = & $script:FactHarness -Config @{} -Fact @{
            fabricWorkspaceId          = 'ws-1'
            fabricServingLakehouseId   = 'lh-1'
            fabricSqlServer            = 'sql.fabric.microsoft.com'
            fabricSqlDatabase          = 'db-1'
            fabricNotebookId           = 'nb-1'
            apiBaseUrl                 = 'https://segment-preview.azurewebsites.net/api/'
            managedIdentityPrincipalId = 'principal-1'
        }

        $result.Config['FabricWorkspaceId'] | Should -Be 'ws-1'
        $result.Config['FabricServingLakehouseId'] | Should -Be 'lh-1'
        $result.Config['FabricSqlServer'] | Should -Be 'sql.fabric.microsoft.com'
        $result.Config['FabricSqlDatabase'] | Should -Be 'db-1'
        $result.Config['FabricNotebookId'] | Should -Be 'nb-1'
        $result.Config['ApiBaseUrl'] | Should -Be 'https://segment-preview.azurewebsites.net/api/'
        $result.Config['ManagedIdentityPrincipalId'] | Should -Be 'principal-1'
    }

    It 'never overwrites a value the caller supplied explicitly' {
        $result = & $script:FactHarness -Config @{ FabricWorkspaceId = 'explicit' } -Fact @{ fabricWorkspaceId = 'stored' }

        $result.Config['FabricWorkspaceId'] | Should -Be 'explicit'
        $result.Restored | Should -Not -Contain 'FabricWorkspaceId'
    }

    It 'ignores an empty fact' {
        $result = & $script:FactHarness -Config @{} -Fact @{ apiBaseUrl = '  ' }

        $result.Config.ContainsKey('ApiBaseUrl') | Should -BeFalse
    }

    It 'tolerates a state file without facts' {
        $result = & $script:FactHarness -Config @{} -Fact $null

        $result.Restored.Count | Should -Be 0
    }

    It 'records the Fabric discovery and notebook facts' {
        $content = Get-Content -LiteralPath $script:OrchestratorPath -Raw
        $content | Should -Match 'Get-StepFactSnapshot -Name @\(\s*.FabricWorkspaceId'
        $content | Should -Match 'Get-StepFactSnapshot -Name @\(.FabricNotebookId'
    }

    It 'hydrates the recorded facts before the loop skips a completed step' {
        $content = Get-Content -LiteralPath $script:OrchestratorPath -Raw
        $hydrate = $content.IndexOf('Restore-SegmentPreviewFact -Fact $storedFacts')
        $skip = $content.IndexOf('Already completed in an earlier run')

        $hydrate | Should -BeGreaterThan 0
        $skip | Should -BeGreaterThan $hydrate
    }

    It 'invalidates completed deployment steps when release artifacts change' {
        $content = Get-Content -LiteralPath $script:OrchestratorPath -Raw
        $content | Should -Match 'Get-CurrentReleaseIdentity'
        $content | Should -Match 'storedReleaseIdentity -ne \$releaseIdentity'
        $content | Should -Match 'Reset-SegmentPreviewStateFrom -State \$state -StepId ''fabric-notebook'''
        $content.IndexOf('storedReleaseIdentity -ne $releaseIdentity') |
            Should -BeLessThan $content.IndexOf('Already completed in an earlier run')
    }
}
