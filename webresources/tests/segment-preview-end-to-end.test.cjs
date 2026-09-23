"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const repoRoot = path.resolve(__dirname, "..", "..");
const engine = require(path.join(repoRoot, "webresources", "segment-preview-provisioning.js"));
const embeddedTemplate = require(path.join(
  repoRoot,
  "webresources",
  "segment-preview-azure-template.js"
));
const payload = require(path.join(repoRoot, "webresources", "segment-preview-payload.js"));
const setupHtml = fs.readFileSync(
  path.join(repoRoot, "webresources", "segment-preview-setup.html"),
  "utf8"
);

const immediateTimer = (callback) => callback();
const SHIPPED_SHA = "1".repeat(64);
const STAMPED_PACKAGE =
  "https://contoso.example.com/segment-preview-api-1.1.0.0.zip " + SHIPPED_SHA;
const VALID_TARGET = {
  subscriptionId: "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
  resourceGroup: "rg-segment-preview",
  location: "westeurope",
  webAppName: "segment-preview-api",
  fabricWorkspaceId: "11111111-2222-3333-4444-555555555555",
  fabricServingLakehouseId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  fabricCapacityResourceId:
    "/subscriptions/6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6/resourceGroups/fabric-rg/providers/Microsoft.Fabric/capacities/fabriccapacity",
  fabricDataverseConnectionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  requiredDataverseTables: engine.TARGET_DEFAULTS.requiredDataverseTables,
  fabricDataverseLakehouseId: "12341234-5678-5678-9abc-9abcdef01234"
};

function extractFunction(source, name) {
  const match = new RegExp(
    `async function ${name}\\([^)]*\\) \\{[\\s\\S]*?^      \\}`,
    "m"
  ).exec(source);
  assert.ok(match, `Could not find function ${name}.`);
  return match[0];
}

function dataverseHarness(options = {}) {
  const written = {};
  const actions = [];
  const responses = options.responses || [{ overallState: "ready", components: [] }];
  return {
    written,
    actions,
    async getEnvironmentVariables(names) {
      const records = {};
      for (const name of names || []) {
        if (Object.prototype.hasOwnProperty.call(written, name)) {
          records[name] = { value: written[name], defaultValue: null };
        }
      }
      return records;
    },
    async setEnvironmentVariable(name, value) {
      written[name] = value;
      return true;
    },
    async executeSetupAction(action) {
      actions.push(action);
      if (options.failOn === action) {
        throw new Error("The Segment Preview Azure API is not reachable.");
      }
      const index = Math.min(actions.length - 1, responses.length - 1);
      return responses[index];
    }
  };
}

function directHarness(options = {}) {
  const calls = [];
  const appSettings = Object.assign({}, options.appSettings || {});
  return {
    calls,
    appSettings,
    async fabricCollection(pathname) {
      calls.push({ kind: "fabricCollection", pathname });
      if (pathname === "workspaces") {
        return [{ id: VALID_TARGET.fabricWorkspaceId, displayName: "Segment Preview" }];
      }
      if (/\/lakehouses$/.test(pathname)) {
        return [
          { id: VALID_TARGET.fabricServingLakehouseId, displayName: "SegmentPreviewServing" },
          { id: VALID_TARGET.fabricDataverseLakehouseId, displayName: "Dataverse_orga" }
        ];
      }
      if (/\/notebooks$/.test(pathname) || /\/schedules$/.test(pathname)) {
        return [];
      }
      return [];
    },
    async fabric(method, pathname, body) {
      calls.push({ kind: "fabric", method, pathname, body });
      if (method === "GET" && /\/lakehouses\/[^/]+$/.test(pathname)) {
        return {
          status: 200,
          body: {
            properties: {
              sqlEndpointProperties: {
                id: "sqldb",
                connectionString: "contoso.datawarehouse.fabric.microsoft.com"
              },
              defaultSchema: "dbo"
            }
          }
        };
      }
      if (method === "POST" && /\/notebooks$/.test(pathname)) {
        return { status: 201, body: { id: "cccccccc-dddd-eeee-ffff-000000000000" } };
      }
      return { status: 200, body: {} };
    },
    async fabricResult(response) {
      calls.push({ kind: "fabricResult", status: response && response.status });
      return response && response.body;
    },
    async runNotebookJob(workspaceId, notebookId) {
      calls.push({ kind: "runNotebookJob", workspaceId, notebookId });
      return { status: "Completed" };
    },
    async ensureResourceGroup(subscriptionId, resourceGroup) {
      calls.push({ kind: "ensureResourceGroup", subscriptionId, resourceGroup });
      return { location: "westeurope" };
    },
    async discoverExistingSegmentPreviewDeployment(
      subscriptionId,
      resourceGroup,
      environmentUrl,
      preferredWebAppName
    ) {
      calls.push({
        kind: "discoverExistingSegmentPreviewDeployment",
        subscriptionId,
        resourceGroup,
        environmentUrl,
        preferredWebAppName
      });
      return null;
    },
    async listDataverseConnections(environmentUrl) {
      calls.push({ kind: "listDataverseConnections", environmentUrl });
      return [
        {
          id: VALID_TARGET.fabricDataverseConnectionId,
          name: "Dataverse",
          connectivityType: "ShareableCloud",
          shareable: true,
          credentialType: "OAuth2"
        }
      ];
    },
    async findDataverseShortcutSource(workspaceId, lakehouses, environmentUrl, requestedLakehouseId) {
      calls.push({
        kind: "findDataverseShortcutSource",
        workspaceId,
        lakehouses,
        environmentUrl,
        requestedLakehouseId
      });
      return {
        lakehouseId: VALID_TARGET.fabricDataverseLakehouseId,
        lakehouseName: "Dataverse_orga",
        connectionId: VALID_TARGET.fabricDataverseConnectionId,
        deltaLakeFolder:
          "https://managedlake.dfs.fabric.microsoft.com/dataverse/Dataverse_orga/CDS3",
        tables: engine.requiredTables(VALID_TARGET.requiredDataverseTables)
      };
    },
    async ensureDataverseShortcuts(
      workspaceId,
      servingLakehouseId,
      sourceLakehouseId,
      tables,
      onProgress
    ) {
      calls.push({
        kind: "ensureDataverseShortcuts",
        workspaceId,
        servingLakehouseId,
        sourceLakehouseId,
        tables
      });
      (tables || []).forEach((table, index) => {
        onProgress?.({ completed: index + 1, total: tables.length, table, changed: false });
      });
      return {
        created: 0,
        repaired: 0,
        unchanged: (tables || []).length,
        failed: 0,
        total: (tables || []).length
      };
    },
    async ensureConnectionRoleAssignment(connectionId, principalId) {
      calls.push({ kind: "ensureConnectionRoleAssignment", connectionId, principalId });
      return { created: true };
    },
    async ensureWorkspaceRoleAssignment(workspaceId, principalId) {
      calls.push({ kind: "ensureWorkspaceRoleAssignment", workspaceId, principalId });
      return { created: true };
    },
    async ensureCapacityRoleAssignment(capacityResourceId, principalId) {
      calls.push({ kind: "ensureCapacityRoleAssignment", capacityResourceId, principalId });
      return { created: true };
    },
    async deployTemplate(subscriptionId, resourceGroup, name, template, parameters) {
      calls.push({ kind: "deployTemplate", subscriptionId, resourceGroup, name, parameters });
      appSettings.BEHAVIORAL_API_KEY = parameters.behavioralApiKey;
      if (Object.prototype.hasOwnProperty.call(parameters, "behavioralApiKeyPrevious")) {
        appSettings.BEHAVIORAL_API_KEY_PREVIOUS = parameters.behavioralApiKeyPrevious;
      }
      const blobName =
        parameters.apiPackageBlobName || "api-" + parameters.apiPackageSha256.slice(0, 16) + ".zip";
      appSettings.WEBSITE_RUN_FROM_PACKAGE =
        "https://spsegmentpreviewapi01.blob.core.windows.net/segment-preview-api/" + blobName;
      appSettings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID = "SystemAssigned";
      appSettings.SEGMENT_PREVIEW_PACKAGE_SHA256 = parameters.apiPackageSha256;
      appSettings.SEGMENT_PREVIEW_PACKAGE_VERSION = parameters.apiPackageVersion || "";
      return {
        webAppUrl: { value: "https://segment-preview-api.azurewebsites.net/api/" },
        managedIdentityPrincipalId: { value: "99999999-8888-7777-6666-555555555555" },
        packageBlobUrl: { value: appSettings.WEBSITE_RUN_FROM_PACKAGE }
      };
    },
    async webAppSettings(subscriptionId, resourceGroup, webAppName) {
      calls.push({ kind: "webAppSettings", subscriptionId, resourceGroup, webAppName });
      return Object.assign({}, appSettings);
    },
    async restartWebApp(subscriptionId, resourceGroup, webAppName) {
      calls.push({ kind: "restartWebApp", subscriptionId, resourceGroup, webAppName });
      return true;
    },
    async waitForPackageCopy(subscriptionId, resourceGroup, containerGroupName) {
      calls.push({ kind: "waitForPackageCopy", subscriptionId, resourceGroup, containerGroupName });
      return {
        state: "Terminated",
        exitCode: 0,
        detailStatus: "Completed",
        startTime: "2026-09-02T12:17:16Z"
      };
    },
    async apiHealth(baseUrl, config) {
      calls.push({ kind: "apiHealth", baseUrl, config });
      return { ok: true, attempts: 1, status: 200, body: { status: "ok" } };
    },
    async apiKeyCheck(baseUrl, apiKey, config) {
      calls.push({ kind: "apiKeyCheck", baseUrl, apiKey, config });
      return { ok: true, attempts: 1, status: 200, body: { status: "ok", apiKeyAccepted: true } };
    }
  };
}

function createDirectOrchestrator(overrides = {}) {
  const direct = overrides.direct || directHarness();
  const dataverse = overrides.dataverse || dataverseHarness();
  const orchestrator = engine.createOrchestrator(
    Object.assign(
      {
        dataverse,
        direct,
        mode: "direct",
        dryRun: false,
        target: engine.mergeConfiguration(VALID_TARGET),
        environmentUrl: "https://contoso.crm4.dynamics.com",
        crypto: webcrypto,
        template: embeddedTemplate,
        payload,
        apiPackageUrl: STAMPED_PACKAGE,
        timer: immediateTimer,
        origin: "https://contoso.crm4.dynamics.com",
        now: () => Date.parse("2024-05-01T00:00:00Z"),
        getToken: async () => "token"
      },
      overrides.settings || {}
    )
  );
  return { orchestrator, direct, dataverse };
}

test("dry-run setup journey reports the full installation plan and keeps manual prerequisites visible", async () => {
  const planSnapshots = [];
  const progress = [];
  const { orchestrator } = createDirectOrchestrator({
    settings: {
      dryRun: true,
      hooks: {
        onPlan: (plan) => planSnapshots.push(plan),
        onProgress: (step) => progress.push(`${step.id}:${step.status}`)
      }
    }
  });

  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(planSnapshots.length, 1);
  assert.deepEqual(
    planSnapshots[0].map((step) => step.id),
    engine.STEPS.map((step) => step.id)
  );
  assert.ok(planSnapshots[0].every((step) => step.skipped === false));
  assert.ok(progress.includes("preflight:running"));
  assert.ok(progress.includes("verify:succeeded"));
  assert.ok(result.results.every((entry) => entry.status === "succeeded"));

  const completedPlan = engine.buildPlan({
    mode: "direct",
    completed: Object.fromEntries(result.results.map((entry) => [entry.id, true]))
  });
  assert.ok(completedPlan.every((step) => step.status === "completed"));

  const consent = engine.describeConsent();
  assert.ok(consent.some((item) => item.id === "app-registration" && item.automatable === false));
  assert.ok(consent.some((item) => item.id === "dataverse-fabric-link" && item.automatable === false));
  assert.ok(consent.some((item) => item.id === "fabric-service-principal-apis"));
});

test("API key rotation journey carries the overlap key through rotate and clears it on finish", async () => {
  const direct = directHarness();

  const initialRun = createDirectOrchestrator({ direct });
  const first = await initialRun.orchestrator.run();
  assert.equal(first.ok, true, JSON.stringify(first.results, null, 2));
  const firstDeployment = direct.calls.find((call) => call.kind === "deployTemplate");
  const firstKey = firstDeployment.parameters.behavioralApiKey;
  assert.equal(firstDeployment.parameters.behavioralApiKeyPrevious, "");
  assert.match(first.results.find((entry) => entry.id === "secret").message, /API key generated/i);

  direct.calls.length = 0;
  const rotateRun = createDirectOrchestrator({
    direct,
    settings: { rotateApiKey: true }
  });
  const second = await rotateRun.orchestrator.run();
  assert.equal(second.ok, true, JSON.stringify(second.results, null, 2));
  const secondDeployment = direct.calls.find((call) => call.kind === "deployTemplate");
  const secondKey = secondDeployment.parameters.behavioralApiKey;
  assert.equal(secondDeployment.parameters.behavioralApiKeyPrevious, firstKey);
  assert.notEqual(secondKey, firstKey);
  assert.match(
    second.results.find((entry) => entry.id === "secret").message,
    /previous key keeps working until Finish rotation is pressed/i
  );
  assert.equal(second.results.find((entry) => entry.id === "azure-infra").status, "succeeded");

  direct.calls.length = 0;
  const finishRun = createDirectOrchestrator({
    direct,
    settings: { finishApiKeyRotation: true }
  });
  const third = await finishRun.orchestrator.run();
  assert.equal(third.ok, true, JSON.stringify(third.results, null, 2));
  const thirdDeployment = direct.calls.find((call) => call.kind === "deployTemplate");
  assert.equal(thirdDeployment.parameters.behavioralApiKey, secondKey);
  assert.equal(thirdDeployment.parameters.behavioralApiKeyPrevious, "");
  assert.match(
    third.results.find((entry) => entry.id === "secret").message,
    /previous API key overlap window was closed/i
  );
  assert.equal(third.results.find((entry) => entry.id === "azure-infra").status, "succeeded");
});

test("update installs are blocked during active solution imports and proceed once Dataverse is clear", async () => {
  const source = [
    extractFunction(setupHtml, "activeSolutionOperations"),
    extractFunction(setupHtml, "requireNoActiveSolutionOperations"),
    extractFunction(setupHtml, "importSolutionAndConfirm")
  ].join("\n");

  const calls = [];
  let importBlocked = true;
  const sandbox = {
    state: {},
    engine,
    bytesToBase64: () => "BASE64",
    importJobId: () => "11111111-2222-3333-4444-555555555555",
    installedSolution: async () => ({ version: "1.1.0.27" }),
    dataverseRequest: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("importjobs?")) {
        return importBlocked
          ? { value: [{ importjobid: "job-1", startedon: "2026-09-23T12:00:00Z" }] }
          : { value: [] };
      }
      if (url.startsWith("asyncoperations?")) {
        return importBlocked
          ? { value: [{ name: "Delete managed solution", startedon: "2026-09-23T12:01:00Z" }] }
          : { value: [] };
      }
      if (url === "ImportSolution") {
        return { ok: true };
      }
      throw new Error("Unexpected Dataverse request: " + url);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "segment-preview-setup-update-guard" });

  const update = { managed: true, latestVersion: "1.1.0.27" };
  const bytes = new Uint8Array([1, 2, 3, 4]);

  await assert.rejects(
    () => sandbox.importSolutionAndConfirm(update, bytes),
    /active solution import or uninstall operations/i
  );
  assert.equal(
    calls.filter((call) => call.url === "ImportSolution").length,
    0,
    "the solution import must not start while Dataverse is busy"
  );

  importBlocked = false;
  await assert.doesNotReject(() => sandbox.importSolutionAndConfirm(update, bytes));
  const importCall = calls.find((call) => call.url === "ImportSolution");
  assert.ok(importCall, "the solution import should proceed once the blocking operations clear");
  assert.deepEqual(JSON.parse(JSON.stringify(importCall.init.body)), {
    CustomizationFile: "BASE64",
    OverwriteUnmanagedCustomizations: false,
    PublishWorkflows: true,
    SkipProductUpdateDependencies: false,
    ImportJobId: "11111111-2222-3333-4444-555555555555"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.state.activeSolutionOperations)), []);
});
