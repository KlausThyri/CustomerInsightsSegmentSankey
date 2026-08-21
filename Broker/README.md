# Segment Preview provisioning service (broker)

Reference implementation of the publisher-hosted provisioning service that the
Dataverse setup web resource talks to. It exists so a customer administrator can
install everything from **one button inside Dataverse**, without registering an
application in their own tenant.

> **Status: not deployed.** This repository contains the source and its tests. No
> instance is hosted and no Entra application identity exists yet. Until a
> maintainer completes the prerequisites below, the setup page correctly reports
> that no provisioning service is configured.

The wire contract is normative in
[`documentation/setup-center-contract.md`](../documentation/setup-center-contract.md);
`Broker.Tests/ContractTests` fails the build if this service, the browser engine
and that document drift apart.

## Why a confidential broker

The web resource runs on the customer's Dataverse origin
(`https://<org>.crm<n>.dynamics.com`), which is different for every customer. A
browser-only SPA flow would need each of those origins registered as a redirect
URI, which is exactly the per-customer app registration the one-click requirement
forbids. A confidential multi-tenant application has a **single fixed redirect
URI on the publisher's own origin**, so no customer origin is ever registered.

Sequence:

1. The web resource `POST /v1/sessions` with its origin and a nonce.
2. It opens the returned `authorizeUrl` (always on the broker origin) in a popup.
3. The broker redirects to Microsoft Entra with PKCE; the administrator signs in
   and grants consent in their own tenant.
4. `GET /auth/callback` redeems the code, mints an opaque session token, and the
   callback page `postMessage`s it to the exact allow-listed opener origin.
5. The web resource starts a run and polls it. Tokens for ARM and Fabric are
   acquired server-side from the refresh token and never reach the browser.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Contract version, whether an identity is configured, what is missing. |
| `POST` | `/v1/sessions` | Starts a session for an allow-listed origin. Returns `sessionId`, `authorizeUrl`, `expiresAt`. |
| `GET` | `/auth/start` | Single-use link that redirects to Entra. |
| `GET` | `/auth/callback` | Fixed redirect URI. Renders the `postMessage` page. |
| `POST` | `/v1/sessions/{id}/runs` | Starts a provisioning run (bearer session token). |
| `GET` | `/v1/sessions/{id}/runs/{runId}` | Polls step status, outputs, manual follow-ups. |
| `DELETE` | `/v1/sessions/{id}` | Ends the session and drops the refresh token. |

The service performs only the steps the browser cannot: `fabric-discovery`,
`fabric-notebook`, `azure-infra`, `fabric-permissions`, `azure-app`. The
browser-owned steps (`preflight`, `consent`, `secret`, `dataverse-config`,
`verify`) are always reported as `skipped`, so the same resource is never written
twice.

## Configuration

Every value comes from configuration. Nothing is committed.

| Key | Required | Meaning |
| --- | --- | --- |
| `Broker:ClientId` | yes | Application (client) id of the publisher multi-tenant app. |
| `Broker:ClientSecret` | yes | Client secret. Use a Key Vault reference. |
| `Broker:PublicBaseUrl` | yes | Absolute https base URL of this service. |
| `Broker:AllowedOrigins` | one of | Exact customer origins allowed to start a session. |
| `Broker:AllowedOriginSuffixes` | one of | Host suffixes, for example `.crm4.dynamics.com`. |
| `Broker:Authority` | no | Defaults to `https://login.microsoftonline.com/organizations`. |
| `Broker:DryRun` | no | Accept runs and report every step as `skipped`. Used for conformance testing. |

Origin handling denies by default: an empty allow-list accepts nothing, and the
callback page never uses `postMessage(..., "*")`.

## Maintainer prerequisites (publisher, not customer)

These are the only remaining blockers to cross-tenant provisioning. A customer
never performs any of them.

1. Register a **multi-tenant confidential** application in the publisher tenant
   (`Accounts in any organizational directory`).
2. Add delegated permissions: `https://management.azure.com/user_impersonation`
   and the Fabric scopes in `BrokerOptions.RequiredScopes`, plus `openid`,
   `profile`, `offline_access`.
3. Add the single **Web** redirect URI `{PublicBaseUrl}/auth/callback`. Do not
   add any customer origin.
4. Create a client secret or certificate and store it in Key Vault.
5. Deploy this service to an https endpoint and set the configuration keys above.
6. Publish the resulting URL. Administrators paste it once into
   `klth_SetupBrokerUrl`, or it can be shipped as the environment variable's
   default value in a future solution release.

Until step 6 the setup page shows the "no provisioning service is configured"
state and offers the advanced tenant-owned SPA fallback instead.

## Running locally

```powershell
dotnet run --project Broker\CustomerInsightsSegmentSankey.Broker.csproj `
  --urls https://localhost:7299 `
  --Broker:PublicBaseUrl https://localhost:7299 `
  --Broker:AllowedOrigins:0 https://contoso.crm4.dynamics.com `
  --Broker:DryRun true
```

Dry-run mode needs no Entra identity for `/health`, but session creation still
requires `ClientId`, `ClientSecret` and `PublicBaseUrl`, because the sign-in
redirect cannot be faked.

## Tests

```powershell
dotnet test Broker.Tests\CustomerInsightsSegmentSankey.Broker.Tests.csproj
```

The suite covers the origin policy, the session store, the callback page
(including script-injection and wildcard-origin guards), contract parity with the
browser engine and the contract document, the pipeline, and the full HTTP flow
over a real Kestrel listener with a faked token client. No Azure, Fabric or Entra
resource is touched.

## Source layout

The project uses the repository's `.cs.txt` compile convention so the net462
plugin project does not glob these files.

| File | Role |
| --- | --- |
| `Program.cs.txt` | Host, dependency injection, CORS, hardening headers. |
| `BrokerEndpoints.cs.txt` | The endpoints above. |
| `BrokerOptions.cs.txt` | Configuration and the "what is missing" report. |
| `OriginPolicy.cs.txt` | Deny-by-default origin allow-list. |
| `Contracts.cs.txt` | Wire contract constants and DTOs. |
| `SessionStore.cs.txt` | Sessions, runs and the token helpers. |
| `TokenClient.cs.txt` | Delegated authorization-code and refresh-token flow. |
| `CallbackPage.cs.txt` | The `postMessage` landing page. |
| `ProvisioningPipeline.cs.txt` | Step ordering, dry-run and not-configured executors. |
| `AzureFabricProvisioningExecutor.cs.txt` | ARM and Fabric REST work. |
