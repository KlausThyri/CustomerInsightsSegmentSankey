# Segment Preview deployment

The deployment consists of two independently repeatable packages:

- `azure/`: creates the ASP.NET Core Web App, Basic App Service plan, Managed
  Identity, Application Insights, and required application settings.
- `dataverse/CustomerInsightsSegmentPreview_managed.zip`: installs the plugins,
  Custom APIs, environment variable definitions, web resources, segment command,
  and the **Settings > Overview > Segment Preview** navigation entry.

## 1. Deploy Azure

1. Copy `azure/main.bicepparam.example` to a file ending in `.bicepparam`.
2. Set the target Fabric, Dataverse, and API-key values.
3. Run:

   ```powershell
   .\deployment\azure\deploy-api.ps1 `
     -ResourceGroup <resource-group> `
     -WebAppName <globally-unique-app-name> `
     -ParametersFile <parameters-file>
   ```

4. Grant the emitted Managed Identity access to the Fabric workspace and the
   configured Dataverse cloud connection.
5. Confirm that `https://<app-name>.azurewebsites.net/api/health` responds.

The API key is a secure Bicep parameter. Do not commit a populated parameter
file.

## 2. Import the Dataverse solution

Import `dataverse/CustomerInsightsSegmentPreview_managed.zip` into an environment
where Customer Insights - Journeys is installed.

During import, configure:

- `klth_FabricBehavioralApiUrl`: the Web App URL ending in `/api/`
- `klth_FabricBehavioralApiKey`: the same server-side key configured in Azure

The solution extends the existing app with:

- App unique name: `msdyncrm_MarketingSMBApp`
- Area: `Settings`
- Group: `Overview_Group`
- Menu item: `Segment Preview`

## 3. Complete provisioning

Open **Customer Insights - Journeys > Settings > Overview > Segment Preview**.

The setup center checks Dataverse, Azure, Managed Identity, Fabric SQL,
Dataverse shortcuts, and Journeys event tables. Select **Install missing
components** to create missing required Dataverse shortcuts. Actions that need
tenant-level permissions remain explicit and display configuration guidance.

## Rebuild packages

Run:

```powershell
.\solution\build-solution.ps1 -Configuration Release
```

This builds the signed plugin, synchronizes all web resources into the solution
source, and produces managed and unmanaged packages under
`deployment/dataverse/`.

The production strong-name key is intentionally not stored in the repository.
The checked-in managed package already contains the signed plugin. Maintainers
who rebuild an upgrade for an existing installation must provide
`CustomerInsightsSegmentSankey.snk` through an approved secure channel. Without
that file, the plugin project builds unsigned for development purposes.
