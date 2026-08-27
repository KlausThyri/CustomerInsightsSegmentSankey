# Segment Preview deployment

The Segment Preview consists of three deployable parts:

| Part | Content |
|---|---|
| `azure/` | Bicep template for the App Service plan, Web App, Application Insights, Log Analytics, system-assigned managed identity, and all application settings. |
| Microsoft Fabric | Serving lakehouse, SQL analytics endpoint, Dataverse mirror shortcuts, and the daily bootstrap notebook in `Fabric/`. |
| `dataverse/CustomerInsightsSegmentPreview_managed.zip` | Plugins, custom APIs, environment variable definitions, web resources, the segment command, and the **Settings > Overview > Segment Preview** navigation entry. |
| `dataverse/CustomerInsightsSegmentPreview.zip` | Unmanaged developer-upgrade package. It deliberately omits the Marketing app Sitemap so importing it cannot replace customer-owned navigation. Open the Setup web resource directly when installing this package in a development environment. |

The Setup Center is the entry point. Importing the managed solution and pressing
one button on the setup page is the whole installation procedure — **nothing has
to be installed on your computer**.

| Path | Who it is for | Entry point |
|---|---|---|
| **Setup Center (the product's installer)** | Every administrator. Import the managed solution, open the setup page, press one button. | **Settings > Overview > Segment Preview** |
| PowerShell orchestrator (optional) | CI pipelines and scripted re-deployments. Never required. | `deployment/Install-SegmentPreview.ps1` |

Both drive the same steps, use the same step ids, and produce the same result.

---

## 1. Setup Center - the one-button path

### Install

1. Import `deployment/dataverse/CustomerInsightsSegmentPreview_managed.zip` into
   an environment where Customer Insights - Journeys is installed.
2. Open **Customer Insights - Journeys > Settings > Overview > Segment Preview**.
3. First time only: expand **Connect this environment** and register the
   single-page application in your own tenant (guided by the page).
4. Fill in the target fields (subscription, resource group, location, web app
   name, Fabric workspace/lakehouse). The page pre-fills everything it can read.

The managed package contributes only the `klth_SegmentPreviewSetup` SubArea as
an additive Sitemap difference. It does not ship a complete Customer Insights -
Journeys Sitemap, so navigation entries supplied by the customer or other
managed solutions are preserved. Do not use the unmanaged developer package for
a customer installation.
   In direct mode, **Load subscriptions** lists the enabled subscriptions in your
   Azure tenant. Selecting one loads its existing Resource Groups; the same
   selector also offers **Create a new resource group**. Broker mode keeps a
   manual subscription-id field because Azure discovery is not available there.
   When a new Fabric workspace must be created, **Load capacities** lists the
   active Fabric capacities available to the signed-in account. An existing
   workspace does not require a capacity selection.
   Only subscription and Resource Group are required for a new installation.
   Setup generates and discovers the remaining values. **Advanced options**
   allows overriding them or selecting an existing Fabric Capacity; otherwise
   setup chooses a suitable active capacity automatically.
5. Press **Preview** to see the plan, the consent checklist and the exact set of
   changes - nothing is written.
6. Press **Install everything**. You are asked to sign in to Microsoft once, in a
   pop-up. Progress is reported per step, and the page can be closed and
   reopened: completed steps are recorded in `klth_SetupConfiguration` and are
   skipped on the next run.

The page writes `klth_FabricBehavioralApiUrl` and `klth_FabricBehavioralApiKey`
itself using your Dataverse session, generates the server-side API key in the
browser with `crypto.getRandomValues`, and never displays or stores the key -
only a `sha256:<16 hex>` fingerprint is persisted.

### How the environment gets connected

The Setup Center provisions the Azure API that the product later talks to, so it
cannot use that API to provision itself. Your Dataverse session also grants no
Azure or Fabric rights. Something therefore has to obtain delegated
Azure/Fabric permissions, and that needs an Entra application. The Setup Center
supports two shapes, and both are browser workflows.

| Mode | Requires | Configured through |
|---|---|---|
| `direct` (primary, self-service) | A single-page Entra app you register **in your own tenant**, whose redirect URI is this environment's setup page. **Connect this environment** shows the exact redirect URI and permissions, opens the Entra admin center for you and writes the client id back. | `klth_SetupEntraClientId` |
| `broker` (optional) | The HTTPS address of a hosted **provisioning service**. Sign-in happens in a pop-up on that service, against its own multi-tenant application and its own fixed callback address, so nothing is registered per environment. | `klth_SetupBrokerUrl` |
| `manual` | Nothing. The honest fallback until the environment is connected. | - |

> **Everything you install stays in your own tenant.** The Entra registration,
> the Azure resource group, Web App and Application Insights, the Fabric
> workspace, lakehouse and role assignments, and every Dataverse value are
> created in and owned by your own tenant and subscription. No data and no
> credential leaves them. This is a self-service installation: you perform the
> guided steps yourself, and no service operated by anyone else is involved.

> **No hosted provisioning service is published, and none is needed.** This
> repository ships no service URL, no client id and no secret, and it never
> invents one. The Setup Center says exactly this on the page instead of
> pretending a service exists.

Why `direct` is the primary shape: nothing is shared and nothing is central, the
whole registration is guided from the page, the application is an ordinary tenant
app that you can delete afterwards to revoke every permission the installation
used, and there is no service to host or pay for.

Trade-off of `direct`, stated honestly: one app registration **per environment**,
because Entra requires SPA redirect URIs to be registered in advance and allows no
wildcards; delegated Azure and Fabric tokens live in the browser tab for the
duration of the run; and it depends on Entra CORS plus a permissive enough CSP. It
is a public client (single-page application) with no secret.

The optional `broker` mode exists for organisations installing into many
environments that would rather run one hosted service than register one app per
environment, or that want ARM/Fabric tokens to stay on a server. What the browser
enforces in that mode: `https` service URLs only; the sign-in URL returned by the
service must share the service's origin, or no window is opened at all; every
`postMessage` must match origin, message type, session id and a per-session nonce;
and the session record is discarded when it expires or belongs to a different
service or environment.

In `manual` mode the plan contains only `preflight` and `verify`, so pressing the
button on an unconnected tenant is harmless and cannot rotate the API key.

Sign-in in direct mode uses the engine's own OAuth 2.0 authorization-code + PKCE
pop-up client; no third-party library and no CDN are involved, because the
Dataverse content security policy blocks CDN script loading. `offline_access` is
requested so the Azure and Fabric tokens both come from a single sign-in. Tokens
live in memory only and are dropped when the run ends.

`documentation/setup-center-contract.md` is the normative contract: the exact app
registration for the primary path, the token flow, the environment variables, the
step ids, the resume record, the optional provisioning service REST shape
(`/v1/sessions`, `/v1/sessions/{id}/runs`) and the `postMessage` envelope. §7 of
that document lists what would have to be deployed to make the optional broker
mode real.

### The optional provisioning service source

`Broker/` in this repository is a working implementation of that optional service
- endpoints, PKCE code redemption, opaque session tokens, the origin-validated
callback page and the ARM/Fabric executor - with its own test suite:

```powershell
dotnet test Broker.Tests\CustomerInsightsSegmentSankey.Broker.Tests.csproj
```

What is still missing is **not code**: someone would have to register the
multi-tenant Entra application, host an instance and publish its URL. Those are
operator tasks listed in [`Broker/README.md`](../Broker/README.md); a customer
never performs them and never needs them. No client id, secret or service URL
exists in this repository.

### Setup Center configuration variables

All seven are optional strings that ship **without default values**, so importing
the solution never introduces a credential.

| Variable | Purpose |
|---|---|
| `klth_SetupEntraClientId` | Primary. Client id of the single-page app you register in your own tenant. Written by **Connect this environment**. |
| `klth_SetupProvisioningMode` | Forces `direct`, `broker` or `manual`. Blank = auto-detect (`direct` wins when both are configured). |
| `klth_SetupBrokerUrl` | Optional. HTTPS base URL of a hosted provisioning service, if one is used instead of the self-service path. |
| `klth_SetupBrokerScope` | Optional, legacy. Only for a self-hosted service that authorizes by delegated API scope instead of the browser session. |
| `klth_SetupApiPackageUrl` | Optional. HTTPS URL of the published API package. Blank uses the pinned release asset that ships with the solution; set it only to point your Web App at your own mirrored copy. |
| `klth_SetupConfiguration` | Target configuration and resume state. Secrets are stripped before writing; no session token is ever written to Dataverse. |
| `klth_BusinessUnitScopingEnabled` | `true` when the irreversible Customer Insights - Journeys Business unit scoping feature is enabled. Setup writes the explicit administrator choice because Microsoft exposes no supported read API. Exact owning-BU equality is applied; child BUs are excluded. |

### What the browser deploys, and how

Two steps look as if they need a build machine. Neither does.

**Fabric bootstrap notebook.** The notebook is converted from
`Fabric/bootstrap-events.py` into a Jupyter document at *release* time by
`deployment/Update-SetupPayloadWebResource.ps1` and shipped inside the solution as
the web resource `segment-preview-payload.js`. The browser substitutes the
resolved workspace and lakehouse ids into the notebook's three top-level
constants, base64-encodes it, and calls the Fabric item-definition API directly:
`updateDefinition?updateMetadata=true` for an existing notebook, otherwise
`POST workspaces/{id}/notebooks`. The daily schedule from
`Fabric/bootstrap-events.schedules.json` is created only when the notebook has no
schedule yet, so a cadence you changed yourself survives an upgrade.

**Segment Preview API.** A published ASP.NET Core output cannot be produced in a
browser and is too large for a web resource, so the API is deployed as a pinned,
digest-verified package instead of as a build — and the copy happens inside your
subscription, not in the browser. A GitHub release asset answers a cross-origin
`GET` without `Access-Control-Allow-Origin`, so the page cannot download it, and
Kudu sends no CORS headers either. Instead `azure-infra` passes the pinned URL and
SHA-256 to the ARM template, which creates a private storage account, VNet,
private Blob endpoint and DNS zone in your resource group, runs a short-lived
Azure Container Instance in that VNet that downloads the
package, verifies the digest with `sha256sum`, uploads it as an
immutable blob, grants the Web App's own system-assigned identity **Storage Blob
Data Reader**, and sets `WEBSITE_RUN_FROM_PACKAGE` (a clean URL, no signature),
`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`,
`SEGMENT_PREVIEW_PACKAGE_VERSION` and `SEGMENT_PREVIEW_PACKAGE_SHA256`. The
account key is never created or used: the container obtains an Entra storage
token through its managed identity and `allowSharedKeyAccess` stays `false`. The blob name embeds the digest, so a
repeat run is a no-op. The later `azure-app` step reads those settings back and
fails the run if any of them is wrong, restarts the Web App, and then polls
`/api/health` for about five minutes until the API really answers — the blob
mount and the role assignment both take effect asynchronously. To make that poll
possible the API allows cross-origin `GET` requests on `/api/health` only, and
only from the origins in its own `DATAVERSE_ENVIRONMENT_URL` setting; every other
endpoint stays unreachable from a browser.

Both the copy container and the Web App use dedicated delegated subnets. Storage
public network access remains disabled, so hardened tenants that enforce private
storage do not need a policy exception.

> Maintainer step, not a customer step: the release pipeline stamps the package
> URL and SHA-256 into `segment-preview-payload.js` with
> `deployment/Update-SetupPayloadWebResource.ps1 -ApiPackageUrl <https url> -ApiPackageSha256 <hash>`
> before the solution is packaged. A build without a stamped, verifiable package
> cannot install: `azure-infra` stops before it calls Azure and the page names the
> environment variable to set. That is deliberate — the template writes the Web App
> settings as a complete set, so deploying it without a package would strip the
> run-from-package settings from an environment that was already serving the API.
> It never asks anyone to run a script.

### Browser tests

```powershell
node --test "webresources/tests/**/*.test.cjs"
```

The suite is hermetic - `fetch`, the sign-in pop-up, the provisioning service and
MSAL are all mocked, and a dry run is asserted to make zero network calls. It
covers validation, mode resolution and blockers, the app-registration guidance,
the PKCE token client (challenge, cache, refresh-token reuse, pop-up blocking,
state mismatch), the broker session client (origin and nonce validation, blocked
pop-ups, run start/poll/re-attach, session storage scoping and expiry), secret
generation, secret stripping, HTTP retry, the Dataverse/broker/direct clients,
orchestration and resume, the setup page markup, solution packaging, and drift
between `azure/main.bicep`, `azure/main.json` and the generated
`webresources/segment-preview-azure-template.js`.

Regenerate the browser copy of the ARM template after any Bicep change:

```powershell
pwsh -File .\deployment\azure\Update-AzureTemplateWebResource.ps1
```

---

## 2. Optional path - the PowerShell orchestrator

`Install-SegmentPreview.ps1` provisions and connects all three parts in a single,
idempotent run. It is **never required**: it exists for CI pipelines and scripted
re-deployments. If you want a scripted run without installing anything locally,
open [Azure Cloud Shell](https://shell.azure.com) in the browser and run it there.

### Quickstart

```powershell
pwsh -File .\deployment\Install-SegmentPreview.ps1 `
  -DataverseEnvironmentUrl https://contoso.crm4.dynamics.com `
  -ResourceGroup rg-segment-preview `
  -Location westeurope `
  -WebAppName contoso-segment-preview `
  -FabricWorkspaceName "Customer Insights Serving" `
  -FabricCapacityId <fabric-capacity-guid>
```

Or with a configuration file:

```powershell
Copy-Item .\deployment\install-config.example.json .\deployment\install-config.json
# edit install-config.json, then:
pwsh -File .\deployment\Install-SegmentPreview.ps1 -ConfigFile .\deployment\install-config.json
```

Before anything is changed, run the plan and consent report:

```powershell
pwsh -File .\deployment\Install-SegmentPreview.ps1 -ConsentReportOnly
```

`-WhatIf` performs the same discovery as a real run but makes no write call.

### Prerequisites

| Requirement | Notes |
|---|---|
| PowerShell 7.2+ | `pwsh`. Windows PowerShell 5.1 is not supported. |
| Azure CLI 2.50+ | Provides the sign-in and every access token (ARM, Fabric, Dataverse). |
| .NET 8 SDK | Only required to build and publish the API (`-SkipApiDeployment` removes the dependency). |
| Azure subscription | Contributor on the target subscription or resource group. |
| Fabric workspace | Admin or Member on the workspace, plus an F/P capacity. |
| Dataverse | System Administrator in the target environment. |

The installer never asks for a second sign-in. One `az login` produces the
tokens for Azure Resource Manager, `https://api.fabric.microsoft.com`, and the
Dataverse Web API.

### What the orchestrator does

| # | Step id | Action |
|---|---|---|
| 1 | `preflight` | Validates tooling, PowerShell version, URLs, GUIDs, web app name, table list, and reads the managed solution manifest. |
| 2 | `signin` | Reuses or creates an Azure CLI session and selects the subscription. |
| 3 | `fabric-discovery` | Finds or creates the workspace and the serving lakehouse, resolves the SQL analytics endpoint, finds the Dataverse mirror lakehouse and the Dataverse cloud connection. |
| 4 | `fabric-notebook` | Injects the resolved workspace/lakehouse ids into `Fabric/bootstrap-events.py`, converts it to `.ipynb`, creates or updates the notebook, and creates the daily schedule from `Fabric/bootstrap-events.schedules.json`. |
| 5 | `secret` | Reuses the existing `BEHAVIORAL_API_KEY`, or generates a new 48-byte CSPRNG key. |
| 6 | `azure-infra` | Creates the resource group and deploys `azure/main.bicep` with every resolved value. |
| 7 | `fabric-permissions` | Assigns the Contributor workspace role to the Web App managed identity. |
| 8 | `azure-app` | `dotnet publish`, zips, and deploys the API, then polls `/api/health`. |
| 9 | `dataverse-import` | Imports or stages-and-upgrades the managed solution and waits for the async job. |
| 10 | `dataverse-config` | Writes `klth_FabricBehavioralApiUrl` and `klth_FabricBehavioralApiKey` environment variable values and publishes customizations. |
| 11 | `verify` | Calls `/api/setup/status` and prints the same component readiness the in-product setup center shows. |

### Parameters

| Parameter | Purpose |
|---|---|
| `-ConfigFile` | JSON file using the same names. Explicit parameters win. |
| `-DataverseEnvironmentUrl` | **Required.** `https://<org>.crm<n>.dynamics.com`. |
| `-SubscriptionId` | Azure subscription. Defaults to the current CLI subscription. |
| `-ResourceGroup` | Default `rg-segment-preview`. |
| `-Location` | Default `westeurope`. |
| `-WebAppName` | Globally unique, 2-40 lower-case characters. |
| `-FabricWorkspaceId` / `-FabricWorkspaceName` | One of the two is required unless `-SkipFabric` is used. |
| `-FabricCapacityId` | Required only to create a new workspace. |
| `-FabricServingLakehouseId` / `-FabricServingLakehouseName` | Default name `SegmentPreviewServing`. |
| `-FabricDataverseLakehouseId` / `-FabricDataverseLakehouseName` | The Dataverse mirror lakehouse. |
| `-FabricDataverseConnectionId` | Fabric cloud connection to Dataverse. Auto-discovered when omitted. |
| `-FabricDataverseDeltaFolder` | Default `deltalake`. |
| `-RequiredDataverseTables` | Default `contact,msdynmkt_contactpointconsent4,msdynmkt_purpose,msdynmkt_topic`. |
| `-SolutionPackagePath` | Defaults to `deployment/dataverse/CustomerInsightsSegmentPreview_managed.zip`. |
| `-BehavioralApiKey` | `SecureString`. Only needed to reuse a key the installer did not create. |
| `-RotateApiKey` | Generates a new key and updates Azure and Dataverse together. |
| `-StateDirectory`, `-DeploymentName` | Location and name of the resume state file. |
| `-FromStep` | Repeats the given step and everything after it. |
| `-SkipFabric`, `-SkipAzure`, `-SkipDataverse`, `-SkipApiDeployment`, `-SkipNotebook` | Partial runs. |
| `-ConsentReportOnly` | Prints the plan and consent matrix, changes nothing. |
| `-NonInteractive` | Fails instead of opening a sign-in prompt. |
| `-Force` | Clears the resume state and reinstalls the solution at the same version. |
| `-WhatIf` / `-Confirm` | Standard `ShouldProcess` support. |

### Resume, repeat, and recover

* Every completed step is recorded in
  `deployment/.provisioning-state/<deployment>.state.json` (git-ignored).
* Re-running the same command skips completed steps. `preflight`, `signin`, and
  `secret` always run because they only rebuild in-memory context.
* `-FromStep <id>` clears that step and all later steps, for example
  `-FromStep azure-app` to redeploy only the API.
* `-Force` clears the whole state file.
* A failed run prints the failing step id and the exact remediation; fix the
  cause and re-run the identical command.

The state file contains no secret. The API key is represented only by a
`sha256:<16 hex>` fingerprint.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No Azure CLI session exists` | Run `az login`, then re-run. |
| `A Fabric access token could not be acquired` | Approve the one-time Azure CLI consent for `https://api.fabric.microsoft.com`. |
| `The Fabric workspace '<name>' was not found` | Supply `-FabricCapacityId` to create it, or use `-FabricWorkspaceId`. |
| `The Fabric SQL analytics endpoint is not available yet` | The lakehouse endpoint is still provisioning. Wait until the Fabric portal reports *Success*, then re-run. |
| `No Fabric cloud connection for '<env>' exists` | Create a Dataverse connection in **Fabric > Settings > Manage connections and gateways**, then re-run or pass `-FabricDataverseConnectionId`. |
| `The Dataverse mirror lakehouse was not found` | Enable **Link to Microsoft Fabric** in the Power Platform maker portal. |
| `The Link to Microsoft Fabric Lakehouse does not contain ...` | In **Tables > Analyze > Link to Microsoft Fabric**, add the named primary `contact` table and wait until it appears in the linked Lakehouse before retrying. |
| `A Dataverse access token ... could not be acquired` | Approve the one-time Azure CLI consent for the environment. |
| Solution import reports `conflict` | An **unmanaged** `klth_SegmentPreview` solution exists. Remove it before importing the managed package. |
| Solution import reports `downgrade-blocked` | The installed version is newer than the package. Use `-Force` only if a downgrade is intended. |
| `/api/health` never becomes healthy | Check Application Insights and the Web App log stream; the app settings are written before the code is deployed, so an early 503 is expected. |

### PowerShell tests

```powershell
pwsh -File .\deployment\tests\Invoke-ProvisioningTests.ps1
```

The suite is hermetic - it never contacts Azure, Fabric, or Dataverse. It covers
secret generation, input normalization and validation, solution-manifest and
upgrade-action logic, notebook parameterization and `.ipynb` conversion,
configuration precedence, resume-state behaviour, and structural invariants of
the orchestrator (every catalog step has a handler and a `-FromStep` value).

---

## 3. Manual and partial paths

The individual assets remain usable on their own.

### Azure only

```powershell
Copy-Item .\deployment\azure\main.bicepparam.example .\deployment\azure\my.bicepparam
# fill in the values, then:
.\deployment\azure\deploy-api.ps1 `
  -ResourceGroup <resource-group> `
  -WebAppName <globally-unique-app-name> `
  -ParametersFile .\deployment\azure\my.bicepparam
```

`deploy-api.ps1` accepts both a `.bicepparam` file and a classic
`parameters.json`. Never commit a populated parameter file.

### Dataverse only

Import `dataverse/CustomerInsightsSegmentPreview_managed.zip` into an
environment where Customer Insights - Journeys is installed and set:

* `klth_FabricBehavioralApiUrl` - the Web App URL ending in `/api/`
* `klth_FabricBehavioralApiKey` - the same server-side key configured in Azure

The solution extends the existing app:

* App unique name: `msdyncrm_MarketingSMBApp`
* Area: `Settings`
* Group: `Overview_Group`
* Menu item: `Segment Preview`

### Rebuild packages

```powershell
.\solution\build-solution.ps1 -Configuration Release
```

This builds the signed plugin, synchronizes all web resources into the solution
source, and produces managed and unmanaged packages under `deployment/dataverse/`.

The production strong-name key is intentionally not stored in the repository.
The checked-in managed package already contains the signed plugin. Maintainers
who rebuild an upgrade for an existing installation must provide
`CustomerInsightsSegmentSankey.snk` through an approved secure channel. Without
that file, the plugin project builds unsigned for development purposes and the
result is **not** upgrade-compatible with an existing installation.

### Regenerate the setup payload (maintainers)

`webresources/segment-preview-payload.js` carries the bootstrap notebook
definition and the API package metadata that the browser deploys. Regenerate it
whenever anything under `Fabric/` changes, and stamp the release asset into it
before packaging a release:

```powershell
.\deployment\Update-SetupPayloadWebResource.ps1 `
  -ApiPackageUrl  https://github.com/<owner>/<repo>/releases/download/v1.1.0/segment-preview-api-1.1.0.zip `
  -ApiPackageSha256 <64-hex sha256 of that zip>
```

Both parameters are optional. Omitted, the payload keeps an empty package URL:
the Setup Center's `azure-infra` step then stops before it calls Azure and tells
the administrator which environment variable to set, so an unstamped build is
usable for development but cannot install the API. The URL must be
absolute `https`, and the script writes the file to `webresources/` and to the
packaged copy under `solution/src/WebResources/` so the byte-identity guards in
both test suites keep passing.

---

## Automation coverage (both paths)

The matrix below applies to both entry points unless stated otherwise. In the
Setup Center the *Dataverse managed solution import* row is not applicable - the
solution is already imported, because it is what carries the setup page.

| Area | Coverage | Detail |
|---|---|---|
| Azure resource group | **Full** | Created or updated. |
| App Service plan, Web App, App Insights, Log Analytics | **Full** | `azure/main.bicep`, idempotent redeploy. |
| System-assigned managed identity | **Full** | Created by Bicep, principal id read from the deployment output. |
| Application settings | **Full** | All Fabric/Dataverse settings plus the API key. |
| API build and deployment | **Full** | Setup Center: the ARM deployment copies the pinned, digest-verified release package into a private storage account in your resource group and the Web App reads it with its own managed identity; the browser verifies the applied settings, restarts, and polls `/api/health` until the API answers. PowerShell: `dotnet publish` + `az webapp deploy` + health poll. |
| API package storage | **Full** | Private `StorageV2` account, no public access, no shared key, no shared access signature; created only when a package URL and digest are pinned. |
| API key generation and rotation | **Full** | CSPRNG; `-RotateApiKey` forces a new key, otherwise the existing one is reused so Azure and Dataverse stay in sync. |
| Fabric workspace | **Conditional** | Reused when it exists; created only when `-FabricCapacityId` is supplied. |
| Fabric serving lakehouse | **Full** | Reused or created. |
| Fabric SQL analytics endpoint | **Detect only** | Read from the lakehouse; provisioning is asynchronous and server-side. |
| Fabric workspace role for the managed identity | **Full** | `POST workspaces/{id}/roleAssignments` (Contributor). |
| Fabric bootstrap notebook + daily schedule | **Full** | Created or definition-updated; an existing schedule is preserved. The Setup Center publishes it from the definition shipped in the solution, immediately runs it to register the exported event folders, and waits for completion, so no build machine is involved. |
| Fabric Dataverse mirror lakehouse | **Detect only** | Created by the Dataverse "Link to Microsoft Fabric" feature. Setup verifies that the primary `contact` source table is present before it deploys dependent resources and never mistakes the separate serving Lakehouse for this source. |
| Fabric Dataverse cloud connection | **Detect only** | Requires an interactive OAuth consent in the Fabric portal. |
| Dataverse managed solution import | **Full** | `ImportSolutionAsync` for a fresh install, `StageAndUpgradeAsync` for an upgrade. |
| Dataverse environment variable values | **Full** | Created or patched through the Web API. |
| Dataverse publish | **Full** | `PublishAllXmlAsync` with a `PublishAllXml` fallback. |
| Dataverse shortcut provisioning | **Full** | The `verify` step reads the setup status, and when it still offers `provision-shortcuts` it calls that idempotent action itself and re-reads the status, so one **Install everything** run leaves nothing to press. The shortcuts are created server-side by the Web App's managed identity, so the browser needs no extra Fabric permission. |
| Fabric tenant setting for service principals | **None** | No public write API exists. |
| Customer Insights - Journeys export to Fabric | **Guided** | No public provisioning API exists. When the required export is missing, Setup explicitly says to choose **Files, not Tables**, shows the selected workspace and Serving Lakehouse plus the exact **Get data → New shortcut → Dataverse** steps, the required System Administrator credential, interaction-table selection, links to Fabric and Microsoft's documentation, and the result it will verify. |
| Setup Center bootstrap - direct mode (primary) | **Guided** | Registered once per environment in **your own tenant** through **Connect this environment**, which supplies the exact redirect URI, permissions and portal links and writes the client id back. Entra has no API to create an app registration before an app registration exists, so the portal clicks remain — but they happen in the browser, launched from the setup page. |
| Setup Center bootstrap - broker mode (optional) | **Full, once a service exists** | Paste the HTTPS service URL into the optional panel of **Connect this environment**. Sign-in happens in a pop-up on the service; nothing is registered per environment. Requires a hosted service, which does not exist yet (contract §7) and is never required. |

`-ConsentReportOnly` prints the live version of this matrix, including which
items the current invocation can automate. The Setup Center renders the same
information in its **Preview** view before any change is made.

---

## Interactive consent that cannot be automated (both paths)

| Consent | Who | Why it stays manual |
|---|---|---|
| Microsoft Entra sign-in and MFA | Deploying admin | Conditional access and MFA prompts cannot be suppressed. Setup Center: a sign-in popup is opened by the page. PowerShell: run `az login` beforehand and use `-NonInteractive` for unattended runs. |
| One-time app registration in your tenant | Application Administrator or Global Administrator | Primary (direct) mode. A few clicks in the Microsoft Entra admin center, opened and pre-described by **Connect this environment**. There is no API to register the first application without an application. |
| Admin consent for that application | Global Administrator or Privileged Role Administrator | Primary (direct) mode. The Power BI Service delegated permissions require tenant admin consent. The page offers a **Grant admin consent** button that opens the consent screen. |
| Tenant consent for a hosted provisioning service | Global Administrator or Privileged Role Administrator | Optional broker mode only, once. Shown inside the service sign-in pop-up. Revocable afterwards under **Enterprise applications**. |
| First Azure CLI token for Dataverse | Deploying admin, sometimes tenant admin | PowerShell only. The first `az account get-access-token --resource https://<env>.crm.dynamics.com` in a tenant can require a one-time consent. Approve once, then re-run the same command. |
| Fabric tenant setting **Service principals can use Fabric APIs** | Fabric tenant admin | Admin-portal-only setting; there is no public write API. |
| Fabric capacity purchase or resume | Capacity admin | Commercial decision. Once a capacity exists, the workspace creation is automated. |
| Fabric cloud connection to Dataverse | Workspace admin | The connection is created through an interactive OAuth dialog. Both paths discover an existing one and report clear instructions when none exists. |
| Dataverse **Link to Microsoft Fabric** and the Journeys export to Fabric | Power Platform / CI-J admin | No documented public API. Setup explicitly distinguishes the separate Dataverse source Lakehouse from the Journeys shortcut in the Serving Lakehouse and shows the exact Fabric shortcut workflow when Journeys data is missing. |
| Dataverse System Administrator role | Dataverse admin | Required to import a managed solution and to write environment variable values. |

Everything else in the deployment is automated. Neither path claims
zero-interaction: Microsoft requires a sign-in in every supported flow. Every
item above that applies to the Setup Center happens **in the browser**, started
from the setup page itself.

---

## Secret handling

### Setup Center

* The key is generated in the browser with `crypto.getRandomValues` (48 bytes,
  URL-safe base64, 64 characters, no padding).
* It is held in a JavaScript variable for the duration of the run, sent over TLS
  to Azure (application settings) in direct mode or to the provisioning service in
  broker mode, and written to the Dataverse environment variable value. In broker
  mode the service necessarily learns the key, because it is the component that
  sets the Web App application setting; the contract requires TLS-only transport,
  no logging, and retention only for the lifetime of the run.
* It is never rendered, never logged, and never placed in `klth_SetupConfiguration`:
  `serializeConfiguration` strips `behavioralApiKey`/`apiKey` from both the target
  and the resume state and keeps only a `sha256:<16 hex>` fingerprint.
* A dry run generates no key and makes no network call at all.
* Access tokens in direct mode are kept in memory only, never in `localStorage` or
  `sessionStorage`, and are dropped when the run ends. The app registration you
  create is a public client and holds no secret.
* In broker mode the browser never receives an Azure or Fabric token. It holds
  only an opaque session token in `sessionStorage`, scoped to the service URL and
  the environment, which is cleared on success or when you sign out of the
  service. No session token is ever written to Dataverse.

### PowerShell orchestrator

* The key is generated with `RandomNumberGenerator` (48 bytes, URL-safe base64).
* It is held in memory only, written to the Web App application settings and to
  the Dataverse environment variable value, and cleared in the `finally` block.
* It is never written to a `.bicepparam` file, never logged, and never echoed;
  only the fingerprint is displayed.
* It is passed to `az deployment group create` as an inline
  `--parameters behavioralApiKey=<value>` argument. On a shared machine the
  value is therefore briefly visible in the process list to the same user. Run
  the installer from an administrator workstation.

The solution does not contain a default API key. Each provisioning run generates
a unique key and stores it only in the target customer's Azure App Service and
Dataverse environment variable value.

---

## Verification

Open **Customer Insights - Journeys > Settings > Overview > Segment Preview**.
The Setup Center checks Dataverse, Azure, managed identity, Fabric SQL, Dataverse
shortcuts, and Journeys event tables, and can install missing Dataverse shortcuts
idempotently. Journeys event tables are required for behavioral and
`Interaction(...)` queries. If they are absent, verification fails until the
Customer Insights - Journeys export is enabled and the serving bootstrap notebook
has registered the exported Delta folders.

From a shell:

```powershell
# Azure
curl.exe https://<web-app-name>.azurewebsites.net/api/health

# End-to-end readiness (same data the setup center shows)
pwsh -File .\deployment\Install-SegmentPreview.ps1 -ConfigFile .\deployment\install-config.json -FromStep verify
```
