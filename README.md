# Customer Insights Segment Sankey

Side-pane preview for draft segments in Dynamics 365 Customer Insights - Journeys.

## Downloads and installation

- [Managed Dataverse Solution](deployment/dataverse/CustomerInsightsSegmentPreview_managed.zip)
- [Unmanaged Dataverse Solution](deployment/dataverse/CustomerInsightsSegmentPreview.zip)
- [Installation guide](deployment/README.md)
- [System Architecture (PDF)](documentation/CustomerInsightsSegmentSankey-SystemArchitecture.pdf)
- [System Architecture (Word)](documentation/CustomerInsightsSegmentSankey-SystemArchitecture.docx)
- [Editable architecture diagrams](documentation/diagrams/)

For production installations, the Managed Solution should be used. The
GitHub release `v1.0.0` additionally contains a complete download package with
source code, deployment templates, documentation, and both Dataverse solutions.

## Included web resources

| File | Dataverse name | Type |
|---|---|---|
| `webresources/cis_SegmentSankeyLauncher.js` | `klth_/SegmentSankey/launcher.js` | JavaScript |
| `webresources/segment-sankey.html` | `klth_/SegmentSankey/segment-sankey.html` | HTML |
| `webresources/segment-members.html` | `klth_/SegmentSankey/segment-members.html` | HTML |
| `webresources/segment-preview-setup.html` | `klth_/SegmentSankey/segment-preview-setup.html` | HTML |
| `webresources/segment-sankey-icon.svg` | `klth_/SegmentSankey/segment-sankey-icon.svg` | SVG |

The resource names use the `klth` publisher prefix of the target solution.

## Installable solution

The transportable Managed Solution is located at
`deployment/dataverse/CustomerInsightsSegmentPreview_managed.zip`. It contains
plugins, custom APIs, environment variable definitions, web resources, the
segment command, and the new **Segment Preview** menu item under
**Settings > Overview** of the Customer Insights - Journeys app.

After import, the setup center checks the state of Dataverse, Azure, and
Fabric. Missing Dataverse shortcuts can be installed directly and idempotently.
The Azure infrastructure is provisioned reproducibly via
`deployment/azure/main.bicep`. The full process is described in
`deployment/README.md`.

## Command bar setup

1. Add all three files as web resources to an unmanaged solution and publish it.
2. Add a command bar command **Segment preview** to the main form of the
   Real-Time Journeys segment definition.
3. Select `klth_/SegmentSankey/launcher.js` as the JavaScript library.
4. Call the function `CISegmentSankey.open` with the parameter `PrimaryControl`.
5. Only show the command once the segment has already been saved.

The launcher creates an entry in the right-hand side pane bar via the supported
API `Xrm.App.sidePanes.createPane()` and passes the segment ID and segment name
to the HTML web resource. Before opening and before every refresh, it saves a
changed form definition so that the segment designer and the side pane evaluate
the same MQL. While the pane is open, the launcher monitors the active
model-driven app page. When switching to a different segment definition, it
navigates the existing pane to the new segment ID as soon as the new form
context has loaded. When leaving a segment detail page, it closes the pane
automatically. A manually closed pane is not reopened. Because model-driven
apps do not always perform a full reload when navigating again to the same web
resource, the HTML web resource additionally monitors the active segment ID.
After a stable record change, it resolves the segment name directly from
Dataverse and updates the count automatically.

## Architecture

The preview evaluates the complete segment in the shared Fabric serving lakehouse:

- The Dataverse plugin reads and validates the draft MQL, resolves
  relationships, segment references, and static member groups, and sends a
  typed AST to the secured ASP.NET Core API.
- `/api/segment-counts` compiles profile, relationship, consent, and
  `Interaction(...)` filters, including `UNION`, `INTERSECT`, and `EXCEPT`,
  into parameterized Fabric SQL CTEs.
- Fabric executes all set operations and returns only `COUNT_BIG(*)` per
  stage. Profile IDs are never transmitted to the plugin or the browser.

Both sources are additionally provisioned into a shared serving lakehouse:

- `journeys.*` contains the exported Customer Insights - Journeys events.
- `dataverse.*` contains only the Dataverse tables required by active
  segments, as Direct/OneLake shortcuts.
- The MQL dependency resolver detects profile, relationship, and consent
  tables, including nested segment references.
- The secured Fabric API adds missing Dataverse shortcuts serially and
  append-only. Existing shortcuts are never replaced by a full mirror
  reconfiguration.
- The daily bootstrap notebook also picks up any tables manually added to the
  Dataverse mirror into the `dataverse` serving schema.

The UI shows the calculation timestamp and the end-to-end load time. The
actual data state depends on the Customer Insights export to Fabric. The
published Customer Insights member count may differ from the live-computed
draft preview until the next segment evaluation.

### Member view

Clicking a stage card, the result, or an in-/out-flow bubble opens a large
Dynamics dialog with the associated contacts. Stage cards show the
cumulatively remaining members, red bubbles the members removed at that
transition, and green bubbles the members newly added.

The list is searched, filtered, and sorted exclusively server-side and loaded
with at most 50 contacts per page. Fabric computes the requested stage set and
returns only contact IDs. The Dataverse plugin then loads the visible contact
fields in the context of the signed-in user, so record- and field-level
security are preserved. Evaluation and paging use short-lived, encrypted
continuation tokens; neither millions of IDs nor contact fields are ever
transmitted to the browser or into a URL.

## Count provider

The UI expects an unbound Dataverse custom API:

- Unique name: `klth_GetSegmentFilterCounts`
- Request parameter: `klth_segmentid` (`Guid`, required)
- Response property: `klth_resultjson` (`String`)

Response format:

```json
{
  "generatedAt": "2026-08-17T09:00:00Z",
  "isEstimate": false,
  "stages": [
    {
      "label": "All contacts",
      "detail": "PROFILE(contact)",
      "count": 24840
    },
    {
      "label": "Email present",
      "detail": "Email contains data",
      "count": 19560
    }
  ]
}
```

`stages` must be ordered cumulatively: base, filter 1, filter 1+2, and so on.
The web resource computes losses and retention from this.
The visualization follows the Customer Insights journey canvas: Fluent cards
represent the base and filters, proportionally wide connections show the
remaining flow, and side `Excluded` cards show the amount removed per stage.

Customer Insights does not offer a supported endpoint that evaluates
arbitrary draft MQL queries per sub-filter. The provider therefore explicitly
translates the supported MQL into Dataverse queries and Fabric SQL.
Unsupported events, fields, or operators produce a clear error and never a
spurious count of null. The editor's internal preview endpoints are not used.

## Fabric Segment Engine

### Components

| Component | Purpose |
|---|---|
| `FabricApi/` | ASP.NET Core API with managed identity and a metadata-driven SQL compiler |
| `Fabric/` | Daily bootstrap for all Journeys delta event folders |
| `CustomApi/FabricSegmentCountClient.cs` | MQL AST construction and server-side call to `/api/segment-counts` |
| `CustomApi/FabricDependencyProvisioningClient.cs` | Calls `/api/fabric-dependencies` and ensures missing Dataverse shortcuts |

The bootstrap creates a OneLake shortcut under `Tables/journeys/<EventName>`
for every delta folder under `Files/Customer Insights Journeys/<EventName>`.
This makes new event types visible in the SQL endpoint without any code
change. `journeys._event_registry` logs successful and failed registrations.

The bootstrap also reads the selected tables from the Dataverse mirror and
creates idempotent shortcuts under `Tables/dataverse`. The
`dataverse._shortcut_registry` registry documents this reconciliation. At
runtime, the plugin calls `/api/fabric-dependencies`; this makes newly
required relationship or consent tables automatically available in the same
SQL endpoint as the Journeys events.

The API resolves tables and columns exclusively via `INFORMATION_SCHEMA`,
quotes all identifiers, and parameterizes values. Known Journeys aliases are:

- `msdynmkt_emaillinkclicked` → `RedirectLinkClicked`
- `msdynmkt_customlinkclicked` → `CustomLinkClicked`
- `msdynmkt_botemaillinkclicked` → `BotEmailLinkClicked`

The set operations `INTERSECT`, `UNION`, and `EXCEPT` are supported, as are
the conditions AND, OR, NOT, `==`, `!=`, `>`, `>=`, `<`, `<=`, `IN`,
`CONTAINS`, `Count()`, and `UTCMINUTES`, `UTCHOURS`, `UTCDAYS`, `UTCWEEKS`,
`UTCMONTHS`, and `UTCYEARS`.

For Dataverse text fields, `CONTAINS` follows Customer Insights semantics:
case is ignored, but diacritical characters remain distinct (`a` does not
match `á`).

### Dataverse configuration

The **Base Solution** (`KLTHBaseSolution`) contains the following environment variables:

- `klth_FabricBehavioralApiUrl`: HTTPS base endpoint of the Fabric API under `/api/`
- `klth_FabricBehavioralApiKey`: server-side API key

The names of these two environment variables originate from an earlier
architecture and are kept unchanged for compatibility reasons; today they
apply to all Fabric API calls (`/api/segment-counts` and
`/api/fabric-dependencies`), not only to behavioral-specific queries.

The key must not be stored in JavaScript web resources or source code.
The web app authenticates to the Fabric SQL endpoint via managed identity.
For production operation, the App Service plan should use at least B1 with
**Always On** enabled. The current F1 plan does not support this option.
Otherwise the Linux process is terminated after being idle, and the first
call after that must additionally initialize the application, the managed
identity token, the Fabric SQL connection, and the catalog. Subsequent calls
use the warm process, connection pool, and catalog cache.
The initial load of the Fabric event catalog uses a 90-second timeout and
retries only a transient SQL execution timeout (`-2`) once after two seconds.
Business errors such as missing events or fields are not retried.

### Operating limits

- The full segment evaluation transmits only aggregated stage counts,
  regardless of profile count. This means there is no longer a 250,000-ID
  limit.
- Static segment references are currently passed to Fabric as a JSON
  parameter of their member IDs. For very large static segments, a persisted
  Fabric membership table is required; dynamic 30-million-profile segments
  are not affected by this.
- A count of `0` is returned only after a successful Fabric query.
- Missing event shortcuts or unmappable fields are reported explicitly.
- The daily bootstrap must run successfully for newly exported event types to
  become automatically available.

## Local preview

If `segment-sankey.html` is opened outside of Dynamics, it uses only local
sample data. Sample data is never used in Dataverse; there, the custom API is
always called.
