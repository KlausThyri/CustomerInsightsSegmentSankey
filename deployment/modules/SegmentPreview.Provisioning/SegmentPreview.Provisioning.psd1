@{
    RootModule        = 'SegmentPreview.Provisioning.psm1'
    ModuleVersion     = '1.0.0'
    GUID              = '4f2b6a1c-9d0e-4a3b-8c77-2f1c6d5b9e41'
    Author            = 'Customer Insights Segment Preview maintainers'
    Description       = 'Deterministic helpers for the Segment Preview one-click provisioning orchestrator.'
    PowerShellVersion = '7.2'
    FunctionsToExport = @(
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
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
