# Segment Preview Setup Center contract

Contract version: **1.1**

This document is the normative description of the interfaces used by the browser
Setup Center (`klth_/SegmentSankey/segment-preview-setup.html` plus
`klth_/SegmentSankey/segment-preview-provisioning.js`). It exists so that the
identifiers the Setup Center reads are documented, and so that a provisioning
service can be implemented against a fixed contract without changing the shipped
solution.

The Setup Center is the **only** entry point of the product. Importing the
managed solution and pressing one button on that page is the whole installation
procedure. Nothing has to be installed on the administrator's computer.

> **Status.** Installation is self-service: each customer imports the solution
> into their own environment and performs the guided steps in their own tenant.
> Every Azure, Fabric and Dataverse resource the Setup Center creates is
> **owned by that customer's tenant and subscription**; no data and no resource
> leaves them, and no shared service operated by anyone else is involved.
> The optional hosted-service (`broker`) path is implemented and unit-tested
> against a mocked service, and its reference source is in `Broker/`, but no
> hosted instance and no service identity exists in this repository. Nothing
> here claims a running service.

### In-app solution updates

Starting with solution 1.1.0.27, Setup can update itself without asking the
administrator to download and import every later solution manually:

1. `Check for updates` reads the repository's latest non-draft GitHub release.
2. Setup queries Dataverse for `klth_SegmentPreview` and selects the managed or
   unmanaged package to match the installed solution type.
3. The package is downloaded from the immutable release tag through
   `raw.githubusercontent.com`, whose response permits the Dataverse browser
   origin. Setup never uses an unversioned `main` branch package.
4. Before import, SHA-256 is calculated with Web Crypto and must equal the
   digest GitHub published for the corresponding release asset.
5. The signed-in administrator's existing Dataverse session calls
   `ImportSolution`. Managed environments preserve unmanaged customizations;
   unmanaged developer environments explicitly overwrite this solution's
   components. The unmanaged archive contains no Marketing sitemap component.
6. Only the Segment Preview web resources are published, then Dynamics reloads
   the page and runs the newly imported code.

The updater introduces no hosted service, secret, or Dataverse application
user. It cannot bypass Dataverse authorization: the signed-in user still needs
the same solution-import privileges as a manual update. Version comparison
allows upgrades only; equal or older GitHub releases are never imported.

---

## 1. The bootstrap problem

The Setup Center provisions the Azure API that the finished product talks to. At
the moment the button is pressed that API does not exist, so the product cannot
provision itself through its own back end. The browser is running inside
Dataverse with a Dataverse session only — that session grants no Azure Resource
Manager or Fabric rights.

Something must therefore obtain delegated Azure/Fabric permissions, and that
needs an Entra application. Two shapes work, and they differ in *who owns the
redirect URI*.

| Mode | What the browser does | What must exist |
| --- | --- | --- |
| `direct` (primary, self-service) | Signs the administrator in with the built-in OAuth 2.0 authorization-code + PKCE pop-up client, then calls Azure Resource Manager and the Fabric REST API itself. | One single-page Entra app registered **in the customer's own tenant**, whose redirect URI is this environment's Setup Center URL. The Setup Center guides that registration and stores the client id in `klth_SetupEntraClientId`. |
| `broker` (optional) | Opens a pop-up on a hosted provisioning service, which signs the administrator in against its own multi-tenant confidential application at its own fixed callback URL, then performs the Azure and Fabric work with delegated permissions. The browser holds only a short-lived session token. | A hosted provisioning service implementing §4 and its multi-tenant Entra application, deployed and operated by whoever chooses to run it. The environment stores only `klth_SetupBrokerUrl`. |
| `manual` | Nothing. Renders the exact ordered checklist so the work can be done by hand in the portals. | Nothing — the honest fallback while the environment is not connected. |

### 1.1 Why `direct` is the primary shape

* **Nothing shared, nothing central.** The customer registers one application in
  their own tenant, and every resource the installation creates — resource group,
  Web App, Application Insights, Fabric workspace membership, Dataverse
  configuration — belongs to that tenant and subscription. No third party is in
  the path and no credential leaves the tenant.
* **Self-service.** All steps are launched and guided from the Setup Center
  itself. The administrator never leaves the browser and never installs anything
  locally; the page supplies the exact redirect URI, permission list and portal
  links, and writes the resulting client id back for them.
* **Revocable.** The registration is an ordinary tenant application. Deleting it
  revokes every permission the installation ever used.
* **Cost.** No service to host, patch or pay for.

The trade-off is stated honestly in §6: because Entra requires SPA redirect URIs
to be registered ahead of time and supports no wildcards, one registration is
needed per Dataverse environment.

### 1.2 When the optional `broker` mode is useful

`broker` exists for organisations that install into many environments and would
rather register one multi-tenant confidential application with a fixed callback
URL than one SPA per environment, or that want ARM/Fabric tokens to stay on a
server instead of in the browser. It is **never required**, it is off unless a
service URL is stored, and the Setup Center says so plainly. Its requirements are
in §7.

### 1.3 What the browser trusts

In `direct` mode the browser is the only actor: tokens are acquired by the
Setup Center pop-up and used directly against ARM and Fabric. Nothing is
persisted beyond the tab.

In the optional `broker` mode the provisioning service is a trusted component: it
receives the generated API key (§4.2) and acts with the administrator's delegated
permissions. The Setup Center reduces that trust surface where the browser can:

* Only `https` service URLs are accepted (`isHttpsUrl`).
* The sign-in URL returned by the service must be on the **same origin** as the
  service URL, otherwise no window is opened at all.
* Every `postMessage` must match origin, message type, session id and the nonce
  generated for that session; anything else is ignored, and a nonce mismatch
  fails the sign-in instead of continuing.
* The session token is held in `sessionStorage` only, scoped to service URL and
  environment, and is discarded on success or on "Sign out of the service".

---

## 2. Configuration surface (Dataverse environment variables)

All configuration lives in environment variables shipped with the managed
solution. They are all optional strings (`type` `100000000`) with **no default
values**, so importing the solution never introduces a credential.

| Schema name | Purpose | Example |
| --- | --- | --- |
| `klth_SetupEntraClientId` | Primary. Client id of the single-page app the administrator registers in their **own** tenant, written by "Connect this environment". | a GUID |
| `klth_SetupProvisioningMode` | Forces a mode. Blank means auto-detect. | `direct`, `broker`, `manual` |
| `klth_SetupBrokerUrl` | Optional. HTTPS base URL of a hosted provisioning service, if one is used instead of the self-service path. | `https://provisioning.example.com` |
| `klth_SetupBrokerScope` | Optional, legacy. Only for a self-hosted service that authorizes by delegated API scope instead of the browser session. | `api://APP-ID/Provisioning.ReadWrite` |
| `klth_SetupApiPackageUrl` | Optional. `<https url> <64 hex sha-256>` of the published API package. Blank uses the URL and digest stamped into `segment-preview-payload.js`; set it only to have the Setup Center copy your own mirrored file. A URL without a digest is refused. | `https://contoso.blob.core.windows.net/api-1.1.0.0.zip 9f2c…` |
| `klth_SetupConfiguration` | Target configuration, resume state and the non-secret facts written back by the Setup Center. | JSON, see §5 |
| `klth_FabricBehavioralApiUrl` | Written on success — the deployed API base URL. | `https://<webapp>.azurewebsites.net/api/` |
| `klth_FabricBehavioralApiKey` | Written on success — the generated server-side key. | 64-character URL-safe token |

Mode resolution rules (implemented in `resolveMode`):

* `direct` requires `klth_SetupEntraClientId` to be a valid, non-empty GUID.
* `broker` requires `klth_SetupBrokerUrl` to be an absolute **https** URL.
* When both are configured and no mode is forced, **`direct` wins**. Setting
  `klth_SetupProvisioningMode` to `broker` overrides that.
* If a mode is explicitly requested but its prerequisites are missing, the engine
  falls back to `manual` and reports the reason; it never guesses.

While the environment is not connected, `resolveMode` reports the blocker
`client-id-not-configured` first, with `owner: "administrator"`,
`optional: false` and `resolvable: "in-page"`, followed by
`broker-not-configured` with `owner: "publisher"` and **`optional: true`** — a
hosted service is never presented as a requirement. Once a service URL exists,
the direct blocker becomes `optional: true` and disappears from the banner.

---

## 3. Provisioning steps

Step ids are shared by the browser engine, the service contract and the
PowerShell orchestrator so progress can be correlated across all three.

| Order | Id | Phase | Notes |
| --- | --- | --- | --- |
| 1 | `preflight` | Preflight | Pure validation, always runs, never delegated. |
| 2 | `consent` | Preflight | Interactive sign-in. In broker mode this creates and authorizes the session (§4.1). |
| 3 | `secret` | Preflight | Reuses the existing Web App API key when present; otherwise the browser generates one **before** any delegation so it can be handed to the service. |
| 4 | `fabric-discovery` | Fabric | Workspace + serving lakehouse + Dataverse shortcut source. Setup prefers a separate Dataverse Link-to-Fabric Lakehouse, but if none matches it reuses genuine Dataverse shortcuts already present at the Serving Lakehouse root. |
| 5 | `fabric-notebook` | Fabric | Serving bootstrap notebook. The notebook definition ships inside the solution (`segment-preview-payload.js`); the browser substitutes the resolved ids, calls the Fabric item-definition API directly, creates or updates the schedule, and immediately starts and monitors one execution. |
| 6 | `azure-infra` | Azure | ARM deployment of the compiled template. Also passes the pinned API package URL and SHA-256 so the deployment copies the package into customer-owned storage (§6.3). The step fails before it touches Azure when no verified package is configured. |
| 7 | `fabric-permissions` | Fabric | Grants the Web App managed identity access. |
| 8 | `azure-app` | Azure | Verifies the package settings the deployment applied (blob name, no shared access signature, digest, managed-identity read), restarts the Web App, polls `/api/health`, and then polls the authenticated `/api/setup/key-check` endpoint until the active worker accepts the deployed key. |
| 9 | `dataverse-config` | Dataverse | Writes `klth_FabricBehavioralApiUrl` + `klth_FabricBehavioralApiKey`. Never delegated — the browser owns the Dataverse session. |
| 10 | `verify` | Verify | Calls `klth_ManageSegmentPreviewSetup` with `klth_action = status`, and when the result still offers the idempotent `provision-shortcuts` action it invokes that too and re-reads the status. Journeys event tables are mandatory because behavioral and `Interaction(...)` queries depend on them. Verification fails with the required export/bootstrap actions instead of reporting installation success while they are absent. |

In `manual` mode the plan contains only `preflight` and `verify`, so pressing the
button on an unconfigured tenant is harmless and cannot rotate the API key.

---

## 4. Provisioning service REST contract

Base URL comes from `klth_SetupBrokerUrl`. Every request carries:

```
x-segment-preview-contract: 1.1
Content-Type: application/json; charset=utf-8
```

Requests after sign-in additionally carry
`Authorization: Bearer <session token>`. The service **must** reject a request
whose `contractVersion` major version it does not implement, with `400` and the
error envelope in §4.6.

### 4.1 Session and sign-in

**`POST {base}/v1/sessions`** — anonymous. Creates a short-lived session.

```jsonc
{
  "contractVersion": "1.1",
  "nonce": "<256-bit random, base64url>",
  "origin": "https://contoso.crm4.dynamics.com",
  "environmentUrl": "https://contoso.crm4.dynamics.com",
  "environmentDomain": "contoso.crm4.dynamics.com"
}
```

Response `201 Created`:

```json
{
  "sessionId": "sess-8f2c...",
  "authorizeUrl": "https://provisioning.example.com/auth/start?session=sess-8f2c...",
  "expiresAt": "2025-01-01T00:15:00.000Z"
}
```

Requirements on the service:

* `authorizeUrl` **must** be on the same origin as `{base}`. The client refuses
  anything else and never opens a window for it.
* `origin` must be validated against an allow-list before it is used as a
  `postMessage` target. A caller-supplied origin is otherwise a redirect oracle.
* Sessions are short-lived (15 minutes is the reference value) and single-tenant
  to the signing-in administrator.

The browser opens `authorizeUrl` in a pop-up. The service performs the
authorization-code flow for its own multi-tenant confidential application at its
own fixed callback URL, then the callback page posts back to the opener:

```jsonc
{
  "type": "segment-preview-broker-session",
  "sessionId": "sess-8f2c...",
  "nonce": "<echo of the request nonce>",
  "status": "authorized",               // authorized | failed
  "sessionToken": "<opaque, short-lived>",
  "expiresAt": "2025-01-01T00:45:00.000Z",
  "account": "admin@contoso.com",
  "tenantId": "<guid>",
  "error": null
}
```

`postMessage` must be sent with the validated origin as `targetOrigin`, never
`"*"`. The client verifies `event.origin`, `type`, `sessionId` and `nonce`; a
wrong nonce aborts the sign-in rather than retrying.

**`DELETE {base}/v1/sessions/{sessionId}`** ends the session. The Setup Center
calls it best-effort and ignores failures.

### 4.2 `POST {base}/v1/sessions/{sessionId}/runs`

Starts the provisioning run. Body:

```jsonc
{
  "contractVersion": "1.1",
  "dataverse": {
    "environmentUrl": "https://contoso.crm4.dynamics.com",
    "requiredTables": ["contact", "msdynmkt_contactpointconsent4", "msdynmkt_purpose", "msdynmkt_topic"]
  },
  "azure": {
    "subscriptionId": "<guid>",
    "resourceGroup": "rg-segment-preview",
    "location": "westeurope",
    "webAppName": "segment-preview-contoso"
  },
  "fabric": {
    "workspaceId": null,
    "workspaceName": "Segment Preview",
    "capacityId": null,
    "servingLakehouseId": null,
    "servingLakehouseName": "SegmentServing",
    "dataverseConnectionId": null,
    "dataverseDeltaFolder": "deltalake"
  },
  "secrets": { "behavioralApiKey": "<generated in the browser>" },
  "apiPackage": {
    "url": "https://github.com/<owner>/<repo>/releases/download/v1.1.0/segment-preview-api.zip",
    "sha256": "<64 hex characters>",
    "blobName": "api-1.1.0-<first 16 hex>.zip",
    "version": "1.1.0"
  },
  "options": { "skipNotebook": false }
}
```

Response `202 Accepted`:

```json
{ "runId": "run-8f2c...", "status": "running" }
```

`secrets.behavioralApiKey` is a bearer credential for the deployed API. The
service must accept it over TLS only, must never log it, and must keep it only
for the lifetime of the run.

`apiPackage` is the package the page pinned, resolved exactly as in direct mode
(§6.3). The browser refuses to start a run without it, and the service must
refuse the run rather than deploy a Web App with no code: it passes the four
values straight into the template parameters and then verifies the app settings
the deployment actually applied.

### 4.3 `GET {base}/v1/sessions/{sessionId}/runs/{runId}`

```jsonc
{
  "runId": "run-8f2c...",
  "status": "running",            // running | succeeded | failed | actionRequired
  "steps": [
    { "id": "fabric-discovery", "status": "succeeded", "message": "Workspace 'Segment Preview' reused." },
    { "id": "azure-infra",      "status": "running",   "message": "Deploying template..." }
  ],
  "outputs": {
    "apiBaseUrl": "https://segment-preview-contoso.azurewebsites.net",
    "workspaceId": "<guid>",
    "servingLakehouseId": "<guid>"
  },
  "manual": [
    "Enable 'Service principals can use Fabric APIs' and add the managed identity."
  ],
  "error": null
}
```

Step `status` values: `pending`, `running`, `succeeded`, `skipped`, `failed`.

### 4.4 Client behaviour (`createBrokerSession`)

* Polls every 4 s, at most 300 times, then fails with a timeout error.
* Emits `onProgress` the first time each `id:status` pair is seen, and `onRun`
  once the run id is known so the page can persist it for resume.
* `succeeded` and `actionRequired` end the poll loop; `failed` throws using
  `error.message`.
* Any step reported as `failed` makes the corresponding browser step fail with
  the service's message; `skipped` is surfaced verbatim to the operator.
* Everything in `manual[]` is appended to the Setup Center's manual checklist.
* The pop-up is closed and the `message` listener removed on every exit path,
  including blocked pop-ups, a pop-up the administrator closes, and time-out.

### 4.5 Resume

The session record (`sessionId`, `sessionToken`, `expiresAt`, `runId`, service
URL, environment domain) is stored in `sessionStorage`. On reload the Setup
Center shows "You are signed in to the provisioning service" and:

* reuses a still-valid session, so no second sign-in pop-up appears;
* re-attaches to a known `runId` instead of starting a second run;
* discards the record when it is expired, malformed, or was issued by a
  different service URL or environment.

`POST /runs` must also be idempotent for the same
`(tenant, subscriptionId, resourceGroup, webAppName)` tuple: re-running after a
partial failure must reuse existing resources rather than duplicate them.

### 4.6 Error envelope

```json
{
  "error": {
    "code": "FabricCapacityRequired",
    "message": "No Fabric capacity is assigned and none was supplied.",
    "target": "fabric-discovery",
    "manual": ["Assign a Fabric capacity to the workspace, then run setup again."]
  }
}
```

`message` is shown to the administrator, so it must be free of secrets and of
internal identifiers.

---

## 5. Resume state (`klth_SetupConfiguration`)

```jsonc
{
  "contractVersion": "1.1",
  "target": { "subscriptionId": "...", "resourceGroup": "...", "...": "..." },
  "state": {
    "completedSteps": ["preflight", "consent", "secret"],
    "apiBaseUrl": "https://...",
    "apiKeyFingerprint": "sha256:1a2b3c4d5e6f7a8b",
    "updatedUtc": "2025-01-01T00:00:00.000Z"
  },
  "facts": {
    "workspaceId": "...",
    "workspaceName": "...",
    "servingLakehouseId": "...",
    "servingLakehouseName": "...",
    "fabricSqlServer": "...",
    "fabricSqlDatabase": "...",
    "notebookId": "...",
    "apiBaseUrl": "https://.../api/",
    "principalId": "...",
    "packageVersion": "1.1.0.0",
    "packageSha256": "<64 hex>"
  }
}
```

`serializeConfiguration` strips `behavioralApiKey` and `apiKey` from `target`,
`state` and `facts` before writing, along with anything whose name matches
`key`, `secret`, `token`, `password` or `sas`. Only the fingerprint (`sha256:`
plus the first 16 hex characters) is persisted, so the resume record can be read
by anyone with Dataverse access without leaking the credential. **No session
token is ever written to Dataverse.**

The value is serialized as compact JSON and must stay within the Dataverse
environment-variable limit of 2,000 characters. Default target values are omitted,
and facts already present in the target (for example workspace and Lakehouse IDs)
are not duplicated. The orchestrator reconstructs those facts from the target when
resuming. Temporary source and customer-storage package URLs are not persisted
because they are only needed during the Azure deployment step. If a customized
configuration still exceeds the limit, Setup reports its measured size before
sending the value to Dataverse.

### 5.1 Facts and convergence

A resumed run skips completed steps, so the values those steps discovered have to
survive the page reload. `facts` carries exactly the non-secret values a later
step reads. On load the orchestrator hydrates them back into the run context; a
step that still cannot find what it needs fails with a message naming the step
that should have recorded it and pointing at **Start over**. No step reports
success for work it did not do.

The API key is deliberately *not* a fact. On every direct-mode run the `secret` step:

1. reads `BEHAVIORAL_API_KEY` back from the App Service application settings, or
2. generates a new key and forces `azure-infra`, `azure-app`, `dataverse-config`
   and `verify` to run again, so the new key reaches every consumer atomically.

This applies even when Setup is opened in a fresh browser session. Re-running an
existing installation therefore does not rotate a healthy key and cannot leave a
warm App Service worker temporarily using the previous value.

`preflight`, `secret` and `verify` therefore always run, even on a resume.

### Installation diagnostics log

The Setup Center keeps a timestamped diagnostics log for the lifetime of the
browser session. The log records page loads, status checks, update checks,
Dataverse request paths and response codes, the installation plan, every step
transition, retry messages, manual follow-up steps and errors. It is retained in
`sessionStorage` across Setup reloads and is capped at 1,000 entries.

A **View installation log** action is rendered at the bottom of the Setup page.
The administrator can inspect the log inline, copy it to the clipboard, or
download it as a plain-text `.log` file for support analysis.

The diagnostics contract is metadata-only. Request bodies, solution package
content, authorization headers, access and refresh tokens, API keys, client
secrets, credentials and signed URL query values must never be written. Known
sensitive property names and URL parameters are replaced with `[REDACTED]`
before an entry is stored or rendered.

A run that fails part way still records the steps that succeeded — except
`secret`, which is only recorded once `azure-infra` succeeded, because that is
the step that writes the key into App Service where recovery reads it. If
`secret` is dropped, the steps that depend on it are dropped with it.

**Start over** clears `state` and `facts` (the target configuration is kept) so
the next run executes every step again.

---

## 6. Direct mode requirements (primary, self-service)

This is the normal installation path. The administrator registers one
application **in their own tenant**, guided step by step by the "Connect this
environment" panel of the Setup Center. The engine exposes the same data
programmatically through `describeAppRegistration(pageUrl)`, and the Setup Center
renders it, so the page and this document cannot drift apart.

| Setting | Value |
| --- | --- |
| Platform | Single-page application |
| Redirect URI | The Setup Center URL itself — origin + path of `segment-preview-setup.html`, e.g. `https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html`. The page shows and copies the exact value. |
| Supported account types | Accounts in this organizational directory only |
| Client secret | **None.** A SPA is a public client and uses PKCE. |
| Delegated permission | Azure Service Management → `user_impersonation` |
| Delegated permissions | Power BI Service → `Workspace.ReadWrite.All`, `Item.ReadWrite.All`, `Item.Execute.All`, `Capacity.Read.All`, `OneLake.Read.All`, `Connection.ReadWrite.All` (admin consent required) |

This list is deliberately the whole set, and installing the Dataverse shortcuts
does not extend it: the browser only asks the Dataverse Custom API for the
`provision-shortcuts` action, and the shortcuts themselves are created by the Web
App's own system-assigned managed identity inside the customer's subscription.
No delegated OneLake write permission is used for them. `OneLake.Read.All` is
required only to discover the existing Link to Microsoft Fabric shortcut source.
Discovery reads all Dataverse shortcuts in that source Lakehouse. A separate
Microsoft-created Link-to-Fabric Lakehouse is preferred. If it is absent,
discovery also checks the selected Lakehouse for matching root
`Tables/contact` shortcut metadata (`environmentDomain`, `connectionId`, and
`deltaLakeFolder`). A Microsoft-created Dataverse Link Lakehouse is retained as
the source, but it is not accepted as the Serving Lakehouse unless its REST
properties include `defaultSchema`. Existing Lakehouses without this property
cannot be converted to schema support, so Setup reuses or creates the separate
schema-enabled `SegmentPreviewServing` Lakehouse with
`creationPayload.enableSchemas: true`.
Fabric discovery and bootstrap are always re-run idempotently when the
administrator presses **Install everything**, even if an earlier solution
version recorded them as complete. When discovery changes the Serving
Lakehouse id, Setup also forces Azure settings, Fabric permissions, connection
permissions, API deployment, and Dataverse configuration to run again.
Fabric item creation is also race-safe: if creation reports that
`SegmentPreviewServing` is already in use, Setup refreshes Lakehouse discovery
for up to one minute and reuses the schema-enabled item once Fabric exposes it.
If that name belongs to a permanently non-schema-enabled Lakehouse, Setup
preserves it and idempotently reuses or creates the schema-enabled fallback
`SegmentPreviewServingSchema`.
After selecting or creating the Serving Lakehouse, Setup waits up to five
minutes for its SQL analytics endpoint and continues the same installation run
as soon as the endpoint becomes available.
An active same-name Azure Resource Manager deployment is resumed instead of
rejected. If it has remained active for more than 30 minutes, Setup cancels only
that stale deployment operation and reruns the incremental template against the
existing resources.
Immediately before starting the bootstrap notebook, Setup forces a fresh Fabric
access token and verifies that a JWT token contains `Item.Execute.All`. This
allows newly granted admin consent to take effect without waiting for the old
token to expire. Other 401/403 responses retain the original Fabric error code
and message instead of being mislabeled as a missing permission.
The Serving bootstrap accepts Customer Insights - Journeys Delta event folders
both under `Files/Customer Insights Journeys/<EventName>` and directly under
`Files/<EventName>`, then exposes them through `Tables/journeys`.
For direct-root Fabric shortcuts, the bootstrap copies the original shortcut
target instead of creating an unsupported shortcut-to-shortcut chain.
The validated shortcut `connectionId` replaces a stale retained connection id
and is written back to Advanced options.
The bootstrap creates the query-facing `Tables/dataverse/*` aliases as direct
Dataverse shortcuts using this validated target metadata.
Shortcut creation itself is REST-based and does not depend on Spark SQL
databases or registry tables. Individual shortcut failures are retained in the
notebook diagnostic, while the mandatory final API verification remains the
authoritative installation gate and reports the missing component to the user.
When the link
or its primary `contact` table is not visible yet, Setup polls the Fabric source
for up to two minutes so a newly created Microsoft synchronization can complete.
The API applies the same bounded polling policy when Fabric initially rejects a
shortcut because its source table is not ready. Only after that wait does Setup
ask the administrator to create the missing Fabric link or verify the table under
**Link data > Manage tables**. Additional consent and relationship dependencies
are still provisioned through the discovered Dataverse cloud connection.

Everything this path creates stays in the customer's own tenant and
subscription: the Entra registration, the Azure resource group, Web App and
Application Insights, the Fabric workspace and lakehouse, and every Dataverse
value. No credential and no data leaves the tenant, and there is no dependency on
any service operated by anyone else.

Known trade-offs, stated honestly:

* One registration **per Dataverse environment**, because the redirect URI is
  that environment's URL and Entra supports no wildcards for SPA platforms.
  The registration is guided from the page and takes a few minutes; it is the
  price of not depending on a hosted service.
* The registration must be repeated if the web resource path changes.
* Delegated Azure and Fabric tokens exist in the browser tab for the duration of
  the run.
* The flow depends on Entra CORS for SPA redirect URIs and on the Dataverse CSP
  permitting the pop-up; a hardened CSP can break it.

### 6.1 Token acquisition

The engine ships its own OAuth 2.0 client, `createAuthClient`, so no third-party
library and no CDN are involved — the Dataverse content security policy blocks
CDN script loading, which is why MSAL cannot be relied upon.

* Authorization code + PKCE (`S256`), `response_mode=fragment`, in a pop-up.
* The pop-up lands back on the Setup Center URL. The page detects
  `window.opener` plus a `code=`/`error=` fragment and immediately stops, so only
  the opener processes the response.
* The code is exchanged against
  `https://login.microsoftonline.com/organizations/oauth2/v2.0/token`. Entra
  enables CORS on that endpoint for redirect URIs registered as SPA.
* `offline_access` is requested; the rotating refresh token is used to obtain the
  Fabric token after the Azure token, so the administrator signs in **once**.
* Tokens are cached per resource in memory only, with a 60-second safety margin,
  and are dropped by `dispose()` when the run ends. Nothing is written to
  `localStorage` or `sessionStorage`.
* `state` is verified on the response; a mismatch aborts the run.

`createMsalTokenProvider` remains exported. If an environment already loads MSAL,
the Setup Center reuses that session instead of opening its own pop-up.

### 6.2 Notebook publication from the browser

The bootstrap notebook is not read from disk and is not built by any tool on the
administrator's machine. `deployment/Update-SetupPayloadWebResource.ps1` converts
`Fabric/bootstrap-events.py` into a Jupyter document at *release* time and writes
it into the solution web resource `segment-preview-payload.js`. That file is
imported with the managed solution, so the browser already has the notebook when
the Setup Center opens.

At run time the engine:

1. Deep-clones the notebook document and rewrites the three top-level constants
   `WORKSPACE_ID`, `SERVING_LAKEHOUSE_ID` and `DATAVERSE_LAKEHOUSE_ID` with the
   ids resolved by `fabric-discovery`. Values are validated against
   `^[A-Za-z0-9 ._/-]+$`, so a value can never terminate the Python literal.
2. Encodes the document as UTF-8 base64 and wraps it in a Fabric item definition
   with a single `InlineBase64` part.
3. `GET workspaces/{id}/notebooks` and matches on the display name.
   * Found → `POST workspaces/{id}/notebooks/{notebookId}/updateDefinition?updateMetadata=true`.
   * Not found → `POST workspaces/{id}/notebooks` with display name, description
     and definition.
4. Both calls may answer `202 Accepted` with an `x-ms-operation-id` (or a
   `Location` header). The engine then polls `GET operations/{id}` until the
   status leaves `Running`/`NotStarted` and reads `GET operations/{id}/result`,
   so the notebook id is the id Fabric really created. A `Failed` or `Undefined`
   operation raises the reported Fabric error instead of reporting success.
5. `GET workspaces/{id}/items/{notebookId}/jobs/Execute/schedules`. If the list
   is empty, the daily schedule from `Fabric/bootstrap-events.schedules.json` is
   created. An existing schedule is never overwritten, so a customer's own
   cadence survives an upgrade.

If the Dataverse mirror lakehouse id is not yet known, the notebook is still
published with an empty GUID and the checklist gains the genuine tenant
prerequisite ("Link to Microsoft Fabric"). The step never asks for a script.

### 6.3 API deployment from the browser

An ASP.NET Core publish output cannot be produced in a browser and is far too
large to embed in a web resource, so the API is deployed as a **verified package
copy** rather than as a build. The copy is performed *inside the customer's own
subscription* by the Azure deployment, not by the browser: the page hands the
pinned release URL and its SHA-256 to the ARM template, which downloads the ZIP,
verifies the digest and stores it as an immutable blob in a private, customer-owned
storage account. From that point the running Web App reads only customer-owned
storage in the customer's own subscription; there is no ongoing dependency on the
publisher and no external URL in the Web App configuration.

The browser cannot do the copy itself. A GitHub release asset answers a
cross-origin `GET` without an `Access-Control-Allow-Origin` header, so
`fetch(...).arrayBuffer()` from a Dataverse origin fails; Kudu
(`*.scm.azurewebsites.net`) sends no CORS headers either, so `zipdeploy`/`OneDeploy`
is equally unreachable. An Azure Container Instance runs briefly inside the
customer's resource group with ordinary outbound access, which
is why the copy is a deployment concern.

What `azure-infra` passes to the template:

| Parameter | Value |
| --- | --- |
| `apiPackageUrl` | Resolved package URL, or `''` when nothing is pinned. |
| `apiPackageSha256` | Pinned lower-case 64-hex digest, or `''`. |
| `apiPackageBlobName` | `api-<version>-<first 16 hex of the digest>.zip`. |
| `apiPackageVersion` | Package version, for the `SEGMENT_PREVIEW_PACKAGE_VERSION` setting. |

When both the URL and the digest are present the template additionally deploys:

1. A `StorageV2` account (`Standard_LRS`, HTTPS-only, TLS 1.2,
   `allowBlobPublicAccess: false`, `allowSharedKeyAccess: false`,
   `publicNetworkAccess: Disabled`) and a private `segment-preview-api` container
   in the customer's resource group.
2. A user-assigned managed identity holding **Storage Blob Data Contributor** on
   that one account. The identity is scoped to the single account.
3. A VNet with separate delegated subnets for the copy container and Web App,
   plus a Blob private endpoint and linked private DNS zone. The running system
   never requires public storage access.
4. A `Microsoft.ContainerInstance/containerGroups` resource running the Azure CLI
   image once with that identity inside the VNet. It skips the work when the digest-named blob
   already exists, otherwise downloads the URL, verifies it with `sha256sum` and
   **exits before uploading** if the digest does not match, then uploads through
   the Blob REST API with an Entra bearer token. No account key is created or used
   anywhere. This also works in tenants that prohibit shared-key authentication
   for Deployment Scripts' internal helper storage.
5. **Storage Blob Data Reader** for the Web App's own system-assigned identity on
   the same account.
6. Web App settings `WEBSITE_RUN_FROM_PACKAGE` (a clean blob URL with no query
   string), `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`,
   `SEGMENT_PREVIEW_PACKAGE_VERSION` and `SEGMENT_PREVIEW_PACKAGE_SHA256`.

The later `azure-app` step verifies rather than deploys. It reads the application
settings back through ARM and fails the run — never reporting a silent no-op — when
`WEBSITE_RUN_FROM_PACKAGE` does not name the expected blob, when it carries a query
string (an expiring shared access signature), when `SEGMENT_PREVIEW_PACKAGE_SHA256`
differs from the pinned digest, or when
`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID` is not `SystemAssigned`. It then
records the `packageBlobUrl` fact, restarts the Web App and polls `GET {apiBaseUrl}health`
until the API answers. It then polls `GET {apiBaseUrl}setup/key-check` with the deployed
key until the active worker accepts it. Both polls retry for about five minutes because
the blob mount, role assignment, settings update, and worker recycle become effective
asynchronously. A Web App that never answers or continues serving the previous key
fails the step before Dataverse is updated.

For that poll to be possible from the setup page the API adds a deliberately narrow
CORS policy: only `/api/health` and `/api/setup/key-check`, only `GET`, no credentials,
and only the origins derived from its own `DATAVERSE_ENVIRONMENT_URL` setting. The
health endpoint permits only `Accept`; the key check additionally permits `x-api-key`
and rejects a missing or incorrect value. An unset or unparsable environment URL yields
no allowed origin at all — the policy is never widened to `*`, and no other endpoint is
reachable from a browser.

The package URL and digest are resolved together, in this order:

| Order | Source | Purpose |
| --- | --- | --- |
| 1 | `klth_SetupApiPackageUrl` | An administrator who mirrors release assets. Holds `<https url> <64 hex sha-256>`. |
| 2 | `api.packageUrl` + `api.sha256` in `segment-preview-payload.js` | The release asset and digest stamped in by the maintainer at release time. |

`resolveApiPackage` never invents a URL and **never accepts a URL without a
matching SHA-256** — an unverifiable package is treated as "not configured".
When neither source is complete `azure-infra` **fails before it calls Azure at
all**. That is deliberate: the template writes the Web App application settings
as a complete set, so deploying it without a package would strip
`WEBSITE_RUN_FROM_PACKAGE` from an environment that was already serving the API.
The checklist explains exactly which environment variable to set, in the
`<url> <sha-256>` form — it never points at a script, an installer or a command
line.

---

## 7. What must be deployed for the optional broker mode

Broker mode is **optional and not part of the customer installation**. Nobody
needs it to install this product. It exists for organisations that would rather
run one hosted service than register one application per environment, and it is
the one part of this design that cannot be satisfied from this repository alone.
Whoever chooses to operate it needs:

1. **A multi-tenant Entra application**, confidential client, with delegated
   permissions for Azure Service Management (`user_impersonation`) and the
   Fabric/Power BI Service scopes listed in §6, and one fixed redirect URI: the
   service's own callback endpoint.
2. **A hosted service** implementing §4, holding the client secret or
   certificate, exchanging the authorization code, and calling ARM and Fabric on
   behalf of the signed-in administrator.
3. **An origin allow-list** so `postMessage` targets are validated, and rate
   limiting on the anonymous `POST /v1/sessions` endpoint.
4. **A published service URL** pasted into the optional panel of
   "Connect this environment", or pre-set in `klth_SetupBrokerUrl`.

### 7.1 Reference implementation in this repository

`Broker/` contains a working implementation of items 2 and 3: the endpoints of
§4, PKCE authorization-code redemption, the opaque session token, the
origin-validated callback page, and the ARM/Fabric executor. See
[`Broker/README.md`](../Broker/README.md). `Broker.Tests` runs the whole HTTP
flow over a real listener with a faked token client, and fails the build if the
step ids, contract version or message type drift from
`webresources/segment-preview-provisioning.js` or from this document.

Items 1 and 4 remain outstanding: **no application identity has been registered
and no instance is hosted**. They are operator tasks for whoever wants this
optional path, never customer install steps, and no credential for them exists
anywhere in this repository.

The Setup Center therefore states plainly that no hosted service is configured
and that none is required, and the unit tests drive a mocked service, not a real
one.

---

## 8. Interactive steps that remain, in every mode

Microsoft provides no API to remove any of these. **All of them happen in the
browser**, started from the Setup Center; none of them requires anything to be
installed on the administrator's computer.

1. Microsoft Entra sign-in, including conditional access and MFA.
2. Tenant consent — for the tenant's own registration plus admin consent in the
   primary direct mode, or once for the hosted service's multi-tenant
   application if the optional broker mode is used.
3. Azure RBAC on the target subscription for the signed-in administrator.
4. The Fabric tenant setting *Service principals can use Fabric APIs*, plus the
   security group membership for the Web App managed identity.
5. Fabric capacity purchase / assignment.
6. The Fabric cloud connection to Dataverse (interactive OAuth dialog).
7. Dataverse *Link to Microsoft Fabric* and the Customer Insights – Journeys
   export to Fabric.
8. System Administrator role in the Dataverse environment.

Items 4–7 can be *detected and reported* by the Setup Center but not performed.
When the required Journeys event tables are missing, the component action opens
a persistent in-page guide. It identifies the selected workspace and Serving
Lakehouse, walks the administrator through **Get data → New shortcut →
Dataverse**, requires a System Administrator connection, distinguishes the
**Customer Insights Journeys** folder from the regular CDS2 source, and links to
the official Microsoft instructions. It prominently requires **Files**, not
**Tables**, because the bootstrap discovers interaction Delta data below
`Files/Customer Insights Journeys` or from registered shortcuts directly below
the Serving Lakehouse `Files` root and creates the queryable SQL tables itself.
After the shortcut exists, another
**Install everything** run automatically executes and monitors the bootstrap
notebook and verifies the resulting `journeys` tables.

### 8.1 Resource reuse and Start over

Every create-capable step must enumerate or read the target first. Azure
discovery is strictly scoped to the subscription and Resource Group selected
in step 2. An existing Segment Preview Web App in that Resource Group is
identified by its application settings for the current Dataverse environment;
its Fabric ids and existing API key are reused before deployment. Matching
stored ids take precedence over names. This applies to Azure resource groups
and deployments, Fabric workspaces and Lakehouses, the
bootstrap notebook and schedule, role assignments, connections, and
shortcuts. ARM deployments remain declarative updates of the same named
resources.

If an id does not resolve and name/environment discovery returns more than one
candidate, Setup stops before any create call. It reports the candidate ids and
requires the administrator to choose the intended resource in **Advanced
options**. Setup never selects the first ambiguous result and never deletes
duplicates automatically.

**Start over** clears only provisioning completion state and the short-lived
browser broker session. It retains the selected target and durable discovered
resource facts in Dataverse. The next run therefore executes discovery again
against the real tenant and reuses those resources; it does not revert to new
resource names or delete API configuration.
