"use strict";
/*
 * Unit tests for the browser provisioning engine.
 *
 * Run with:  node --test webresources/tests
 *
 * The suite never touches a real tenant: every HTTP call goes through an
 * injected mock fetch, randomness comes from an injected crypto stub, and the
 * end-to-end orchestration test runs in dry-run mode.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const repoRoot = path.resolve(__dirname, "..", "..");
const engine = require(path.join(repoRoot, "webresources", "segment-preview-provisioning.js"));
const embeddedTemplate = require(path.join(repoRoot, "webresources", "segment-preview-azure-template.js"));

// --------------------------------------------------------------------- mocks

function jsonResponse(status, body, headers) {
  const map = new Map(Object.entries(headers || {}));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => map.get(key) ?? map.get(String(key).toLowerCase()) ?? null },
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body))
  };
}
/**
 * Builds a fetch stub from a list of matchers. Every call is recorded so tests
 * can assert on the exact request sequence.
 */
function createFetchMock(routes) {
  const calls = [];
  const remaining = routes.slice();
  const fetchImpl = async (url, init) => {
    const request = { url, method: (init && init.method) || "GET", init };
    calls.push(request);
    const index = remaining.findIndex((route) => route.match(request));
    if (index === -1) {
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    }
    const route = remaining[index];
    if (!route.repeat) remaining.splice(index, 1);
    return route.respond(request);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const immediateTimer = (callback) => callback();

// --------------------------------------------------------------- validation

test("isGuid accepts real guids and rejects the empty guid", () => {
  assert.equal(engine.isGuid("6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6"), true);
  assert.equal(engine.isGuid("6F6C1F2E-6B47-4A1A-9D2C-33E1B2C4D5E6"), true);
  assert.equal(engine.isGuid("00000000-0000-0000-0000-000000000000"), false);
  assert.equal(engine.isGuid("not-a-guid"), false);
  assert.equal(engine.isGuid(""), false);
  assert.equal(engine.isGuid(null), false);
});

test("isWebAppName enforces the Azure naming rules", () => {
  assert.equal(engine.isWebAppName("segment-preview-api"), true);
  assert.equal(engine.isWebAppName("a1"), true);
  assert.equal(engine.isWebAppName("-leading"), false);
  assert.equal(engine.isWebAppName("trailing-"), false);
  assert.equal(engine.isWebAppName("double--hyphen"), false);
  assert.equal(engine.isWebAppName("Upper"), false);
  assert.equal(engine.isWebAppName("x".repeat(41)), false);
});

test("environmentDomain normalises Dataverse urls and rejects http", () => {
  assert.equal(engine.environmentDomain("https://contoso.crm4.dynamics.com"), "contoso.crm4.dynamics.com");
  assert.equal(engine.environmentDomain("contoso.crm4.dynamics.com/main.aspx"), "contoso.crm4.dynamics.com");
  assert.equal(engine.environmentDomain("http://contoso.crm4.dynamics.com"), null);
  assert.equal(engine.environmentDomain(""), null);
});

test("apiBaseUrl always produces the /api/ suffix over https", () => {
  assert.equal(engine.apiBaseUrl("segment-preview.azurewebsites.net"), "https://segment-preview.azurewebsites.net/api/");
  assert.equal(
    engine.apiBaseUrl("https://segment-preview.azurewebsites.net/api/"),
    "https://segment-preview.azurewebsites.net/api/"
  );
});

test("fabricSqlServer extracts the host from a lakehouse connection string", () => {
  assert.equal(
    engine.fabricSqlServer("Data Source=tcp:abcd.datawarehouse.fabric.microsoft.com,1433;Initial Catalog=Serving"),
    "abcd.datawarehouse.fabric.microsoft.com"
  );
  assert.equal(
    engine.fabricSqlServer("abcd.datawarehouse.fabric.microsoft.com"),
    "abcd.datawarehouse.fabric.microsoft.com"
  );
  assert.equal(engine.fabricSqlServer(""), null);
});

test("requiredTables de-duplicates, lower-cases, sorts, and validates", () => {
  assert.deepEqual(engine.requiredTables("Contact, contact ,msdynmkt_purpose"), ["contact", "msdynmkt_purpose"]);
  assert.deepEqual(engine.requiredTables(""), [
    "contact",
    "msdynmkt_contactpointconsent4",
    "msdynmkt_purpose",
    "msdynmkt_topic"
  ]);
  assert.throws(() => engine.requiredTables("bad table"), /not a valid Dataverse table name/);
});

test("validateTarget requires only subscription and resource group for a new installation", () => {
  const result = engine.validateTarget({});
  assert.equal(result.valid, false);
  const fields = result.errors.map((error) => error.field);
  assert.deepEqual(fields, ["subscriptionId", "resourceGroup"]);
});

test("automatic target derives all new-installation defaults without requiring a capacity", () => {
  const input = {
    subscriptionId: "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
    resourceGroup: "rg-segment-preview"
  };
  const target = engine.applyAutomaticTarget(input);
  assert.equal(target.location, "westeurope");
  assert.match(target.webAppName, /^segment-preview-6f6c1f2e-[a-z0-9]+$/);
  assert.equal(target.fabricWorkspaceName, "rg-segment-preview Segment Preview");
  assert.equal(target.fabricServingLakehouseName, "SegmentPreviewServing");
  assert.equal(target.fabricDataverseDeltaFolder, "deltalake");
  assert.equal(target.fabricCapacityId, undefined);
  assert.deepEqual(engine.validateTarget(input), { valid: true, errors: [] });
});

test("validateTarget accepts a complete configuration", () => {
  const result = engine.validateTarget({
    subscriptionId: "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
    resourceGroup: "rg-segment-preview",
    location: "westeurope",
    webAppName: "segment-preview-api",
    fabricWorkspaceId: "11111111-2222-3333-4444-555555555555",
    fabricServingLakehouseId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
    fabricDataverseConnectionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    fabricDataverseDeltaFolder: "deltalake"
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});


// ------------------------------------------------------------ mode resolution

test("resolveMode falls back to manual and names the tenant registration first", () => {
  const resolution = engine.resolveMode({});
  assert.equal(resolution.mode, "manual");
  assert.equal(resolution.automated, false);
  const ids = resolution.blockers.map((blocker) => blocker.id);
  assert.deepEqual(ids, ["client-id-not-configured", "broker-not-configured"]);
  const direct = resolution.blockers[0];
  assert.equal(direct.owner, "administrator");
  assert.equal(direct.optional, false, "self-service registration is the primary path");
  assert.equal(direct.resolvable, "in-page");
  assert.match(direct.message, /Connect this environment/);
  assert.match(direct.message, /your own tenant/);
  assert.match(direct.message, new RegExp(engine.ENV.clientId));
  const broker = resolution.blockers[1];
  assert.equal(broker.owner, "publisher");
  assert.equal(broker.resolvable, "in-page");
  assert.equal(broker.optional, true, "a hosted service is never required");
  assert.match(broker.message, /^Optional/);
});

test("the hosted service blocker stays optional even when a client id is configured", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.mode]: "manual",
    [engine.ENV.clientId]: "11111111-2222-3333-4444-555555555555"
  });
  const broker = resolution.blockers.find((blocker) => blocker.id === "broker-not-configured");
  assert.equal(broker.optional, true);
  assert.equal(resolution.blockers.some((blocker) => blocker.id === "client-id-not-configured"), false);
});

test("the tenant registration blocker becomes optional once a broker is configured", () => {
  const resolution = engine.resolveMode({ [engine.ENV.mode]: "manual", [engine.ENV.brokerUrl]: "https://provision.contoso.com" });
  const direct = resolution.blockers.find((blocker) => blocker.id === "client-id-not-configured");
  assert.equal(direct.optional, true);
  assert.equal(resolution.blockers.some((blocker) => blocker.id === "broker-not-configured"), false);
});

test("no blocker tells the administrator to run a local installer", () => {
  const resolution = engine.resolveMode({});
  resolution.blockers.forEach((blocker) => {
    assert.doesNotMatch(blocker.message, /installer|\.ps1|PowerShell/i);
  });
});

test("resolveMode prefers the tenant-owned direct path when both are configured", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.clientId]: "11111111-2222-3333-4444-555555555555",
    [engine.ENV.brokerUrl]: "https://provision.contoso.com"
  });
  assert.equal(resolution.mode, "direct");
  assert.equal(resolution.brokerOrigin, "https://provision.contoso.com");
});

test("an explicit broker request still wins over a configured client id", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.mode]: "broker",
    [engine.ENV.clientId]: "11111111-2222-3333-4444-555555555555",
    [engine.ENV.brokerUrl]: "https://provision.contoso.com"
  });
  assert.equal(resolution.mode, "broker");
});

test("an explicit direct request still wins over a configured broker", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.mode]: "direct",
    [engine.ENV.clientId]: "11111111-2222-3333-4444-555555555555",
    [engine.ENV.brokerUrl]: "https://provision.contoso.com"
  });
  assert.equal(resolution.mode, "direct");
});

test("resolveMode selects broker mode from the service url alone", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.brokerUrl]: "https://provision.contoso.com"
  });
  assert.equal(resolution.mode, "broker");
  assert.equal(resolution.automated, true);
  assert.deepEqual(resolution.blockers, []);
});

test("resolveMode refuses a non-https broker url", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.brokerUrl]: "http://provision.contoso.com"
  });
  assert.equal(resolution.mode, "manual");
  assert.equal(resolution.brokerReady, false);
  assert.equal(resolution.brokerOrigin, null);
});

test("resolveMode selects direct mode from a client id alone", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.clientId]: "11111111-2222-3333-4444-555555555555"
  });
  assert.equal(resolution.mode, "direct");
  assert.equal(resolution.directReady, true);
});

test("resolveMode honours an explicit manual request even when configured", () => {
  const resolution = engine.resolveMode({
    [engine.ENV.mode]: "manual",
    [engine.ENV.clientId]: "11111111-2222-3333-4444-555555555555"
  });
  assert.equal(resolution.mode, "manual");
  assert.match(resolution.reason, /'manual'/);
});

test("resolveMode downgrades to manual when the requested mode is incomplete", () => {
  const resolution = engine.resolveMode({ [engine.ENV.mode]: "broker" });
  assert.equal(resolution.mode, "manual");
  assert.match(resolution.reason, /not configured completely/);
});

test("normalizeMode only accepts the three documented values", () => {
  assert.equal(engine.normalizeMode("Broker"), "broker");
  assert.equal(engine.normalizeMode(" DIRECT "), "direct");
  assert.equal(engine.normalizeMode("auto"), null);
  assert.equal(engine.normalizeMode(""), null);
});


// ------------------------------------------------------------------- secrets

test("generateApiKey produces url-safe keys of the expected length", () => {
  const key = engine.generateApiKey(webcrypto);
  assert.equal(key.length, 64);
  assert.match(key, /^[A-Za-z0-9_-]+$/);
});

test("generateApiKey is not deterministic", () => {
  const keys = new Set();
  for (let index = 0; index < 25; index++) keys.add(engine.generateApiKey(webcrypto));
  assert.equal(keys.size, 25);
});

test("generateApiKey refuses to run without a CSPRNG", () => {
  assert.throws(() => engine.generateApiKey({}), /cryptographically secure/);
});

test("fingerprint is stable, short, and non-reversible", async () => {
  const first = await engine.fingerprint("hello", webcrypto);
  const second = await engine.fingerprint("hello", webcrypto);
  const other = await engine.fingerprint("hello2", webcrypto);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^sha256:[0-9a-f]{16}$/);
  assert.equal(await engine.fingerprint("", webcrypto), "sha256:none");
});


// ------------------------------------------------------------- configuration

test("parseConfiguration tolerates blank and corrupt values", () => {
  assert.deepEqual(engine.parseConfiguration(""), {});
  assert.deepEqual(engine.parseConfiguration("{not json"), {});
  assert.deepEqual(engine.parseConfiguration("[1,2]"), {});
  assert.deepEqual(engine.parseConfiguration('{"target":{"location":"northeurope"}}'), {
    target: { location: "northeurope" }
  });
});

test("mergeConfiguration applies defaults, later wins, and ignores placeholders", () => {
  const merged = engine.mergeConfiguration(
    { location: "northeurope", webAppName: "<web-app-name>" },
    { webAppName: "segment-preview-api", location: "  " }
  );
  assert.equal(merged.location, "northeurope");
  assert.equal(merged.webAppName, "segment-preview-api");
  assert.equal(merged.fabricDataverseDeltaFolder, "deltalake");
  assert.equal(merged.requiredDataverseTables, engine.TARGET_DEFAULTS.requiredDataverseTables);
});

test("serializeConfiguration never persists a secret", () => {
  const json = engine.serializeConfiguration(
    {
      subscriptionId: "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
      webAppName: "segment-preview-api",
      behavioralApiKey: "super-secret",
      unknownField: "dropped"
    },
    { apiKey: "super-secret", "azure-infra": true, apiKeyFingerprint: "sha256:abcdef0123456789" }
  );
  assert.equal(json.includes("super-secret"), false);
  const parsed = JSON.parse(json);
  assert.equal(parsed.contractVersion, engine.CONTRACT_VERSION);
  assert.equal(parsed.target.webAppName, "segment-preview-api");
  assert.equal("unknownField" in parsed.target, false);
  assert.equal(parsed.state["azure-infra"], true);
  assert.equal(parsed.state.apiKeyFingerprint, "sha256:abcdef0123456789");
});

test("configuration round-trips through parse and serialize", () => {
  const target = engine.mergeConfiguration({ subscriptionId: "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6" });
  const restored = engine.parseConfiguration(engine.serializeConfiguration(target, {}));
  assert.equal(restored.target.subscriptionId, "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6");
  assert.equal(engine.mergeConfiguration(restored.target).location, "westeurope");
});


// -------------------------------------------------------------- plan/consent

test("buildPlan returns every step in order by default", () => {
  const plan = engine.buildPlan({ mode: "direct" });
  assert.equal(plan.length, engine.STEPS.length);
  assert.deepEqual(
    plan.map((step) => step.id),
    engine.STEPS.map((step) => step.id)
  );
  assert.ok(plan.every((step) => step.skipped === false));
});

test("buildPlan skips everything but preflight and verify in manual mode", () => {
  const plan = engine.buildPlan({ mode: "manual", completed: { secret: true } });
  const active = plan.filter((step) => !step.skipped).map((step) => step.id);
  assert.deepEqual(active, ["preflight", "verify"]);
  assert.equal(plan.find((step) => step.id === "consent").skipped, true);
  assert.equal(plan.find((step) => step.id === "secret").status, "completed");
});

test("buildPlan honours the skip switches", () => {
  const plan = engine.buildPlan({ mode: "direct", skipFabric: true, skipAzure: true });
  const skipped = plan.filter((step) => step.skipped).map((step) => step.id);
  assert.ok(skipped.includes("fabric-discovery"));
  assert.ok(skipped.includes("azure-infra"));
  assert.equal(plan.find((step) => step.id === "dataverse-config").skipped, false);
});

test("describeConsent lists the interactive steps that cannot be automated", () => {
  const consent = engine.describeConsent();
  const ids = consent.map((item) => item.id);
  assert.ok(ids.includes("entra-sign-in"));
  assert.ok(ids.includes("app-admin-consent"));
  assert.ok(ids.includes("fabric-service-principal-apis"));
  assert.ok(ids.includes("dataverse-fabric-link"));
  assert.ok(consent.every((item) => typeof item.guidance === "string" && item.guidance.length > 0));
  assert.ok(consent.filter((item) => item.automatable === false).length >= 6);
});


// ---------------------------------------------------------------- http retry

test("createHttp retries throttled responses and then succeeds", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return attempts < 3
      ? jsonResponse(429, { message: "slow down" }, { "Retry-After": "0" })
      : jsonResponse(200, { ok: true });
  };
  const http = engine.createHttp({ fetch: fetchImpl, timer: immediateTimer });
  const result = await http.send({ url: "https://example.invalid/x" });
  assert.equal(attempts, 3);
  assert.deepEqual(result.body, { ok: true });
});

test("createHttp surfaces a non-retryable error message", async () => {
  const http = engine.createHttp({
    fetch: async () => jsonResponse(403, { error: { message: "Forbidden by policy" } }),
    timer: immediateTimer
  });
  await assert.rejects(() => http.send({ url: "https://example.invalid/x" }), /Forbidden by policy/);
});

test("createHttp surfaces nested ARM validation details", async () => {
  const http = engine.createHttp({
    fetch: async () =>
      jsonResponse(400, {
        error: {
          code: "InvalidTemplateDeployment",
          message: "The template deployment is not valid.",
          details: [
            {
              code: "ValidationForResourceFailed",
              message: "Validation failed for a resource.",
              details: [
                {
                  code: "InternalSubscriptionIsOverQuotaForSku",
                  message: "Current Limit (Total VMs): 0"
                }
              ]
            }
          ]
        }
      }),
    timer: immediateTimer
  });
  await assert.rejects(
    () => http.send({ url: "https://management.azure.com/x" }),
    /The template deployment is not valid\.[\s\S]*Validation failed for a resource\.[\s\S]*Current Limit \(Total VMs\): 0/
  );
});


// ---------------------------------------------------------- dataverse client

const ENV_QUERY_ROUTE = (records) => ({
  repeat: true,
  match: (request) => request.method === "GET" && request.url.includes("environmentvariabledefinitions?"),
  respond: () => jsonResponse(200, { value: records })
});

test("dataverse client reads definitions and their current values", async () => {
  const fetchImpl = createFetchMock([
    ENV_QUERY_ROUTE([
      {
        schemaname: "klth_FabricBehavioralApiUrl",
        environmentvariabledefinitionid: "d1",
        defaultvalue: "https://default.invalid/api/",
        environmentvariabledefinition_environmentvariablevalue: [
          { environmentvariablevalueid: "v1", value: "https://actual.invalid/api/" }
        ]
      },
      {
        schemaname: "klth_SetupEntraClientId",
        environmentvariabledefinitionid: "d2",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: []
      }
    ])
  ]);
  const client = engine.createDataverseClient({ fetch: fetchImpl, clientUrl: "https://contoso.crm4.dynamics.com" });
  const variables = await client.getEnvironmentVariables(["klth_FabricBehavioralApiUrl", "klth_SetupEntraClientId"]);
  assert.equal(variables.klth_FabricBehavioralApiUrl.valueId, "v1");
  assert.equal(client.effectiveValue(variables.klth_FabricBehavioralApiUrl), "https://actual.invalid/api/");
  assert.equal(variables.klth_SetupEntraClientId.valueId, null);
  assert.equal(client.effectiveValue(variables.klth_SetupEntraClientId), null);
  assert.ok(fetchImpl.calls[0].url.startsWith("https://contoso.crm4.dynamics.com/api/data/v9.2/"));
  assert.equal(fetchImpl.calls[0].init.credentials, "same-origin");
});

test("dataverse client patches an existing value and posts a missing one", async () => {
  const written = [];
  const fetchImpl = createFetchMock([
    {
      repeat: true,
      match: (request) => request.method === "PATCH",
      respond: (request) => {
        written.push({ method: "PATCH", url: request.url, body: JSON.parse(request.init.body) });
        return jsonResponse(204);
      }
    },
    {
      repeat: true,
      match: (request) => request.method === "POST",
      respond: (request) => {
        written.push({ method: "POST", url: request.url, body: JSON.parse(request.init.body) });
        return jsonResponse(201, {});
      }
    }
  ]);
  const client = engine.createDataverseClient({ fetch: fetchImpl, clientUrl: "https://contoso.crm4.dynamics.com" });
  const known = {
    klth_FabricBehavioralApiUrl: {
      definitionId: "d1",
      valueId: "v1",
      value: "https://old.invalid/api/"
    },
    klth_FabricBehavioralApiKey: { definitionId: "d2", valueId: null }
  };
  const patched = await client.setEnvironmentVariable("klth_FabricBehavioralApiUrl", "https://new.invalid/api/", known);
  const created = await client.setEnvironmentVariable("klth_FabricBehavioralApiKey", "generated-key", known);
  assert.equal(patched.created, false);
  assert.equal(created.created, true);
  assert.ok(written[0].url.endsWith("environmentvariablevalues(v1)"));
  assert.equal(written[0].body.value, "https://new.invalid/api/");
  assert.equal(written[1].body["EnvironmentVariableDefinitionId@odata.bind"], "/environmentvariabledefinitions(d2)");
  const unchanged = await client.setEnvironmentVariable(
    "klth_FabricBehavioralApiUrl",
    "https://new.invalid/api/",
    {
      klth_FabricBehavioralApiUrl: {
        definitionId: "d1",
        valueId: "v1",
        value: "https://new.invalid/api/"
      }
    }
  );
  assert.equal(unchanged.updated, false);
  assert.equal(written.length, 2, "an unchanged value must not be patched again");
});

test("dataverse client reset deletes only current environment variable values", async () => {
  const fetchImpl = createFetchMock([
    ENV_QUERY_ROUTE([
      {
        schemaname: "klth_SetupConfiguration",
        environmentvariabledefinitionid: "d1",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: [
          { environmentvariablevalueid: "v1", value: "{\"target\":{}}" }
        ]
      },
      {
        schemaname: "klth_SetupBrokerUrl",
        environmentvariabledefinitionid: "d2",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: []
      }
    ]),
    {
      match: (request) =>
        request.method === "DELETE" &&
        request.url.endsWith("environmentvariablevalues(v1)"),
      respond: () => jsonResponse(204)
    }
  ]);
  const client = engine.createDataverseClient({
    fetch: fetchImpl,
    clientUrl: "https://contoso.crm4.dynamics.com"
  });
  const cleared = await client.resetEnvironmentVariables([
    "klth_SetupConfiguration",
    "klth_SetupBrokerUrl"
  ]);
  assert.deepEqual(cleared, ["klth_SetupConfiguration"]);
  assert.equal(fetchImpl.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("dataverse client unwraps the setup Custom API result", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.url.endsWith("klth_ManageSegmentPreviewSetup"),
      respond: () => jsonResponse(200, { klth_resultjson: JSON.stringify({ overallState: "ready", components: [] }) })
    }
  ]);
  const client = engine.createDataverseClient({ fetch: fetchImpl, clientUrl: "https://contoso.crm4.dynamics.com" });
  const status = await client.executeSetupAction("status");
  assert.equal(status.overallState, "ready");
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).klth_action, "status");
});


// ------------------------------------------------------------ broker session

/**
 * Minimal stand-in for the browser popup + postMessage plumbing. No real broker
 * exists yet, so every broker test drives this mock: it proves the contract the
 * publisher service has to implement, not that a service is deployed.
 */

function createPopupHarness(options = {}) {
  const handlers = [];
  const popup = { closed: false, close() { this.closed = true; } };
  const harness = {
    opened: [],
    popup,
    blocked: options.blocked === true,
    messages: {
      addEventListener(handler) {
        handlers.push(handler);
      },
      removeEventListener(handler) {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      }
    },
    openWindow(url) {
      harness.opened.push(url);
      if (harness.blocked) return null;
      if (options.onOpen) setTimeout(() => options.onOpen(harness), 0);
      return popup;
    },
    post(message, origin) {
      handlers.slice().forEach((handler) => handler({ origin, data: message, source: popup }));
    },
    get listenerCount() {
      return handlers.length;
    }
  };
  return harness;
}
const BROKER_URL = "https://provision.contoso.com";
function brokerSessionResponse(overrides = {}) {
  return Object.assign(
    {
      sessionId: "session-1",
      authorizeUrl: BROKER_URL + "/auth/start?session=session-1",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    },
    overrides
  );
}
test("createBrokerSession refuses a non-https service url", () => {
  assert.throws(
    () => engine.createBrokerSession({ baseUrl: "http://provision.contoso.com", fetch: async () => jsonResponse(200, {}) }),
    /absolute https URL/
  );
});

test("the session request carries the contract, a fresh nonce and the page origin", async () => {
  let captured = null;
  const harness = createPopupHarness();
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL + "/",
    pageOrigin: "https://contoso.crm4.dynamics.com",
    fetch: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return jsonResponse(201, brokerSessionResponse());
    },
    openWindow: harness.openWindow,
    messages: harness.messages,
    randomBytes: () => new Uint8Array(32).fill(7)
  });
  const session = await client.createSession({ environmentDomain: "contoso.crm4.dynamics.com" });
  assert.equal(captured.url, BROKER_URL + "/v1/sessions");
  assert.equal(captured.body.contractVersion, engine.CONTRACT_VERSION);
  assert.equal(captured.body.origin, "https://contoso.crm4.dynamics.com");
  assert.equal(captured.body.environmentDomain, "contoso.crm4.dynamics.com");
  assert.ok(captured.body.nonce.length > 10);
  assert.equal(session.nonce, captured.body.nonce);
  assert.equal(session.brokerUrl, BROKER_URL);
});

test("a sign-in url on a foreign origin is refused before a window opens", async () => {
  const harness = createPopupHarness();
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    pageOrigin: "https://contoso.crm4.dynamics.com",
    fetch: async () => jsonResponse(201, brokerSessionResponse({ authorizeUrl: "https://evil.example.com/auth" })),
    openWindow: harness.openWindow,
    messages: harness.messages
  });
  await assert.rejects(() => client.createSession({}), /different origin/);
  assert.deepEqual(harness.opened, []);
});

test("a session response without a session id is refused", async () => {
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, { authorizeUrl: BROKER_URL + "/auth" }),
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} }
  });
  await assert.rejects(() => client.createSession({}), /did not return a sign-in session/);
});

test("authorize resolves on a valid postMessage and closes the popup", async () => {
  const harness = createPopupHarness({
    onOpen: (h) =>
      h.post(
        {
          type: engine.BROKER_MESSAGE_TYPE,
          sessionId: "session-1",
          nonce: "nonce-1",
          status: "authorized",
          sessionToken: "broker-session-token",
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          account: "admin@contoso.com"
        },
        BROKER_URL
      )
  });
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, brokerSessionResponse()),
    openWindow: harness.openWindow,
    messages: harness.messages
  });
  const result = await client.authorize({
    sessionId: "session-1",
    nonce: "nonce-1",
    authorizeUrl: BROKER_URL + "/auth/start"
  });
  assert.equal(result.sessionToken, "broker-session-token");
  assert.equal(result.account, "admin@contoso.com");
  assert.equal(result.brokerUrl, BROKER_URL);
  assert.equal(harness.popup.closed, true, "the popup must be closed again");
  assert.equal(harness.listenerCount, 0, "the message listener must be removed");
});

test("a message from a foreign origin is ignored", async () => {
  const harness = createPopupHarness({
    onOpen: (h) => {
      h.post(
        { type: engine.BROKER_MESSAGE_TYPE, sessionId: "session-1", nonce: "n", status: "authorized", sessionToken: "stolen" },
        "https://evil.example.com"
      );
      h.post(
        { type: engine.BROKER_MESSAGE_TYPE, sessionId: "session-1", nonce: "n", status: "authorized", sessionToken: "real" },
        BROKER_URL
      );
    }
  });
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, brokerSessionResponse()),
    openWindow: harness.openWindow,
    messages: harness.messages
  });
  const result = await client.authorize({ sessionId: "session-1", nonce: "n", authorizeUrl: BROKER_URL + "/a" });
  assert.equal(result.sessionToken, "real");
});

test("a message for another session id is ignored and a wrong nonce fails the sign-in", async () => {
  const other = createPopupHarness({
    onOpen: (h) => {
      h.post({ type: engine.BROKER_MESSAGE_TYPE, sessionId: "other", nonce: "n", status: "authorized", sessionToken: "x" }, BROKER_URL);
      h.post({ type: engine.BROKER_MESSAGE_TYPE, sessionId: "session-1", nonce: "n", status: "authorized", sessionToken: "ok" }, BROKER_URL);
    }
  });
  const clientA = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, brokerSessionResponse()),
    openWindow: other.openWindow,
    messages: other.messages
  });
  assert.equal((await clientA.authorize({ sessionId: "session-1", nonce: "n", authorizeUrl: BROKER_URL + "/a" })).sessionToken, "ok");
  const replay = createPopupHarness({
    onOpen: (h) =>
      h.post({ type: engine.BROKER_MESSAGE_TYPE, sessionId: "session-1", nonce: "wrong", status: "authorized", sessionToken: "x" }, BROKER_URL)
  });
  const clientB = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, brokerSessionResponse()),
    openWindow: replay.openWindow,
    messages: replay.messages
  });
  await assert.rejects(
    () => clientB.authorize({ sessionId: "session-1", nonce: "n", authorizeUrl: BROKER_URL + "/a" }),
    /unexpected sign-in response/
  );
});

test("a blocked popup and a reported failure produce actionable errors", async () => {
  const blocked = createPopupHarness({ blocked: true });
  const clientA = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, brokerSessionResponse()),
    openWindow: blocked.openWindow,
    messages: blocked.messages
  });
  await assert.rejects(
    () => clientA.authorize({ sessionId: "s", nonce: "n", authorizeUrl: BROKER_URL + "/a" }),
    /blocked/
  );
  const denied = createPopupHarness({
    onOpen: (h) =>
      h.post(
        {
          type: engine.BROKER_MESSAGE_TYPE,
          sessionId: "s",
          nonce: "n",
          status: "failed",
          error: { message: "Admin consent was declined." }
        },
        BROKER_URL
      )
  });
  const clientB = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(201, brokerSessionResponse()),
    openWindow: denied.openWindow,
    messages: denied.messages
  });
  await assert.rejects(
    () => clientB.authorize({ sessionId: "s", nonce: "n", authorizeUrl: BROKER_URL + "/a" }),
    /Admin consent was declined/
  );
});

test("connect reuses a valid stored session instead of opening a popup", async () => {
  const harness = createPopupHarness();
  let sessionRequests = 0;
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => {
      sessionRequests++;
      return jsonResponse(201, brokerSessionResponse());
    },
    openWindow: harness.openWindow,
    messages: harness.messages
  });
  const resumed = await client.connect(
    {},
    {
      sessionId: "session-9",
      sessionToken: "token-9",
      brokerUrl: BROKER_URL,
      expiresAt: new Date(Date.now() + 600000).toISOString()
    }
  );
  assert.equal(resumed.sessionId, "session-9");
  assert.equal(sessionRequests, 0);
  assert.deepEqual(harness.opened, []);
});

test("connect ignores a session issued by a different broker or already expired", async () => {
  const harness = createPopupHarness({
    onOpen: (h) =>
      h.post(
        { type: engine.BROKER_MESSAGE_TYPE, sessionId: "session-1", nonce: h.nonce, status: "authorized", sessionToken: "fresh" },
        BROKER_URL
      )
  });
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async (url, init) => {
      harness.nonce = JSON.parse(init.body).nonce;
      return jsonResponse(201, brokerSessionResponse());
    },
    openWindow: harness.openWindow,
    messages: harness.messages
  });
  const foreign = await client.connect({}, {
    sessionId: "s",
    sessionToken: "t",
    brokerUrl: "https://other.example.com",
    expiresAt: new Date(Date.now() + 600000).toISOString()
  });
  assert.equal(foreign.sessionToken, "fresh");
  assert.equal(harness.opened.length, 1);
  const expired = await client.connect({}, {
    sessionId: "s",
    sessionToken: "t",
    brokerUrl: BROKER_URL,
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal(expired.sessionToken, "fresh");
  assert.equal(harness.opened.length, 2);
});

test("run starts a run, polls it and reports every step transition once", async () => {
  let polls = 0;
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.method === "POST" && request.url.endsWith("/v1/sessions/session-1/runs"),
      respond: () => jsonResponse(202, { runId: "run-7", status: "running" })
    },
    {
      repeat: true,
      match: (request) => request.method === "GET" && request.url.endsWith("/v1/sessions/session-1/runs/run-7"),
      respond: () => {
        polls++;
        return polls === 1
          ? jsonResponse(200, { status: "running", steps: [{ id: "azure-infra", status: "running" }] })
          : jsonResponse(200, {
              status: "succeeded",
              steps: [
                { id: "azure-infra", status: "succeeded" },
                { id: "verify", status: "succeeded" }
              ],
              outputs: { apiBaseUrl: "https://segment-preview.azurewebsites.net/api/" }
            });
      }
    }
  ]);
  const progress = [];
  const runs = [];
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: fetchImpl,
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} },
    timer: immediateTimer,
    pollIntervalMs: 0
  });
  const snapshot = await client.run(
    { sessionId: "session-1", sessionToken: "session-token" },
    { contractVersion: engine.CONTRACT_VERSION },
    { onProgress: (step) => progress.push(`${step.id}:${step.status}`), onRun: (run) => runs.push(run.runId) }
  );
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.runId, "run-7");
  assert.deepEqual(runs, ["run-7"]);
  assert.deepEqual(progress, ["azure-infra:running", "azure-infra:succeeded", "verify:succeeded"]);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer session-token");
  assert.equal(fetchImpl.calls[0].init.headers["x-segment-preview-contract"], engine.CONTRACT_VERSION);
});

test("run re-attaches to a known run id without starting a second one", async () => {
  const fetchImpl = createFetchMock([
    {
      repeat: true,
      match: (request) => request.method === "GET",
      respond: () => jsonResponse(200, { status: "succeeded", steps: [{ id: "verify", status: "succeeded" }] })
    }
  ]);
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: fetchImpl,
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} },
    timer: immediateTimer,
    pollIntervalMs: 0
  });
  const snapshot = await client.run({ sessionId: "s", sessionToken: "t" }, {}, {}, "run-existing");
  assert.equal(snapshot.runId, "run-existing");
  assert.equal(fetchImpl.calls.every((call) => call.init.method === "GET"), true);
});

test("run starts a new broker run when the saved run is terminal", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.method === "GET" && request.url.endsWith("/runs/run-failed"),
      respond: () => jsonResponse(200, { status: "failed", steps: [], error: { message: "old failure" } })
    },
    {
      match: (request) => request.method === "POST" && request.url.endsWith("/v1/sessions/s/runs"),
      respond: () => jsonResponse(202, { runId: "run-retry", status: "running" })
    },
    {
      repeat: true,
      match: (request) => request.method === "GET" && request.url.endsWith("/runs/run-retry"),
      respond: () => jsonResponse(200, { status: "succeeded", steps: [] })
    }
  ]);
  const runs = [];
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: fetchImpl,
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} },
    timer: immediateTimer,
    pollIntervalMs: 0
  });
  const snapshot = await client.run(
    { sessionId: "s", sessionToken: "t" },
    {},
    { onRun: (run) => runs.push(run.runId) },
    "run-failed"
  );
  assert.equal(snapshot.runId, "run-retry");
  assert.deepEqual(runs, ["run-retry"]);
  assert.equal(fetchImpl.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("a failed run raises the reported message and a missing run id is refused", async () => {
  const failing = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: createFetchMock([
      { match: (request) => request.method === "POST", respond: () => jsonResponse(202, { runId: "run-1" }) },
      {
        repeat: true,
        match: (request) => request.method === "GET",
        respond: () => jsonResponse(200, { status: "failed", steps: [], error: { message: "Quota exceeded" } })
      }
    ]),
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} },
    timer: immediateTimer,
    pollIntervalMs: 0
  });
  await assert.rejects(() => failing.run({ sessionId: "s", sessionToken: "t" }, {}), /Quota exceeded/);
  const noRunId = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(202, {}),
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} },
    timer: immediateTimer
  });
  await assert.rejects(() => noRunId.startRun({ sessionId: "s", sessionToken: "t" }, {}), /did not return a run id/);
});

test("ending a session is best effort and never throws", async () => {
  const client = engine.createBrokerSession({
    baseUrl: BROKER_URL,
    fetch: async () => jsonResponse(500, { error: { message: "gone" } }),
    openWindow: () => ({ closed: false, close() {} }),
    messages: { addEventListener() {}, removeEventListener() {} },
    timer: immediateTimer,
    maxAttempts: 1
  });
  assert.equal(await client.end(null), false);
  assert.equal(await client.end({ sessionId: "s", sessionToken: "t" }), false);
});


// ----------------------------------------------------- broker session storage

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() {
      return map.size;
    }
  };
}
test("a stored session round-trips and is scoped to broker and environment", () => {
  const storage = memoryStorage();
  const record = {
    sessionId: "s1",
    sessionToken: "t1",
    brokerUrl: BROKER_URL,
    environmentDomain: "contoso.crm4.dynamics.com",
    expiresAt: new Date(Date.now() + 600000).toISOString()
  };
  assert.equal(engine.saveBrokerSession(storage, record), true);
  const loaded = engine.loadBrokerSession(storage, {
    brokerUrl: BROKER_URL,
    environmentDomain: "contoso.crm4.dynamics.com"
  });
  assert.equal(loaded.sessionToken, "t1");
  assert.equal(
    engine.loadBrokerSession(storage, { brokerUrl: BROKER_URL, environmentDomain: "other.crm4.dynamics.com" }),
    null
  );
});

test("an expired or corrupt stored session is dropped", () => {
  const expired = memoryStorage({
    [engine.BROKER_SESSION_KEY]: JSON.stringify({
      sessionId: "s",
      sessionToken: "t",
      brokerUrl: BROKER_URL,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })
  });
  assert.equal(engine.loadBrokerSession(expired, { brokerUrl: BROKER_URL }), null);
  assert.equal(expired.size, 0, "an unusable session must be removed from storage");
  const corrupt = memoryStorage({ [engine.BROKER_SESSION_KEY]: "{not json" });
  assert.equal(engine.loadBrokerSession(corrupt, { brokerUrl: BROKER_URL }), null);
  assert.equal(engine.loadBrokerSession(null, {}), null);
  assert.equal(engine.clearBrokerSession(null), false);
});

test("a session without a token is never accepted", () => {
  assert.equal(engine.validSession({ sessionId: "s" }, {}), null);
  assert.equal(engine.validSession(null, {}), null);
  assert.equal(engine.validSession({ sessionId: "s", sessionToken: "t" }, {}).sessionId, "s");
});


// ------------------------------------------------------- broker configuration

test("describeBrokerSetup reports an unconfigured service without inventing one", () => {
  const setup = engine.describeBrokerSetup(null);
  assert.equal(setup.configured, false);
  assert.equal(setup.url, null);
  assert.equal(setup.origin, null);
  assert.equal(setup.variable, engine.ENV.brokerUrl);
  assert.match(setup.headline, /No hosted provisioning service is configured/);
  assert.match(setup.headline, /not required/i, "the optional service is never presented as mandatory");
  assert.match(setup.summary, /optional/i);
  assert.ok(setup.steps.length >= 2);
  assert.match(setup.steps.join(" "), new RegExp(engine.ENV.brokerUrl));
  assert.doesNotMatch(JSON.stringify(setup), /https:\/\/(?!provisioning\.example)[a-z0-9.-]*\.(com|net|io)/i);
});

test("describeBrokerSetup reports a configured service and flags a malformed url", () => {
  const setup = engine.describeBrokerSetup(BROKER_URL + "/");
  assert.equal(setup.configured, true);
  assert.equal(setup.origin, BROKER_URL);
  assert.match(setup.summary, new RegExp(BROKER_URL));
  assert.match(setup.steps[0], /Install everything/);
  const invalid = engine.describeBrokerSetup("provision.contoso.com");
  assert.equal(invalid.configured, false);
  assert.equal(invalid.invalid, true);
});

test("saveBrokerUrl validates and normalises the service url", async () => {
  const writes = [];
  const dataverse = {
    setEnvironmentVariable: async (name, value) => {
      writes.push([name, value]);
      return true;
    }
  };
  await assert.rejects(() => engine.saveBrokerUrl(dataverse, "http://provision.contoso.com"), /https/);
  await assert.rejects(() => engine.saveBrokerUrl(dataverse, ""), /https/);
  assert.deepEqual(writes, []);
  await engine.saveBrokerUrl(dataverse, BROKER_URL + "/");
  assert.deepEqual(writes, [[engine.ENV.brokerUrl, BROKER_URL]]);
});


// ------------------------------------------------------------- direct client

test("direct client reuses an existing Resource Group and its Azure location", async () => {
  const fetchImpl = createFetchMock([
    {
      repeat: true,
      match: () => true,
      respond: () => jsonResponse(200, { id: "/subscriptions/x", location: "eastus" })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async (scope) => `token-for-${scope}`,
    timer: immediateTimer
  });
  const group = await direct.ensureResourceGroup(
    "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
    "rg-segment-preview",
    "westeurope"
  );
  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/resourcegroups\/rg-segment-preview\?api-version=/);
  assert.equal(call.init.headers.Authorization, `Bearer token-for-${engine.ARM_SCOPE}`);
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.body, undefined);
  assert.equal(group.location, "eastus");
});

test("direct client creates a missing Resource Group in the requested location", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.init.method === "GET",
      respond: () => jsonResponse(404, { error: { message: "not found" } })
    },
    {
      match: (request) => request.init.method === "PUT",
      respond: () => jsonResponse(200, { location: "westeurope" })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });
  const group = await direct.ensureResourceGroup(
    "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
    "rg-new",
    "westeurope"
  );
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), { location: "westeurope" });
  assert.equal(group.location, "westeurope");
});

test("direct client lists Azure resource groups alphabetically", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.url.includes("/resourcegroups?api-version=2021-04-01"),
      respond: () =>
        jsonResponse(200, {
          value: [
            { id: "/subscriptions/x/resourceGroups/zeta", name: "zeta", location: "northeurope" }
          ],
          nextLink: "https://management.azure.com/subscriptions/x/resourcegroups?skiptoken=next"
        })
    },
    {
      match: (request) => request.url.endsWith("/resourcegroups?skiptoken=next"),
      respond: () =>
        jsonResponse(200, {
          value: [
            { id: "/subscriptions/x/resourceGroups/Alpha", name: "Alpha", location: "westeurope" }
          ]
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });

  const groups = await direct.listResourceGroups(
    "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6"
  );

  assert.deepEqual(groups, [
    {
      id: "/subscriptions/x/resourceGroups/Alpha",
      name: "Alpha",
      location: "westeurope"
    },
    {
      id: "/subscriptions/x/resourceGroups/zeta",
      name: "zeta",
      location: "northeurope"
    }
  ]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("direct client lists enabled Azure subscriptions alphabetically", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.url.includes("/subscriptions?api-version=2020-01-01"),
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              subscriptionId: "22222222-2222-2222-2222-222222222222",
              displayName: "Zeta",
              state: "Enabled",
              tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
            },
            {
              subscriptionId: "33333333-3333-3333-3333-333333333333",
              displayName: "Disabled",
              state: "Disabled"
            }
          ],
          nextLink: "https://management.azure.com/subscriptions?skiptoken=next"
        })
    },
    {
      match: (request) => request.url.endsWith("/subscriptions?skiptoken=next"),
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              subscriptionId: "11111111-1111-1111-1111-111111111111",
              displayName: "Alpha",
              state: "Enabled",
              tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
            }
          ]
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });

  const subscriptions = await direct.listSubscriptions();

  assert.deepEqual(subscriptions, [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Alpha",
      state: "Enabled",
      tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Zeta",
      state: "Enabled",
      tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    }
  ]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("direct client lists active Fabric capacities alphabetically", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.url.endsWith("/capacities"),
      respond: () =>
        jsonResponse(200, {
          value: [
            { id: "c2", displayName: "Zeta", sku: "F2", state: "Active", region: "West Europe" },
            { id: "c3", displayName: "Paused", sku: "F4", state: "Inactive", region: "North Europe" }
          ],
          continuationUri: "https://api.fabric.microsoft.com/v1/capacities?continuationToken=abc"
        })
    },
    {
      match: (request) => request.url.endsWith("/capacities?continuationToken=abc"),
      respond: () =>
        jsonResponse(200, {
          value: [
            { id: "c1", displayName: "Alpha", sku: "F8", state: "Active", region: "North Europe" }
          ]
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });

  const capacities = await direct.listCapacities();

  assert.deepEqual(capacities, [
    { id: "c1", name: "Alpha", sku: "F8", state: "Active", region: "North Europe" },
    { id: "c2", name: "Zeta", sku: "F2", state: "Active", region: "West Europe" }
  ]);
  assert.equal(fetchImpl.calls.length, 2);
});

test("direct client discovers selectable Azure and Fabric resources", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.url.includes("/locations?api-version=2022-12-01"),
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              name: "westeurope",
              displayName: "West Europe",
              regionalDisplayName: "(Europe) West Europe",
              metadata: { regionType: "Physical", regionCategory: "Recommended" }
            },
            {
              name: "stage",
              displayName: "Stage",
              metadata: { regionType: "Logical" }
            }
          ]
        })
    },
    {
      match: (request) => request.url.endsWith("/workspaces"),
      respond: () =>
        jsonResponse(200, {
          value: [
            { id: "personal", displayName: "My workspace", type: "Personal" },
            { id: "w1", displayName: "Production", type: "Workspace", capacityId: "c1" }
          ]
        })
    },
    {
      match: (request) => request.url.endsWith("/workspaces/w1/lakehouses"),
      respond: () => jsonResponse(200, { value: [{ id: "l1", displayName: "Serving" }] })
    },
    {
      match: (request) => request.url.endsWith("/connections"),
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              id: "d1",
              displayName: "Dataverse",
              connectivityType: "ShareableCloud",
              connectionDetails: {
                type: "CommonDataService",
                path: "https://contoso.crm4.dynamics.com/"
              },
              credentialDetails: { credentialType: "OAuth2" }
            },
            {
              id: "other",
              displayName: "Other",
              connectionDetails: { type: "Sql", path: "server" }
            }
          ]
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });

  assert.deepEqual(await direct.listLocations("sub"), [
    {
      name: "westeurope",
      displayName: "West Europe",
      regionalDisplayName: "(Europe) West Europe",
      recommended: true
    }
  ]);
  assert.deepEqual(await direct.listWorkspaces(), [
    { id: "w1", name: "Production", capacityId: "c1", region: "" }
  ]);
  assert.deepEqual(await direct.listLakehouses("w1"), [{ id: "l1", name: "Serving" }]);
  assert.deepEqual(
    await direct.listDataverseConnections("https://contoso.crm4.dynamics.com"),
    [{
      id: "d1",
      name: "Dataverse",
      connectivityType: "ShareableCloud",
      shareable: true,
      credentialType: "OAuth2"
    }]
  );
});

test("direct client grants a missing Fabric connection role idempotently", async () => {
  const connectionId = "a45e4c00-1625-43aa-8a2a-c64eade09e0e";
  const principalId = "99999999-8888-7777-6666-555555555555";
  const fetchImpl = createFetchMock([
    {
      match: (request) =>
        request.init.method === "GET" &&
        request.url.endsWith(`/connections/${connectionId}/roleAssignments`),
      respond: () => jsonResponse(200, { value: [] })
    },
    {
      match: (request) =>
        request.init.method === "POST" &&
        request.url.endsWith(`/connections/${connectionId}/roleAssignments`),
      respond: () =>
        jsonResponse(201, {
          id: principalId,
          principal: { id: principalId, type: "ServicePrincipal" },
          role: "User"
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });
  const result = await direct.ensureConnectionRoleAssignment(
    connectionId,
    principalId
  );
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), {
    principal: { id: principalId, type: "ServicePrincipal" },
    role: "User"
  });

  const existingFetch = createFetchMock([
    {
      repeat: true,
      match: () => true,
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              id: principalId,
              principal: { id: principalId, type: "ServicePrincipal" },
              role: "User"
            }
          ]
        })
    }
  ]);
  const existingDirect = engine.createDirectClient({
    fetch: existingFetch,
    getToken: async () => "token",
    timer: immediateTimer
  });
  const existing = await existingDirect.ensureConnectionRoleAssignment(
    connectionId,
    principalId
  );
  assert.equal(existing.created, false);
  assert.equal(existingFetch.calls.length, 1);
});

test("direct client confirms a hidden Fabric connection role after a generic create error", async () => {
  const connectionId = "a45e4c00-1625-43aa-8a2a-c64eade09e0e";
  const principalId = "99999999-8888-7777-6666-555555555555";
  const fetchImpl = createFetchMock([
    {
      match: (request) =>
        request.init.method === "GET" &&
        request.url.endsWith(`/connections/${connectionId}/roleAssignments`),
      respond: () => jsonResponse(200, { value: [] })
    },
    {
      match: (request) =>
        request.init.method === "POST" &&
        request.url.endsWith(`/connections/${connectionId}/roleAssignments`),
      respond: () =>
        jsonResponse(400, {
          error: { message: "An error occurred while processing the operation" }
        })
    },
    {
      match: (request) =>
        request.init.method === "GET" &&
        request.url.endsWith(
          `/connections/${connectionId}/roleAssignments/${principalId}`
        ),
      respond: () =>
        jsonResponse(200, {
          id: principalId,
          principal: { id: principalId, type: "ServicePrincipal" },
          role: "User"
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });

  const result = await direct.ensureConnectionRoleAssignment(
    connectionId,
    principalId
  );

  assert.equal(result.created, false);
  assert.equal(result.assignment.id, principalId);
  assert.equal(fetchImpl.calls.length, 3);
});

test("direct client explains that workspace admin cannot reshare a Dataverse connection", async () => {
  const connectionId = "a45e4c00-1625-43aa-8a2a-c64eade09e0e";
  const principalId = "99999999-8888-7777-6666-555555555555";
  const fetchImpl = createFetchMock([
    {
      match: (request) =>
        request.init.method === "GET" &&
        request.url.endsWith(`/connections/${connectionId}/roleAssignments`),
      respond: () => jsonResponse(200, { value: [] })
    },
    {
      match: (request) => request.init.method === "POST",
      respond: () =>
        jsonResponse(400, {
          error: { message: "An error occurred while processing the operation" }
        })
    },
    {
      match: (request) =>
        request.init.method === "GET" &&
        request.url.endsWith(
          `/connections/${connectionId}/roleAssignments/${principalId}`
        ),
      respond: () => jsonResponse(404, { error: { message: "Not found" } })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });

  await assert.rejects(
    () => direct.ensureConnectionRoleAssignment(connectionId, principalId),
    /Workspace Admin.*Owner or UserWithReshare/
  );
});

test("direct client reuses an existing Fabric workspace role", async () => {
  const workspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const principalId = "99999999-8888-7777-6666-555555555555";
  const fetchImpl = createFetchMock([
    {
      repeat: true,
      match: (request) =>
        request.init.method === "GET" &&
        request.url.endsWith(`/workspaces/${workspaceId}/roleAssignments`),
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              id: "assignment-id",
              principal: { id: principalId, type: "ServicePrincipal" },
              role: "Contributor"
            }
          ]
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });
  const result = await direct.ensureWorkspaceRoleAssignment(
    workspaceId,
    principalId
  );
  assert.equal(result.created, false);
  assert.equal(fetchImpl.calls.length, 1);
});

test("direct client upgrades an insufficient Fabric workspace role", async () => {
  const workspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const principalId = "99999999-8888-7777-6666-555555555555";
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.init.method === "GET",
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              id: "assignment-id",
              principal: { id: principalId, type: "ServicePrincipal" },
              role: "Viewer"
            }
          ]
        })
    },
    {
      match: (request) =>
        request.init.method === "PATCH" &&
        request.url.endsWith(
          `/workspaces/${workspaceId}/roleAssignments/assignment-id`
        ),
      respond: () =>
        jsonResponse(200, {
          id: "assignment-id",
          principal: { id: principalId, type: "ServicePrincipal" },
          role: "Contributor"
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });
  const result = await direct.ensureWorkspaceRoleAssignment(
    workspaceId,
    principalId
  );
  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), {
    role: "Contributor"
  });
});

test("direct client treats Fabric's duplicate workspace role response as success", async () => {
  const workspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const principalId = "99999999-8888-7777-6666-555555555555";
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.method === "GET",
      respond: () => jsonResponse(200, { value: [] })
    },
    {
      match: (request) => request.method === "POST",
      respond: () =>
        jsonResponse(400, {
          error: {
            message: "The provided principal already has a role assigned in the workspace"
          }
        })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "token",
    timer: immediateTimer
  });
  const result = await direct.ensureWorkspaceRoleAssignment(
    workspaceId,
    principalId
  );
  assert.equal(result.created, false);
  assert.equal(result.updated, false);
  assert.equal(fetchImpl.calls.length, 2);
});

test("direct client follows Fabric continuation links", async () => {
  const fetchImpl = createFetchMock([
    {
      match: (request) => request.url.endsWith("/workspaces"),
      respond: () =>
        jsonResponse(200, {
          value: [{ id: "w1" }],
          continuationUri: "https://api.fabric.microsoft.com/v1/workspaces?continuationToken=abc"
        })
    },
    {
      match: (request) => request.url.includes("continuationToken=abc"),
      respond: () => jsonResponse(200, { value: [{ id: "w2" }] })
    }
  ]);
  const direct = engine.createDirectClient({
    fetch: fetchImpl,
    getToken: async () => "t",
    timer: immediateTimer
  });
  const items = await direct.fabricCollection("workspaces");
  assert.deepEqual(
    items.map((item) => item.id),
    ["w1", "w2"]
  );
});

test("direct client polls an ARM deployment until it succeeds", async () => {
  let gets = 0;
  const progress = [];
  const fetchImpl = createFetchMock([
    { match: (request) => request.method === "PUT", respond: () => jsonResponse(200, {}) },
    {
      repeat: true,
      match: (request) =>
        request.method === "GET" && !request.url.endsWith("/operations?api-version=2022-09-01"),
      respond: () => {
        gets++;
        return gets < 2
          ? jsonResponse(200, { properties: { provisioningState: "Running" } })
          : jsonResponse(200, {
              properties: {
                provisioningState: "Succeeded",
                outputs: { webAppUrl: { value: "https://x.azurewebsites.net/api/" } }
              }
            });
      }
    },
    {
      repeat: true,
      match: (request) =>
        request.method === "GET" && request.url.endsWith("/operations?api-version=2022-09-01"),
      respond: () =>
        jsonResponse(200, {
          value: [
            {
              id: "operation-1",
              properties: {
                provisioningState: "Running",
                targetResource: {
                  id: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/segment-preview-api",
                  resourceName: "segment-preview-api",
                  resourceType: "Microsoft.Web/sites"
                }
              }
            }
          ]
        })
    }
  ]);
  const direct = engine.createDirectClient({ fetch: fetchImpl, getToken: async () => "t", timer: immediateTimer });
  const outputs = await direct.deployTemplate(
    "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
    "rg-segment-preview",
    "segment-preview",
    embeddedTemplate,
    { webAppName: "segment-preview-api" },
    { onProgress: (entry) => progress.push(entry) }
  );
  assert.equal(outputs.webAppUrl.value, "https://x.azurewebsites.net/api/");
  const put = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(put.properties.mode, "Incremental");
  assert.deepEqual(put.properties.parameters.webAppName, { value: "segment-preview-api" });
  assert.equal(progress.length, 2);
  assert.equal(progress[0].subProgress.label, "Azure resource deployment is running");
  assert.equal(progress[0].subProgress.complete, false);
  assert.deepEqual(progress[0].subProgress.steps[0], {
    id: "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/segment-preview-api",
    name: "Create Segment Preview web app",
    resourceName: "segment-preview-api",
    status: "running"
  });
  assert.equal(progress[1].subProgress.complete, true);
});

test("direct client fails fast on a failed ARM deployment", async () => {
  const fetchImpl = createFetchMock([
    { match: (request) => request.method === "PUT", respond: () => jsonResponse(200, {}) },
    {
      repeat: true,
      match: (request) =>
        request.method === "GET" && !request.url.includes("/operations"),
      respond: () => jsonResponse(200, { properties: { provisioningState: "Failed" } })
    },
    {
      repeat: true,
      match: (request) => request.method === "GET" && request.url.includes("/operations"),
      respond: () => jsonResponse(200, { value: [] })
    }
  ]);
  const direct = engine.createDirectClient({ fetch: fetchImpl, getToken: async () => "t", timer: immediateTimer });
  await assert.rejects(
    () => direct.deployTemplate("6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6", "rg", "d", {}, {}),
    /state 'Failed'/
  );
});


// ------------------------------------------------------------ token provider

test("msal token provider signs in once and reuses the silent token", async () => {
  const calls = [];
  const provider = engine.createMsalTokenProvider({
    instance: {
      getAllAccounts: () => [],
      loginPopup: async (request) => {
        calls.push(`login:${request.scopes.join(",")}`);
        return { account: { username: "admin@contoso.com" } };
      },
      acquireTokenSilent: async (request) => {
        calls.push(`silent:${request.scopes.join(",")}`);
        return { accessToken: "silent-token" };
      },
      acquireTokenPopup: async () => {
        calls.push("popup");
        return { accessToken: "popup-token" };
      }
    }
  });
  assert.equal(await provider.getToken(engine.ARM_SCOPE), "silent-token");
  assert.equal(await provider.getToken(engine.FABRIC_SCOPE), "silent-token");
  assert.equal(provider.getAccount().username, "admin@contoso.com");
  assert.equal(calls.filter((entry) => entry.startsWith("login:")).length, 1);
});

test("msal token provider falls back to an interactive prompt", async () => {
  const provider = engine.createMsalTokenProvider({
    instance: {
      getAllAccounts: () => [{ username: "admin@contoso.com" }],
      acquireTokenSilent: async () => {
        throw new Error("interaction_required");
      },
      acquireTokenPopup: async () => ({ accessToken: "popup-token" })
    }
  });
  assert.equal(await provider.getToken(engine.ARM_SCOPE), "popup-token");
});

test("msal token provider requires an injected instance", () => {
  assert.throws(() => engine.createMsalTokenProvider({}), /MSAL instance is required/);
});


// ------------------------------------------------------------- orchestration

const VALID_TARGET = {
  subscriptionId: "6f6c1f2e-6b47-4a1a-9d2c-33e1b2c4d5e6",
  resourceGroup: "rg-segment-preview",
  location: "westeurope",
  webAppName: "segment-preview-api",
  fabricWorkspaceId: "11111111-2222-3333-4444-555555555555",
  fabricServingLakehouseId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  fabricDataverseConnectionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  fabricDataverseDeltaFolder: "deltalake",
  requiredDataverseTables: engine.TARGET_DEFAULTS.requiredDataverseTables};
test("a dry run walks every step and performs no write", async () => {
  const fetchImpl = createFetchMock([
    { repeat: true, match: () => true, respond: () => jsonResponse(500, { message: "must not be called" }) }
  ]);
  const dataverse = engine.createDataverseClient({
    fetch: fetchImpl,
    clientUrl: "https://contoso.crm4.dynamics.com"
  });
  const progress = [];
  const orchestrator = engine.createOrchestrator({
    dataverse,
    mode: "direct",
    dryRun: true,
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    template: embeddedTemplate,
    timer: immediateTimer,
    hooks: { onProgress: (step) => progress.push(`${step.id}:${step.status}`) }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(fetchImpl.calls.length, 0, "a dry run must not issue any request");
  assert.deepEqual(
    result.results.map((entry) => entry.id),
    engine.STEPS.map((step) => step.id)
  );
  assert.ok(result.results.every((entry) => entry.status === "succeeded"));
  assert.ok(progress.includes("preflight:running"));
  assert.equal(result.context.apiKeyFingerprint, "sha256:dry-run");
});

test("a dry run in manual mode only validates and re-checks", async () => {
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({
      fetch: async () => jsonResponse(500, {}),
      clientUrl: "https://contoso.crm4.dynamics.com"
    }),
    mode: "manual",
    dryRun: true,
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true);
  assert.equal(result.results.find((entry) => entry.id === "consent").status, "skipped");
  assert.equal(result.results.find((entry) => entry.id === "secret").status, "skipped");
  assert.deepEqual(
    result.results.filter((entry) => entry.status === "succeeded").map((entry) => entry.id),
    ["preflight", "verify"]
  );
});

test("preflight stops the run when the target is incomplete", async () => {
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({
      fetch: async () => jsonResponse(500, {}),
      clientUrl: "https://contoso.crm4.dynamics.com"
    }),
    mode: "direct",
    dryRun: true,
    target: {},
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "preflight");
  assert.equal(result.results.length, 1);
});

test("completed steps are resumed rather than repeated", async () => {
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({
      fetch: async () => jsonResponse(500, {}),
      clientUrl: "https://contoso.crm4.dynamics.com"
    }),
    mode: "direct",
    dryRun: true,
    completed: { consent: true, "azure-infra": true, secret: true },
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.results.find((entry) => entry.id === "azure-infra").status, "resumed");
  assert.equal(result.results.find((entry) => entry.id === "verify").status, "succeeded");
  assert.equal(
    result.results.find((entry) => entry.id === "secret").status,
    "succeeded",
    "the secret step always runs so the key is in memory for every later step"
  );
  assert.equal(
    result.results.find((entry) => entry.id === "consent").status,
    "succeeded",
    "consent always runs so broker sessions and direct tokens are hydrated on resume"
  );
});

test("a live broker-mode run delegates, writes the environment variables, and verifies", async () => {
  const requests = [];
  const fetchImpl = createFetchMock([
    ENV_QUERY_ROUTE([
      {
        schemaname: "klth_FabricBehavioralApiUrl",
        environmentvariabledefinitionid: "d1",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: [
          { environmentvariablevalueid: "v1", value: "https://old.invalid/api/" }
        ]
      },
      {
        schemaname: "klth_FabricBehavioralApiKey",
        environmentvariabledefinitionid: "d2",
        defaultvalue: "committed-default",
        environmentvariabledefinition_environmentvariablevalue: []
      }
    ]),
    {
      repeat: true,
      match: (request) =>
        request.method === "PATCH" ||
        (request.method === "POST" && request.url.endsWith("environmentvariablevalues")),
      respond: (request) => {
        requests.push(JSON.parse(request.init.body));
        return jsonResponse(204);
      }
    },
    {
      match: (request) => request.url.endsWith("klth_ManageSegmentPreviewSetup"),
      respond: () => jsonResponse(200, { klth_resultjson: JSON.stringify({ overallState: "partial" }) })
    }
  ]);
  let brokerRequest = null;
  let brokerRuns = 0;
  let connects = 0;
  const broker = {
    connect: async () => {
      connects++;
      return {
        sessionId: "session-1",
        sessionToken: "session-token",
        brokerUrl: "https://provision.contoso.com",
        account: "admin@contoso.com"
      };
    },
    run: async (session, request, hooks) => {
      brokerRuns++;
      assert.equal(session.sessionToken, "session-token", "the run must use the authorized session");
      brokerRequest = request;
      if (hooks && hooks.onProgress) hooks.onProgress({ id: "azure-infra", status: "succeeded" });
      return {
        status: "succeeded",
        steps: [
          { id: "fabric-discovery", status: "succeeded", message: "Workspace ready." },
          { id: "fabric-notebook", status: "skipped" },
          { id: "azure-infra", status: "succeeded" },
          { id: "fabric-permissions", status: "succeeded" },
          { id: "azure-app", status: "succeeded" }
        ],
        outputs: {
          apiBaseUrl: "https://broker-provisioned.azurewebsites.net/api/",
          workspaceId: "11111111-2222-3333-4444-555555555555",
          servingLakehouseId: "66666666-7777-8888-9999-aaaaaaaaaaaa"
        },
        manual: ["Enable the Fabric tenant setting for service principals."]
      };
    }
  };
  const dataverse = engine.createDataverseClient({
    fetch: fetchImpl,
    clientUrl: "https://contoso.crm4.dynamics.com"
  });
  const orchestrator = engine.createOrchestrator({
    dataverse,
    broker,
    mode: "broker",
    dryRun: false,
    brokerScope: "api://broker/Provisioning.ReadWrite",
    getToken: async () => "broker-token",
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    apiPackageUrl: STAMPED_PACKAGE,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(brokerRuns, 1, "the broker must be called exactly once");
  assert.equal(connects, 1, "the browser must sign in to the service exactly once");
  assert.equal(brokerRequest.contractVersion, engine.CONTRACT_VERSION);
  assert.equal(brokerRequest.azure.webAppName, "segment-preview-api");
  assert.ok(brokerRequest.apiPackage, "the service must be told exactly which package to deploy");
  assert.equal(brokerRequest.apiPackage.url, "https://contoso.example.com/segment-preview-api-1.1.0.0.zip");
  assert.equal(brokerRequest.apiPackage.sha256, SHIPPED_SHA);
  assert.equal(brokerRequest.apiPackage.blobName, engine.packageBlobName(brokerRequest.apiPackage));
  assert.match(brokerRequest.secrets.behavioralApiKey, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(result.results.find((entry) => entry.id === "fabric-notebook").message, "Skipped by the provisioning service.");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].value, "https://broker-provisioned.azurewebsites.net/api/");
  assert.equal(requests[1].value, brokerRequest.secrets.behavioralApiKey);
  assert.deepEqual(result.manual, ["Enable the Fabric tenant setting for service principals."]);
  assert.equal(result.context.overallState, "partial");
  assert.match(result.context.apiKeyFingerprint, /^sha256:[0-9a-f]{16}$/);
});

test("a broker failure for a single step stops the run", async () => {
  const broker = {
    connect: async () => ({ sessionId: "s", sessionToken: "t", brokerUrl: "https://provision.contoso.com" }),
    run: async () => ({
      status: "succeeded",
      steps: [{ id: "fabric-discovery", status: "failed", message: "Capacity is paused." }],
      outputs: {}
    })
  };
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({
      fetch: async () => jsonResponse(500, {}),
      clientUrl: "https://contoso.crm4.dynamics.com"
    }),
    broker,
    mode: "broker",
    dryRun: false,
    brokerScope: "api://broker/x",
    getToken: async () => "t",
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    apiPackageUrl: STAMPED_PACKAGE,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "fabric-discovery");
  assert.match(result.results[result.results.length - 1].message, /Capacity is paused/);
});

test("the provisioning service is never asked to guess which package to deploy", async () => {
  let ran = false;
  const broker = {
    connect: async () => ({ sessionId: "s", sessionToken: "t", brokerUrl: "https://provision.contoso.com" }),
    run: async () => {
      ran = true;
      return { status: "succeeded", steps: [], outputs: {} };
    }
  };
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({
      fetch: async () => jsonResponse(500, {}),
      clientUrl: "https://contoso.crm4.dynamics.com"
    }),
    broker,
    mode: "broker",
    dryRun: false,
    brokerScope: "api://broker/x",
    getToken: async () => "t",
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    payload: { api: { version: "1.1.0.0", packageUrl: "" } },
    apiPackageUrl: "",
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(ran, false, "an unverified package must stop the run before the service is called");
  assert.match(result.results[result.results.length - 1].message, /No verified API package/i);
});

test("broker mode without a broker client fails loudly instead of silently skipping", async () => {
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({
      fetch: async () => jsonResponse(500, {}),
      clientUrl: "https://contoso.crm4.dynamics.com"
    }),
    mode: "broker",
    dryRun: false,
    brokerScope: "api://broker/x",
    getToken: async () => "t",
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "consent");
  assert.match(result.results[result.results.length - 1].message, /No provisioning service client/);
});

test("a failing step ends the run and reports the failure", async () => {
  const broker = {
    connect: async () => ({ sessionId: "s", sessionToken: "t", brokerUrl: "https://provision.contoso.com" }),
    run: async () => ({ status: "succeeded", steps: [], outputs: {} })
  };
  const fetchImpl = createFetchMock([
    ENV_QUERY_ROUTE([]),
    {
      repeat: true,
      match: () => true,
      respond: () => jsonResponse(403, { error: { message: "Insufficient privileges" } })
    }
  ]);
  const orchestrator = engine.createOrchestrator({
    dataverse: engine.createDataverseClient({ fetch: fetchImpl, clientUrl: "https://contoso.crm4.dynamics.com" }),
    broker,
    mode: "broker",
    dryRun: false,
    brokerScope: "api://broker/x",
    getToken: async () => "t",
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: webcrypto,
    apiPackageUrl: STAMPED_PACKAGE,
    timer: immediateTimer
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "dataverse-config");
  assert.match(result.results[result.results.length - 1].message, /does not exist in this environment/);
});


// ------------------------------------------------------------------- facade

test("loadSetupContext reports missing variables and the manual blockers", async () => {
  const fetchImpl = createFetchMock([
    ENV_QUERY_ROUTE([
      {
        schemaname: "klth_FabricBehavioralApiUrl",
        environmentvariabledefinitionid: "d1",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: []
      },
      {
        schemaname: "klth_SetupConfiguration",
        environmentvariabledefinitionid: "d2",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: [
          {
            environmentvariablevalueid: "v2",
            value: JSON.stringify({ target: { location: "northeurope" }, state: { secret: true } })
          }
        ]
      }
    ])
  ]);
  const dataverse = engine.createDataverseClient({ fetch: fetchImpl, clientUrl: "https://contoso.crm4.dynamics.com" });
  const context = await engine.loadSetupContext(dataverse, "https://contoso.crm4.dynamics.com");
  assert.equal(context.mode.mode, "manual");
  assert.equal(context.mode.blockers.length, 2);
  assert.ok(context.missingVariables.includes("klth_SetupEntraClientId"));
  assert.equal(context.target.location, "northeurope");
  assert.equal(context.state.secret, true);
  assert.equal(context.plan.find((step) => step.id === "secret").status, "completed");
  assert.equal(context.environmentDomain, "contoso.crm4.dynamics.com");
  assert.equal(context.consent.length, engine.describeConsent().length);
});

test("saveSetupContext writes the configuration variable without secrets", async () => {
  let written = null;
  const fetchImpl = createFetchMock([
    ENV_QUERY_ROUTE([
      {
        schemaname: "klth_SetupConfiguration",
        environmentvariabledefinitionid: "d1",
        defaultvalue: null,
        environmentvariabledefinition_environmentvariablevalue: [{ environmentvariablevalueid: "v1", value: "{}" }]
      }
    ]),
    {
      match: (request) => request.method === "PATCH",
      respond: (request) => {
        written = JSON.parse(request.init.body).value;
        return jsonResponse(204);
      }
    }
  ]);
  const dataverse = engine.createDataverseClient({ fetch: fetchImpl, clientUrl: "https://contoso.crm4.dynamics.com" });
  await engine.saveSetupContext(dataverse, VALID_TARGET, { secret: true, apiKey: "leak" });
  assert.ok(written);
  assert.equal(written.includes("leak"), false);
  assert.equal(JSON.parse(written).target.webAppName, "segment-preview-api");
});


// ------------------------------------------------- solution payload / direct

const payload = require(path.join(repoRoot, "webresources", "segment-preview-payload.js"));
/**
 * Direct client double. Records every call the orchestrator makes so the tests
 * can assert the exact Fabric and Azure Resource Manager request shapes.
 */
function directHarness(options = {}) {
  const calls = [];
  const notebooks = options.notebooks || [];
  const schedules = options.schedules || [];
  const appSettings = Object.assign({}, options.appSettings || {});
  const blobs = {};
  const bytes = options.packageBytes || Buffer.from("segment-preview-api-package");
  return {
    calls,
    appSettings,
    blobs,
    packageBytes: bytes,
    async fabricCollection(path) {
      calls.push({ kind: "fabricCollection", path });
      if (path === "workspaces") {
        return [{ id: VALID_TARGET.fabricWorkspaceId, displayName: "Segment Preview" }];
      }
      if (/\/lakehouses$/.test(path)) {
        return [{ id: VALID_TARGET.fabricServingLakehouseId, displayName: "SegmentPreviewServing" }];
      }
      if (/\/notebooks$/.test(path)) return notebooks;
      if (/\/schedules$/.test(path)) {
        if (options.scheduleListFails) throw new Error("schedules unavailable");
        return schedules;
      }
      return [];
    },
    async fabric(method, path, body) {
      calls.push({ kind: "fabric", method, path, body });
      if (
        options.notebookScopeFails &&
        method === "POST" &&
        (/\/notebooks$/.test(path) || /\/items\/[^/]+\/updateDefinition/.test(path))
      ) {
        throw new Error("The caller does not have sufficient scopes to perform this operation");
      }
      if (options.scheduleScopeFails && method === "POST" && /\/schedules$/.test(path)) {
        throw new Error("The caller does not have sufficient scopes to perform this operation");
      }
      if (method === "GET" && /\/lakehouses\/[^/]+$/.test(path)) {
        return {
          body: {
            properties: {
              sqlEndpointProperties: {
                id: "sqldb",
                connectionString: "contoso.datawarehouse.fabric.microsoft.com"
              }
            }
          }
        };
      }
      if (method === "POST" && /\/notebooks$/.test(path)) {
        if (options.notebookAccepted) {
          return {
            status: 202,
            body: null,
            headers: { get: (name) => (String(name).toLowerCase() === "x-ms-operation-id" ? "op-1" : null) }
          };
        }
        return { status: 201, body: { id: "cccccccc-dddd-eeee-ffff-000000000000" } };
      }
      if (method === "GET" && /^operations\/op-1\/result$/.test(path)) {
        return { status: 200, body: { id: "cccccccc-dddd-eeee-ffff-000000000000" } };
      }
      if (method === "GET" && /^operations\/op-1$/.test(path)) {
        return { status: 200, body: { status: "Succeeded" } };
      }
      return { status: 200, body: {} };
    },
    async fabricResult(response) {
      calls.push({ kind: "fabricResult", status: response && response.status });
      if (!response || response.status !== 202) return response && response.body;
      const snapshot = await this.fabric("GET", "operations/op-1");
      if (snapshot.body.status !== "Succeeded") throw new Error("operation failed");
      const result = await this.fabric("GET", "operations/op-1/result");
      return result.body;
    },
    async arm(method, path, body, apiVersion) {
      calls.push({ kind: "arm", method, path, body, apiVersion });
      return { body: {} };
    },
    async ensureResourceGroup(subscriptionId, resourceGroup) {
      calls.push({ kind: "ensureResourceGroup", subscriptionId, resourceGroup });
      return { location: options.resourceGroupLocation || "westeurope" };
    },
    async listDataverseConnections(environmentUrl) {
      calls.push({ kind: "listDataverseConnections", environmentUrl });
      return options.dataverseConnections || [
        {
          id: VALID_TARGET.fabricDataverseConnectionId,
          name: "Dataverse",
          connectivityType: "ShareableCloud",
          shareable: true,
          credentialType: "OAuth2"
        }
      ];
    },
    async ensureConnectionRoleAssignment(connectionId, principalId) {
      calls.push({ kind: "ensureConnectionRoleAssignment", connectionId, principalId });
      if (options.connectionRoleFails) {
        const failure = new Error(
          options.connectionRoleFailureMessage || "Forbidden"
        );
        failure.status = options.connectionRoleFailureStatus || 403;
        throw failure;
      }
      return { created: !options.connectionRoleExists };
    },
    async ensureWorkspaceRoleAssignment(workspaceId, principalId) {
      calls.push({ kind: "ensureWorkspaceRoleAssignment", workspaceId, principalId });
      return { created: !options.workspaceRoleExists };
    },
    async deployTemplate(subscriptionId, resourceGroup, name, template, parameters) {
      calls.push({ kind: "deployTemplate", subscriptionId, resourceGroup, name, parameters });
      if (
        options.quotaFailureLocation &&
        parameters.location === options.quotaFailureLocation
      ) {
        const failure = new Error("The subscription is over quota for this SKU.");
        failure.body = {
          error: {
            details: [
              {
                code: "InternalSubscriptionIsOverQuotaForSku",
                message: "Current Limit (Total VMs): 0"
              }
            ]
          }
        };
        throw failure;
      }
      const outputs = {
        webAppUrl: { value: "https://segment-preview-api.azurewebsites.net/api/" },
        managedIdentityPrincipalId: { value: "99999999-8888-7777-6666-555555555555" }
      };
      const url = parameters && parameters.apiPackageUrl;
      const sha = parameters && parameters.apiPackageSha256;
      if (url && sha && !options.packageCopyFails) {
        const account = options.storageAccount || "spsegmentpreviewapi01";
        const blob = (parameters && parameters.apiPackageBlobName) || `api-${sha.slice(0, 16)}.zip`;
        // Mirrors what the template does inside Azure: the package is copied into
        // the customer's own account and the Web App reads it with its identity.
        const blobUrl = `https://${account}.blob.core.windows.net/segment-preview-api/${blob}`;
        blobs[blobUrl] = bytes;
        if (!options.leaveAppSettingsAlone) {
          appSettings.WEBSITE_RUN_FROM_PACKAGE = blobUrl;
          appSettings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID = "SystemAssigned";
          appSettings.SEGMENT_PREVIEW_PACKAGE_SHA256 = sha;
          appSettings.SEGMENT_PREVIEW_PACKAGE_VERSION = parameters.apiPackageVersion || "";
        }
        outputs.packageBlobUrl = { value: blobUrl };
        outputs.packageStorageAccount = { value: account };
        outputs.packageBlob = { value: blob };
      }
      return outputs;
    },
    async webAppSettings(subscriptionId, resourceGroup, webAppName) {
      calls.push({ kind: "webAppSettings", subscriptionId, resourceGroup, webAppName });
      if (options.webAppSettingsFails) throw new Error("forbidden");
      return Object.assign({}, appSettings);
    },
    async setWebAppSettings(subscriptionId, resourceGroup, webAppName, properties) {
      calls.push({ kind: "setWebAppSettings", subscriptionId, resourceGroup, webAppName, properties });
      Object.keys(properties).forEach((key) => {
        appSettings[key] = properties[key];
      });
      return properties;
    },
    async restartWebApp(subscriptionId, resourceGroup, webAppName) {
      calls.push({ kind: "restartWebApp", subscriptionId, resourceGroup, webAppName });
      return true;
    },
    async apiHealth(baseUrl, config) {
      calls.push({ kind: "apiHealth", baseUrl, config });
      if (options.healthNeverAnswers) {
        return { ok: false, attempts: (config && config.attempts) || 60, error: "Failed to fetch", url: baseUrl };
      }
      return { ok: true, attempts: options.healthAttempts || 1, status: 200, body: { status: "ok" } };
    }
  };
}
/** Two arbitrary well-formed digests used where the value itself is irrelevant.
 */
const SHIPPED_SHA = "1".repeat(64);
const OVERRIDE_SHA = "2".repeat(64);
/**
 * A stamped release is the normal state of an installable build, so every run
 * harness starts from one. Tests that care about the unstamped build clear it.
 */
const STAMPED_PACKAGE = "https://contoso.example.com/segment-preview-api-1.1.0.0.zip " + SHIPPED_SHA;
/** SHA-256 hex of a buffer, computed the same way the browser does.
 */
async function sha256Of(bytes) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}
/** Dataverse double for the dataverse-config and verify steps.
 */
function dataverseHarness(options = {}) {
  const written = {};
  const actions = [];
  // Each entry is the status the next executeSetupAction call returns; the last
  // one is reused once the list is exhausted.
  const responses = options.responses || [{ overallState: "ready", components: [] }];
  return {
    written,
    actions,
    async getEnvironmentVariables() {
      return {};
    },
    async setEnvironmentVariable(name, value) {
      written[name] = value;
      return true;
    },
    async executeSetupAction(action) {
      actions.push(action);
      if (options.failOn && options.failOn === action) {
        throw new Error("The Segment Preview Azure API is not reachable.");
      }
      const index = Math.min(actions.length - 1, responses.length - 1);
      return responses[index];
    }
  };
}
function directOrchestrator(overrides = {}) {
  const direct = overrides.direct || directHarness();
  const dataverse = overrides.dataverse || dataverseHarness();
  const orchestrator = engine.createOrchestrator(
    Object.assign(
      {
        dataverse,
        mode: "direct",
        dryRun: false,
        target: engine.mergeConfiguration(
          Object.assign({}, VALID_TARGET, {
            fabricDataverseLakehouseId: "12341234-5678-5678-9abc-9abcdef01234"
          })
        ),
        environmentUrl: "https://contoso.crm4.dynamics.com",
        crypto: webcrypto,
        template: embeddedTemplate,
        payload,
        apiPackageUrl: STAMPED_PACKAGE,
        timer: immediateTimer,
        origin: "https://contoso.crm4.dynamics.com",
        now: () => Date.parse("2024-05-01T00:00:00Z"),
        getToken: async () => "token",
        direct
      },
      overrides.settings || {}
    )
  );
  return { orchestrator, direct, dataverse };
}
test("the shipped payload carries the bootstrap notebook and its parameters", () => {
  assert.equal(payload.notebook.format, "ipynb");
  assert.ok(payload.notebook.displayName);
  assert.deepEqual(payload.notebook.parameters, [
    "WORKSPACE_ID",
    "SERVING_LAKEHOUSE_ID",
    "DATAVERSE_LAKEHOUSE_ID"
  ]);
  assert.ok(Array.isArray(payload.notebook.content.cells));
  assert.ok(payload.notebook.content.cells.some((cell) => cell.cell_type === "code"));
  assert.ok(payload.notebook.schedule.configuration.times.length);
});

test("notebook parameters are substituted and unknown constants are reported", () => {
  const result = engine.applyNotebookParameters(payload.notebook.content, {
    WORKSPACE_ID: "aaaa",
    NOT_IN_NOTEBOOK: "bbbb"
  });
  assert.deepEqual(result.applied, ["WORKSPACE_ID"]);
  assert.deepEqual(result.missing, ["NOT_IN_NOTEBOOK"]);
  const source = result.content.cells
    .filter((cell) => cell.cell_type === "code")
    .flatMap((cell) => cell.source)
    .join("");
  assert.ok(source.includes('WORKSPACE_ID = "aaaa"'));
  assert.equal(payload.notebook.content.cells[1].source.join("").includes('"aaaa"'), false);
});

test("a notebook parameter value can never break out of the Python literal", () => {
  assert.throws(
    () => engine.applyNotebookParameters(payload.notebook.content, { WORKSPACE_ID: 'a"; import os' }),
    /unsupported characters/
  );
});

test("buildNotebookDefinition emits an InlineBase64 part with every constant applied", () => {
  const definition = engine.buildNotebookDefinition(payload.notebook, {
    WORKSPACE_ID: "11111111-2222-3333-4444-555555555555",
    SERVING_LAKEHOUSE_ID: "66666666-7777-8888-9999-aaaaaaaaaaaa",
    DATAVERSE_LAKEHOUSE_ID: "12341234-5678-5678-9abc-9abcdef01234"
  });
  assert.equal(definition.format, "ipynb");
  assert.equal(definition.parts.length, 2);
  const notebookPart = definition.parts.find((part) => part.path === "notebook-content.ipynb");
  const platformPart = definition.parts.find((part) => part.path === ".platform");
  assert.equal(notebookPart.payloadType, "InlineBase64");
  assert.equal(platformPart.payloadType, "InlineBase64");
  assert.deepEqual(
    JSON.parse(Buffer.from(platformPart.payload, "base64").toString("utf8")),
    payload.notebook.platform
  );
  const decoded = JSON.parse(Buffer.from(notebookPart.payload, "base64").toString("utf8"));
  const source = decoded.cells
    .filter((cell) => cell.cell_type === "code")
    .flatMap((cell) => cell.source)
    .join("");
  assert.ok(source.includes('WORKSPACE_ID = "11111111-2222-3333-4444-555555555555"'));
  assert.ok(source.includes('SERVING_LAKEHOUSE_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"'));
  assert.ok(source.includes('DATAVERSE_LAKEHOUSE_ID = "12341234-5678-5678-9abc-9abcdef01234"'));
});

test("buildNotebookDefinition refuses to publish a notebook with missing ids", () => {
  assert.throws(
    () => engine.buildNotebookDefinition(payload.notebook, { WORKSPACE_ID: "abc" }),
    /SERVING_LAKEHOUSE_ID/
  );
});

test("the direct run publishes the notebook through the Fabric definition API", async () => {
  const { orchestrator, direct } = directOrchestrator();
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const create = direct.calls.find((call) => call.kind === "fabric" && /\/notebooks$/.test(call.path));
  assert.ok(create, "the notebook must be created through the Fabric API");
  assert.equal(create.method, "POST");
  assert.equal(create.path, `workspaces/${VALID_TARGET.fabricWorkspaceId}/notebooks`);
  assert.equal(create.body.displayName, payload.notebook.displayName);
  const notebookPart = create.body.definition.parts.find(
    (part) => part.path === "notebook-content.ipynb"
  );
  assert.equal(notebookPart.payloadType, "InlineBase64");
  assert.ok(
    create.body.definition.parts.some((part) => part.path === ".platform"),
    "the Fabric .platform metadata must be included"
  );
  const decoded = JSON.parse(
    Buffer.from(notebookPart.payload, "base64").toString("utf8")
  );
  const source = decoded.cells
    .filter((cell) => cell.cell_type === "code")
    .flatMap((cell) => cell.source)
    .join("");
  assert.ok(source.includes(`WORKSPACE_ID = "${VALID_TARGET.fabricWorkspaceId}"`));
  assert.ok(source.includes(`SERVING_LAKEHOUSE_ID = "${VALID_TARGET.fabricServingLakehouseId}"`));
  assert.ok(source.includes('DATAVERSE_LAKEHOUSE_ID = "12341234-5678-5678-9abc-9abcdef01234"'));
  const schedule = direct.calls.find(
    (call) => call.kind === "fabric" && /\/jobs\/Execute\/schedules$/.test(call.path)
  );
  assert.ok(schedule, "the notebook must be scheduled");
  assert.equal(schedule.body.enabled, true);
  assert.deepEqual(schedule.body.configuration, payload.notebook.schedule.configuration);
  const step = result.results.find((entry) => entry.id === "fabric-notebook");
  assert.equal(step.status, "succeeded");
  assert.match(step.message, /published and scheduled/);
});

test("an existing notebook is updated in place instead of duplicated", async () => {
  const direct = directHarness({
    notebooks: [{ id: "eeee0000-1111-2222-3333-444444444444", displayName: payload.notebook.displayName }],
    schedules: [
      {
        id: "sched-1",
        enabled: payload.notebook.schedule.enabled,
        configuration: payload.notebook.schedule.configuration
      }
    ]
  });

  const { orchestrator } = directOrchestrator({ direct });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const update = direct.calls.find((call) => call.kind === "fabric" && /updateDefinition/.test(call.path));
  assert.ok(update, "the existing notebook must be updated");
  assert.equal(
    update.path,
    `workspaces/${VALID_TARGET.fabricWorkspaceId}/items/eeee0000-1111-2222-3333-444444444444/updateDefinition?updateMetadata=true`
  );
  assert.ok(
    update.body.definition.parts.some((part) => part.path === ".platform"),
    "updateMetadata=true requires a .platform definition part"
  );
  assert.equal(
    direct.calls.some((call) => call.kind === "fabric" && call.method === "POST" && /\/notebooks$/.test(call.path)),
    false,
    "no second notebook may be created"
  );
  assert.equal(
    direct.calls.some((call) => call.kind === "fabric" && /schedules$/.test(call.path)),
    false,
    "an existing schedule must be kept"
  );
});

test("an existing notebook schedule is updated instead of duplicated", async () => {
  const direct = directHarness({
    notebooks: [
      {
        id: "eeee0000-1111-2222-3333-444444444444",
        displayName: payload.notebook.displayName
      }
    ],
    schedules: [{ id: "sched-1", enabled: false, configuration: {} }]
  });
  const { orchestrator } = directOrchestrator({ direct });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const updates = direct.calls.filter(
    (call) =>
      call.kind === "fabric" &&
      call.method === "PATCH" &&
      /\/schedules\/sched-1$/.test(call.path)
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].body, {
    enabled: payload.notebook.schedule.enabled,
    configuration: payload.notebook.schedule.configuration
  });
  assert.equal(
    direct.calls.some(
      (call) =>
        call.kind === "fabric" &&
        call.method === "POST" &&
        /\/schedules$/.test(call.path)
    ),
    false
  );
});

test("a schedule lookup failure stops before creating a possible duplicate", async () => {
  const direct = directHarness({ scheduleListFails: true });
  const { orchestrator } = directOrchestrator({ direct });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "fabric-notebook");
  assert.equal(
    direct.calls.some(
      (call) =>
        call.kind === "fabric" &&
        call.method === "POST" &&
        /\/schedules$/.test(call.path)
    ),
    false
  );
});

test("missing notebook scopes produce actionable Entra and Fabric guidance", async () => {
  const direct = directHarness({
    notebooks: [{ id: "eeee0000-1111-2222-3333-444444444444", displayName: payload.notebook.displayName }],
    notebookScopeFails: true
  });
  const { orchestrator } = directOrchestrator({ direct });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  const step = result.results.find((entry) => entry.id === "fabric-notebook");
  assert.match(step.message, /Item\.ReadWrite\.All/);
  assert.match(step.message, /admin consent/i);
  assert.match(step.message, /Contributor role/i);
  assert.match(step.message, /close and reopen/i);
});

test("missing schedule scope names Item.Execute.All and requires fresh consent", async () => {
  const direct = directHarness({ scheduleScopeFails: true });
  const { orchestrator } = directOrchestrator({ direct });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  const step = result.results.find((entry) => entry.id === "fabric-notebook");
  assert.match(step.message, /Item\.Execute\.All/);
  assert.match(step.message, /grant admin consent/i);
  assert.match(step.message, /close and reopen/i);
});

test("the notebook step never tells the administrator to run a script", async () => {
  const { orchestrator } = directOrchestrator();
  const result = await orchestrator.run();
  const step = result.results.find((entry) => entry.id === "fabric-notebook");
  assert.doesNotMatch(step.message, /\.ps1|powershell|script|manual|install(er)?\b/i);
  result.manual.forEach((entry) => {
    assert.doesNotMatch(entry, /\.ps1|powershell|deploy-api|command line|installer/i);
  });
});

test("a missing Dataverse mirror lakehouse is reported but never blocks publication", async () => {
  const direct = directHarness();
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { target: engine.mergeConfiguration(VALID_TARGET) }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const create = direct.calls.find((call) => call.kind === "fabric" && /\/notebooks$/.test(call.path));
  const decoded = JSON.parse(
    Buffer.from(create.body.definition.parts[0].payload, "base64").toString("utf8")
  );
  const source = decoded.cells
    .filter((cell) => cell.cell_type === "code")
    .flatMap((cell) => cell.source)
    .join("");
  assert.ok(source.includes('DATAVERSE_LAKEHOUSE_ID = "00000000-0000-0000-0000-000000000000"'));
  assert.ok(result.manual.some((entry) => /Link to Microsoft Fabric/.test(entry)));
});

test("resolveApiPackage prefers the environment override over the shipped value", () => {
  const shipped = engine.resolveApiPackage(
    { api: { version: "1.1.0.0", packageUrl: "https://example.com/a.zip", sha256: SHIPPED_SHA } },
    null
  );
  assert.equal(shipped.configured, true);
  assert.equal(shipped.url, "https://example.com/a.zip");
  assert.equal(shipped.source, "payload");
  const override = engine.resolveApiPackage(
    { api: { version: "1.1.0.0", packageUrl: "https://example.com/a.zip", sha256: SHIPPED_SHA } },
    "https://contoso.blob.core.windows.net/b.zip " + OVERRIDE_SHA
  );
  assert.equal(override.url, "https://contoso.blob.core.windows.net/b.zip");
  assert.equal(override.sha256, OVERRIDE_SHA);
  assert.equal(override.source, engine.ENV.apiPackageUrl);
});

test("a package URL without a SHA-256 digest is refused rather than trusted", () => {
  const result = engine.resolveApiPackage(
    { api: { version: "1.1.0.0", packageUrl: "https://example.com/a.zip" } },
    null
  );
  assert.equal(result.configured, false);
  assert.match(result.hint, /SHA-256/);
  assert.equal(result.url, null);
  const override = engine.resolveApiPackage(
    { api: { version: "1.1.0.0", packageUrl: "https://example.com/a.zip", sha256: SHIPPED_SHA } },
    "https://contoso.blob.core.windows.net/b.zip"
  );
  assert.equal(override.configured, false);
  assert.match(override.hint, /SHA-256/);
});

test("parseApiPackageSetting splits the URL from its digest in any order", () => {
  assert.deepEqual(engine.parseApiPackageSetting("https://a.example.com/x.zip " + SHIPPED_SHA), {
    url: "https://a.example.com/x.zip",
    sha256: SHIPPED_SHA
  });
  assert.deepEqual(engine.parseApiPackageSetting(SHIPPED_SHA + "  https://a.example.com/x.zip"), {
    url: "https://a.example.com/x.zip",
    sha256: SHIPPED_SHA
  });
  assert.deepEqual(engine.parseApiPackageSetting("   "), { url: null, sha256: null });
});

test("the direct run has Azure copy the verified package into the customer's own storage", async () => {
  const direct = directHarness();
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: {
      apiPackageUrl: "https://contoso.example.com/segment-preview-api-1.1.0.0.zip " + digest
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  // A GitHub release asset sends no Access-Control-Allow-Origin, so the browser
  // must never try to download it; the deployment does the copy inside Azure.
  const deploy = direct.calls.find((call) => call.kind === "deployTemplate");
  assert.equal(deploy.parameters.apiPackageUrl, "https://contoso.example.com/segment-preview-api-1.1.0.0.zip");
  assert.equal(deploy.parameters.apiPackageSha256, digest);
  assert.equal(deploy.parameters.apiPackageVersion, payload.api.version);
  assert.equal(
    deploy.parameters.apiPackageBlobName,
    engine.packageBlobName({ version: payload.api.version, sha256: digest })
  );
  const settings = direct.appSettings;
  assert.ok(settings.WEBSITE_RUN_FROM_PACKAGE.startsWith("https://"));
  assert.equal(settings.WEBSITE_RUN_FROM_PACKAGE.includes("?"), false, "no expiring signature");
  assert.equal(
    settings.WEBSITE_RUN_FROM_PACKAGE.includes("contoso.example.com"),
    false,
    "the Web App must never keep an ongoing dependency on the publisher URL"
  );
  assert.equal(settings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID, "SystemAssigned");
  assert.equal(settings.SEGMENT_PREVIEW_PACKAGE_SHA256, digest);
  const restart = direct.calls.find((call) => call.kind === "restartWebApp");
  assert.ok(restart, "the Web App must be restarted so it picks the package up");
  const step = result.results.find((entry) => entry.id === "azure-app");
  assert.equal(step.status, "succeeded");
  assert.doesNotMatch(step.message, /\.ps1|powershell|script|manual/i);
  assert.equal(result.facts.packageBlobUrl, settings.WEBSITE_RUN_FROM_PACKAGE);
});

test("an existing Resource Group location does not override the resource deployment region", async () => {
  const direct = directHarness({ resourceGroupLocation: "eastus" });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const deploy = direct.calls.find((call) => call.kind === "deployTemplate");
  assert.equal(deploy.parameters.location, "westeurope");
});

test("App Service quota failure retries the Azure deployment in West Europe", async () => {
  const direct = directHarness({ quotaFailureLocation: "eastus" });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: {
      target: Object.assign({}, VALID_TARGET, {
        fabricDataverseLakehouseId: "12341234-5678-5678-9abc-9abcdef01234",
        location: "eastus"
      }),
      apiPackageUrl: "https://contoso.example.com/a.zip " + digest
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const deployments = direct.calls.filter((call) => call.kind === "deployTemplate");
  assert.deepEqual(
    deployments.map((call) => call.parameters.location),
    ["eastus", "westeurope"]
  );
  const step = result.results.find((entry) => entry.id === "azure-infra");
  assert.match(step.message, /West Europe.*no B1 App Service quota/i);
});

test("the managed identity receives automatic access to the Dataverse connection", async () => {
  const direct = directHarness();
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const assignment = direct.calls.find(
    (call) => call.kind === "ensureConnectionRoleAssignment"
  );
  assert.equal(assignment.connectionId, VALID_TARGET.fabricDataverseConnectionId);
  assert.equal(
    assignment.principalId,
    "99999999-8888-7777-6666-555555555555"
  );
  const step = result.results.find(
    (entry) => entry.id === "fabric-connection-permissions"
  );
  assert.match(step.message, /User access.*assigned/i);
});

test("a repeated run accepts the managed identity's existing workspace role", async () => {
  const direct = directHarness({ workspaceRoleExists: true });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const step = result.results.find((entry) => entry.id === "fabric-permissions");
  assert.match(step.message, /already has a sufficient workspace role/i);
});

test("stale Fabric ids fall back to existing resources with matching names", async () => {
  const direct = directHarness();
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: {
      target: Object.assign({}, VALID_TARGET, {
        fabricWorkspaceId: "11111111-2222-3333-4444-555555555555",
        fabricServingLakehouseId: "66666666-7777-8888-9999-000000000000",
        fabricDataverseLakehouseId: "12341234-5678-5678-9abc-9abcdef01234"
      }),
      apiPackageUrl: "https://contoso.example.com/a.zip " + digest
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(
    direct.calls.some(
      (call) =>
        call.kind === "fabric" &&
        call.method === "POST" &&
        (call.path === "workspaces" || /\/lakehouses$/.test(call.path))
    ),
    false,
    "matching workspace and lakehouse names must be reused"
  );
});

test("missing connection scope names Connection.ReadWrite.All and reshare access", async () => {
  const direct = directHarness({ connectionRoleFails: true });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "fabric-connection-permissions");
  const step = result.results.find(
    (entry) => entry.id === "fabric-connection-permissions"
  );
  assert.match(step.message, /Connection\.ReadWrite\.All/);
  assert.match(step.message, /Owner or UserWithReshare/);
  assert.match(step.message, /admin consent/i);
});

test("a generic Fabric connection failure explains that workspace admin is insufficient", async () => {
  const direct = directHarness({
    connectionRoleFails: true,
    connectionRoleFailureStatus: 400,
    connectionRoleFailureMessage: "An error occurred while processing the operation"
  });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });

  const result = await orchestrator.run();

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "fabric-connection-permissions");
  const step = result.results.find(
    (entry) => entry.id === "fabric-connection-permissions"
  );
  assert.match(step.message, /Workspace Admin.*not sufficient/);
  assert.match(step.message, /Manage connections and gateways/);
  assert.match(step.message, /Owner or UserWithReshare/);
});

test("automatic discovery skips a PersonalCloud Dataverse connection", async () => {
  const direct = directHarness({
    dataverseConnections: [
      {
        id: "11111111-aaaa-bbbb-cccc-111111111111",
        name: "Personal Dataverse",
        connectivityType: "PersonalCloud",
        shareable: false,
        credentialType: "OAuth2"
      },
      {
        id: "22222222-aaaa-bbbb-cccc-222222222222",
        name: "Shared Dataverse",
        connectivityType: "ShareableCloud",
        shareable: true,
        credentialType: "OAuth2"
      }
    ]
  });
  const target = engine.mergeConfiguration(
    Object.assign({}, VALID_TARGET, {
      fabricDataverseConnectionId: "",
      fabricDataverseLakehouseId: "12341234-5678-5678-9abc-9abcdef01234"
    })
  );
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { target }
  });

  const result = await orchestrator.run();

  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const assignment = direct.calls.find(
    (call) => call.kind === "ensureConnectionRoleAssignment"
  );
  assert.equal(
    assignment.connectionId,
    "22222222-aaaa-bbbb-cccc-222222222222"
  );
});

test("automatic discovery explains when only PersonalCloud connections exist", async () => {
  const direct = directHarness({
    dataverseConnections: [
      {
        id: "11111111-aaaa-bbbb-cccc-111111111111",
        name: "Personal Dataverse",
        connectivityType: "PersonalCloud",
        shareable: false,
        credentialType: "OAuth2"
      }
    ]
  });
  const target = engine.mergeConfiguration(
    Object.assign({}, VALID_TARGET, {
      fabricDataverseConnectionId: "",
      fabricDataverseLakehouseId: "12341234-5678-5678-9abc-9abcdef01234"
    })
  );
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { target }
  });

  const result = await orchestrator.run();

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "fabric-discovery");
  const message = result.results.find(
    (entry) => entry.id === "fabric-discovery"
  ).message;
  assert.match(message, /PersonalCloud.*shared with a managed identity/is);
  assert.match(message, /shareable cloud connection/i);
});

test("the browser never downloads the package itself", async () => {
  const direct = directHarness();
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  await orchestrator.run();
  assert.equal(direct.calls.some((call) => call.kind === "fetchBytes"), false);
  assert.equal(direct.calls.some((call) => call.kind === "putBlob"), false);
  assert.equal(typeof direct.fetchBytes, "undefined");
});

test("a deployment that did not apply the package fails the run instead of reporting success", async () => {
  const direct = directHarness({ packageCopyFails: true });
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + OVERRIDE_SHA }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "azure-app");
  const step = result.results.find((entry) => entry.id === "azure-app");
  assert.match(step.message, /WEBSITE_RUN_FROM_PACKAGE/);
  assert.match(step.message, /package-copy/);
});

test("a package still served through a shared access signature is rejected", async () => {
  const direct = directHarness({ leaveAppSettingsAlone: true });
  const digest = await sha256Of(direct.packageBytes);
  const blob = engine.packageBlobName({ version: payload.api.version, sha256: digest });
  direct.appSettings.WEBSITE_RUN_FROM_PACKAGE =
    `https://spsegmentpreviewapi01.blob.core.windows.net/segment-preview-api/${blob}?sv=read`;
  direct.appSettings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID = "SystemAssigned";
  direct.appSettings.SEGMENT_PREVIEW_PACKAGE_SHA256 = digest;
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.match(result.results.find((entry) => entry.id === "azure-app").message, /shared access signature/i);
});

test("a Web App that does not read the package with its own identity is rejected", async () => {
  const direct = directHarness({ leaveAppSettingsAlone: true });
  const digest = await sha256Of(direct.packageBytes);
  const blob = engine.packageBlobName({ version: payload.api.version, sha256: digest });
  direct.appSettings.WEBSITE_RUN_FROM_PACKAGE =
    `https://spsegmentpreviewapi01.blob.core.windows.net/segment-preview-api/${blob}`;
  direct.appSettings.SEGMENT_PREVIEW_PACKAGE_SHA256 = digest;
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.match(
    result.results.find((entry) => entry.id === "azure-app").message,
    /WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID/
  );
});

test("unrelated app settings are never rewritten by the package step", async () => {
  const direct = directHarness({ appSettings: { ExistingSetting: "keep-me" } });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(direct.appSettings.ExistingSetting, "keep-me");
  assert.equal(direct.calls.some((call) => call.kind === "setWebAppSettings"), false);
});

test("an unstamped build refuses to touch Azure instead of stripping a working API", async () => {
  const direct = directHarness();
  const { orchestrator } = directOrchestrator({
    direct,
    settings: {
      payload: { api: { version: "1.1.0.0", packageUrl: "" }, notebook: payload.notebook },
      apiPackageUrl: ""
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "azure-infra");
  // Nothing at all may reach Azure: a template deployment without a package
  // rewrites the app settings and would unmount a package already in service.
  assert.equal(direct.calls.some((call) => call.kind === "ensureResourceGroup"), false);
  assert.equal(direct.calls.some((call) => call.kind === "deployTemplate"), false);
  assert.equal(direct.calls.some((call) => call.kind === "setWebAppSettings"), false);
  assert.equal(direct.calls.some((call) => call.kind === "restartWebApp"), false);
  const step = result.results.find((entry) => entry.id === "azure-infra");
  assert.match(step.message, /No verified API package/i);
  result.manual.forEach((entry) => {
    assert.doesNotMatch(entry, /\.ps1|powershell|deploy-api|installer|desktop/i);
  });
  assert.ok(result.manual.some((entry) => entry.includes(engine.ENV.apiPackageUrl)));
});

test("the API is only reported as installed once it actually answers", async () => {
  const direct = directHarness();
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const kinds = direct.calls.map((call) => call.kind);
  const restart = kinds.lastIndexOf("restartWebApp");
  const health = kinds.lastIndexOf("apiHealth");
  assert.ok(restart >= 0 && health > restart, "the health check has to follow the restart");
  assert.match(direct.calls[health].baseUrl, /\/api\/$/);
});

test("a Web App that never answers fails the run instead of claiming the API is live", async () => {
  const direct = directHarness({ healthNeverAnswers: true });
  const digest = await sha256Of(direct.packageBytes);
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { apiPackageUrl: "https://contoso.example.com/a.zip " + digest }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "azure-app");
  const step = result.results.find((entry) => entry.id === "azure-app");
  assert.match(step.message, /did not answer|health/i);
  assert.doesNotMatch(step.message, /\.ps1|powershell|installer|desktop/i);
});

test("saveApiPackageUrl demands an https address and a SHA-256 digest", async () => {
  const stored = {};
  const dataverse = {
    async setEnvironmentVariable(name, value) {
      stored[name] = value;
      return true;
    }
  };
  await assert.rejects(() => engine.saveApiPackageUrl(dataverse, "ftp://example.com/a.zip", SHIPPED_SHA), /https/);
  await assert.rejects(() => engine.saveApiPackageUrl(dataverse, "https://example.com/a.zip", "abc"), /SHA-256/);
  await engine.saveApiPackageUrl(dataverse, "https://example.com/a.zip", SHIPPED_SHA.toUpperCase());
  assert.equal(stored[engine.ENV.apiPackageUrl], "https://example.com/a.zip " + SHIPPED_SHA);
});


// --------------------------------------------------------- resume behaviour

test("an unconfigured API package is explained without pointing at any local tooling", () => {
  const result = engine.resolveApiPackage({ api: { version: "1.1.0.0", packageUrl: "" } }, null);
  assert.equal(result.configured, false);
  assert.ok(result.hint);
  assert.doesNotMatch(result.hint, /\.ps1|powershell|command line|installer|desktop|terminal/i);
  assert.ok(result.hint.includes(engine.ENV.apiPackageUrl));
});

test("a package URL that is not https is rejected", () => {
  const result = engine.resolveApiPackage({ api: {} }, "http://insecure.example.com/a.zip " + SHIPPED_SHA);
  assert.equal(result.configured, false);
  assert.match(result.hint, /https/);
});

test("collectFacts keeps every durable fact and drops anything secret", () => {
  const facts = engine.collectFacts(
    {
      workspace: { id: "ws-1", displayName: "Segment Preview" },
      serving: { id: "lh-1", displayName: "Serving" },
      fabricSqlServer: "contoso.datawarehouse.fabric.microsoft.com",
      fabricSqlDatabase: "Serving",
      notebookId: "nb-1",
      apiBaseUrl: "https://a.azurewebsites.net/api/",
      principalId: "pid-1",
      packageBlobUrl: "https://sp.blob.core.windows.net/c/a.zip",
      apiKey: "must-not-appear",
      apiPackage: { version: "1.1.0.0", sha256: SHIPPED_SHA, url: "https://x.example.com/a.zip" }
    },
    { workspaceName: "kept-from-earlier-run" }
  );
  assert.equal(facts.workspaceId, "ws-1");
  assert.equal(facts.servingLakehouseId, "lh-1");
  assert.equal(facts.notebookId, "nb-1");
  assert.equal(facts.principalId, "pid-1");
  assert.equal(facts.packageSha256, SHIPPED_SHA);
  assert.equal(facts.workspaceName, "Segment Preview");
  assert.equal(Object.values(facts).includes("must-not-appear"), false);
  assert.equal("apiKey" in facts, false);
});

test("serializeConfiguration persists the facts but never the key", () => {
  const json = engine.serializeConfiguration(
    Object.assign({}, VALID_TARGET, { behavioralApiKey: "nope" }),
    { secret: true, "azure-infra": true, apiKey: "nope" },
    { workspaceId: "ws-1", apiKey: "nope", accountKey: "nope", apiBaseUrl: "https://a/api/" }
  );
  const parsed = JSON.parse(json);
  assert.equal(parsed.facts.workspaceId, "ws-1");
  assert.equal(parsed.facts.apiBaseUrl, "https://a/api/");
  assert.equal("apiKey" in parsed.facts, false);
  assert.equal("accountKey" in parsed.facts, false);
  assert.equal("apiKey" in parsed.state, false);
  assert.equal("behavioralApiKey" in parsed.target, false);
  assert.deepEqual(engine.parseConfiguration(json).facts, parsed.facts);
});

test("a secret that is not yet durable is never recorded as completed", () => {
  const completed = engine.completedFromResults(
    {},
    [
      { id: "preflight", status: "succeeded" },
      { id: "secret", status: "succeeded" },
      { id: "fabric-discovery", status: "succeeded" },
      { id: "fabric-notebook", status: "failed" }
    ]
  );
  assert.equal(completed["fabric-discovery"], true);
  assert.equal("secret" in completed, false, "the key is only durable once azure-infra stored it");
  assert.equal("azure-infra" in completed, false);
  assert.equal("dataverse-config" in completed, false);
});

test("a secret is recorded once the Azure deployment stored it", () => {
  const completed = engine.completedFromResults(
    {},
    [
      { id: "secret", status: "succeeded" },
      { id: "azure-infra", status: "succeeded" },
      { id: "azure-app", status: "failed" }
    ]
  );
  assert.equal(completed.secret, true);
  assert.equal(completed["azure-infra"], true);
  assert.equal("azure-app" in completed, false);
});

test("a resumed run recovers the earlier key from the Web App and writes it again", async () => {
  const direct = directHarness({ appSettings: { BEHAVIORAL_API_KEY: "earlier-run-key" } });
  const dataverse = dataverseHarness();
  const { orchestrator } = directOrchestrator({
    direct,
    dataverse,
    settings: {
      completed: {
        secret: true,
        "fabric-discovery": true,
        "azure-infra": true,
        "fabric-notebook": true,
        "azure-app": true
      },
      facts: {
        workspaceId: VALID_TARGET.fabricWorkspaceId,
        servingLakehouseId: VALID_TARGET.fabricServingLakehouseId,
        fabricSqlServer: "contoso.datawarehouse.fabric.microsoft.com",
        fabricSqlDatabase: "SegmentPreviewServing",
        apiBaseUrl: "https://segment-preview-api.azurewebsites.net/api/",
        principalId: "99999999-8888-7777-6666-555555555555",
        packageSha256: SHIPPED_SHA,
        packageVersion: payload.api.version
      }
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const secret = result.results.find((entry) => entry.id === "secret");
  assert.equal(secret.status, "succeeded");
  assert.match(secret.message, /recovered/i);
  assert.equal(
    dataverse.written[engine.ENV.apiKey],
    "earlier-run-key",
    "the recovered key must be written to Dataverse instead of a null"
  );
  assert.equal(dataverse.written[engine.ENV.apiUrl], "https://segment-preview-api.azurewebsites.net/api/");
  assert.equal(
    result.results.find((entry) => entry.id === "azure-infra").status,
    "resumed",
    "a recovered key must not force the infrastructure to redeploy"
  );
  const permissions = result.results.find((entry) => entry.id === "fabric-permissions");
  assert.equal(permissions.status, "succeeded");
  assert.match(permissions.message, /Contributor role assigned/);
  const role = direct.calls.find((call) => call.kind === "ensureWorkspaceRoleAssignment");
  assert.equal(role.principalId, "99999999-8888-7777-6666-555555555555");
  assert.equal(role.workspaceId, VALID_TARGET.fabricWorkspaceId);
});

test("a resumed pre-package run redeploys Azure so the current API package is installed", async () => {
  const direct = directHarness({ appSettings: { BEHAVIORAL_API_KEY: "earlier-run-key" } });
  const dataverse = dataverseHarness();
  const { orchestrator } = directOrchestrator({
    direct,
    dataverse,
    settings: {
      completed: {
        secret: true,
        "fabric-discovery": true,
        "fabric-notebook": true,
        "azure-infra": true
      },
      facts: {
        workspaceId: VALID_TARGET.fabricWorkspaceId,
        servingLakehouseId: VALID_TARGET.fabricServingLakehouseId,
        fabricSqlServer: "contoso.datawarehouse.fabric.microsoft.com",
        fabricSqlDatabase: "SegmentPreviewServing",
        apiBaseUrl: "https://segment-preview-api.azurewebsites.net/api/",
        principalId: "99999999-8888-7777-6666-555555555555"
      }
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(result.results.find((entry) => entry.id === "azure-infra").status, "succeeded");
  assert.equal(result.results.find((entry) => entry.id === "azure-app").status, "succeeded");
  assert.ok(direct.calls.some((call) => call.kind === "deployTemplate"));
  assert.equal(direct.appSettings.SEGMENT_PREVIEW_PACKAGE_SHA256, SHIPPED_SHA);
  assert.equal(
    direct.appSettings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID,
    "SystemAssigned"
  );
});

test("a resumed run that cannot recover the key redeploys every step that stores it", async () => {
  const direct = directHarness();
  const dataverse = dataverseHarness();
  const { orchestrator } = directOrchestrator({
    direct,
    dataverse,
    settings: {
      completed: {
        secret: true,
        "fabric-discovery": true,
        "fabric-notebook": true,
        "azure-infra": true,
        "azure-app": true,
        "dataverse-config": true
      },
      facts: {
        workspaceId: VALID_TARGET.fabricWorkspaceId,
        servingLakehouseId: VALID_TARGET.fabricServingLakehouseId,
        fabricSqlServer: "contoso.datawarehouse.fabric.microsoft.com",
        fabricSqlDatabase: "SegmentPreviewServing"
      }
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  const secret = result.results.find((entry) => entry.id === "secret");
  assert.match(secret.message, /new one was generated/i);
  assert.equal(result.results.find((entry) => entry.id === "azure-infra").status, "succeeded");
  assert.equal(result.results.find((entry) => entry.id === "dataverse-config").status, "succeeded");
  assert.equal(result.results.find((entry) => entry.id === "fabric-notebook").status, "resumed");
  const deploy = direct.calls.find((call) => call.kind === "deployTemplate");
  assert.ok(deploy, "the infrastructure must be redeployed with the new key");
  assert.ok(dataverse.written[engine.ENV.apiKey], "the new key must reach Dataverse");
  assert.notEqual(dataverse.written[engine.ENV.apiKey], "");
});

test("dataverse-config never reports success when it wrote nothing", async () => {
  const dataverse = dataverseHarness();
  const orchestrator = engine.createOrchestrator({
    dataverse,
    mode: "direct",
    dryRun: false,
    direct: directHarness({ webAppSettingsFails: true }),
    completed: { secret: true },
    target: engine.mergeConfiguration(VALID_TARGET),
    environmentUrl: "https://contoso.crm4.dynamics.com",
    crypto: { getRandomValues: () => { throw new Error("no entropy"); } },
    timer: immediateTimer,
    getToken: async () => "token"
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "secret");
  assert.equal(dataverse.written[engine.ENV.apiKey], undefined);
});

test("a resumed run without the Fabric facts fails loudly instead of deploying blanks", async () => {
  const direct = directHarness({ appSettings: { BEHAVIORAL_API_KEY: "earlier-run-key" } });
  const { orchestrator } = directOrchestrator({
    direct,
    settings: { completed: { secret: true, "fabric-discovery": true, "fabric-notebook": true }, facts: {} }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "azure-infra");
  assert.equal(direct.calls.some((call) => call.kind === "deployTemplate"), false);
  const step = result.results.find((entry) => entry.id === "azure-infra");
  assert.match(step.message, /Fabric workspace id/);
  assert.match(step.message, /Start over/);
});

test("fabric-permissions fails loudly when the managed identity is unknown", async () => {
  const direct = directHarness({ appSettings: { BEHAVIORAL_API_KEY: "earlier-run-key" } });
  const { orchestrator } = directOrchestrator({
    direct,
    settings: {
      completed: {
        secret: true,
        "fabric-discovery": true,
        "fabric-notebook": true,
        "azure-infra": true,
        "azure-app": true
      },
      facts: {
        workspaceId: VALID_TARGET.fabricWorkspaceId,
        servingLakehouseId: VALID_TARGET.fabricServingLakehouseId,
        packageSha256: SHIPPED_SHA,
        packageVersion: payload.api.version
      }
    }
  });
  const result = await orchestrator.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "fabric-permissions");
  assert.equal(direct.calls.some((call) => call.kind === "fabric" && /roleAssignments/.test(call.path)), false);
  assert.match(result.results.find((entry) => entry.id === "fabric-permissions").message, /managed identity/);
});

test("a run reports the facts and the completion map the page has to persist", async () => {
  const { orchestrator } = directOrchestrator();
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(result.facts.workspaceId, VALID_TARGET.fabricWorkspaceId);
  assert.equal(result.facts.servingLakehouseId, VALID_TARGET.fabricServingLakehouseId);
  assert.equal(result.facts.principalId, "99999999-8888-7777-6666-555555555555");
  assert.equal(result.facts.apiBaseUrl, "https://segment-preview-api.azurewebsites.net/api/");
  assert.equal(result.facts.notebookId, "cccccccc-dddd-eeee-ffff-000000000000");
  assert.equal("apiKey" in result.facts, false);
  assert.equal(result.completed.secret, true);
  assert.equal(result.completed["azure-infra"], true);
});

// -------------------------------------------------- shortcut provisioning

const SHORTCUTS_MISSING = {
  overallState: "partial",
  components: [
    { id: "azure-api", name: "Azure API", state: "ready" },
    {
      id: "dataverse-shortcuts",
      name: "Dataverse shortcuts",
      state: "partial",
      message: "2 of 4 required Dataverse shortcuts are missing.",
      action: "provision-shortcuts"
    }
  ]
};

const SHORTCUTS_READY = {
  overallState: "ready",
  components: [
    { id: "azure-api", name: "Azure API", state: "ready" },
    { id: "dataverse-shortcuts", name: "Dataverse shortcuts", state: "ready" }
  ]
};

test("needsShortcutProvisioning only reacts to the remedial action the API offers", () => {
  assert.equal(engine.needsShortcutProvisioning(SHORTCUTS_MISSING), true);
  assert.equal(engine.needsShortcutProvisioning(SHORTCUTS_READY), false);
  assert.equal(engine.needsShortcutProvisioning({ overallState: "partial" }), false);
  assert.equal(engine.needsShortcutProvisioning({ components: null }), false);
  assert.equal(engine.needsShortcutProvisioning(null), false);
  assert.equal(
    engine.needsShortcutProvisioning({ components: [{ action: "configure-dataverse" }] }),
    false
  );
  assert.equal(engine.PROVISION_SHORTCUTS_ACTION, "provision-shortcuts");
});

test("one run installs the missing Fabric shortcuts before it reports the status", async () => {
  const dataverse = dataverseHarness({ responses: [SHORTCUTS_MISSING, SHORTCUTS_READY] });
  const { orchestrator } = directOrchestrator({ dataverse });
  const result = await orchestrator.run();

  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.deepEqual(
    dataverse.actions,
    ["status", "provision-shortcuts"],
    "the run must ask for the shortcuts itself instead of leaving a second button to press"
  );
  const verify = result.results.find((entry) => entry.id === "verify");
  assert.equal(verify.status, "succeeded");
  assert.match(verify.message, /ready/);
  assert.match(verify.message, /shortcuts were installed/i);
  assert.equal(result.context.overallState, "ready");
  assert.equal(result.context.shortcutsProvisioned, true);
});

test("a tenant with every shortcut in place is never asked to provision again", async () => {
  const dataverse = dataverseHarness({ responses: [SHORTCUTS_READY] });
  const { orchestrator } = directOrchestrator({ dataverse });
  const result = await orchestrator.run();

  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.deepEqual(dataverse.actions, ["status"]);
  assert.equal(result.context.shortcutsProvisioned, false);
  assert.doesNotMatch(result.results.find((entry) => entry.id === "verify").message, /shortcut/i);
});

test("a shortcut that is not visible yet is re-checked instead of reported as missing", async () => {
  const dataverse = dataverseHarness({
    responses: [SHORTCUTS_MISSING, SHORTCUTS_MISSING, SHORTCUTS_READY]
  });
  const { orchestrator } = directOrchestrator({ dataverse });
  const result = await orchestrator.run();

  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.deepEqual(dataverse.actions, ["status", "provision-shortcuts", "status"]);
  assert.equal(result.context.overallState, "ready");
});

test("a provision response without components falls back to a fresh status read", async () => {
  const dataverse = dataverseHarness({
    responses: [SHORTCUTS_MISSING, { overallState: "ready" }, SHORTCUTS_READY]
  });
  const { orchestrator } = directOrchestrator({ dataverse });
  const result = await orchestrator.run();

  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.deepEqual(dataverse.actions, ["status", "provision-shortcuts", "status"]);
  assert.equal(result.context.status.components.length, 2);
});

test("a failed shortcut installation fails the run instead of reporting a clean status", async () => {
  const dataverse = dataverseHarness({
    responses: [SHORTCUTS_MISSING],
    failOn: "provision-shortcuts"
  });
  const { orchestrator } = directOrchestrator({ dataverse });
  const result = await orchestrator.run();

  assert.equal(result.ok, false);
  assert.equal(result.failedStep, "verify");
  assert.match(result.results[result.results.length - 1].message, /not reachable/);
});

test("browser permissions cover Fabric provisioning and the notebook schedule", () => {
  const registration = engine.describeAppRegistration("https://contoso.crm4.dynamics.com/webresources/x.html");
  const fabric = registration.permissions.find((entry) => entry.api === "Power BI Service");
  assert.deepEqual(fabric.scopes, [
    "Workspace.ReadWrite.All",
    "Item.ReadWrite.All",
    "Item.Execute.All",
    "Capacity.Read.All",
    "Connection.ReadWrite.All"
  ]);
  const arm = registration.permissions.find((entry) => entry.api === "Azure Service Management");
  assert.deepEqual(arm.scopes, ["user_impersonation"]);
  assert.equal(registration.permissions.length, 2);
});

test("the notebook is published through a long running Fabric operation", async () => {
  const direct = directHarness({ notebookAccepted: true });
  const { orchestrator } = directOrchestrator({ direct });
  const result = await orchestrator.run();
  assert.equal(result.ok, true, JSON.stringify(result.results, null, 2));
  assert.equal(result.facts.notebookId, "cccccccc-dddd-eeee-ffff-000000000000");
  assert.ok(direct.calls.some((call) => call.kind === "fabric" && call.path === "operations/op-1"));
  assert.ok(direct.calls.some((call) => call.kind === "fabric" && call.path === "operations/op-1/result"));
});

test("the Fabric client resolves a 202 through the operations endpoint", async () => {
  const requests = [];
  const client = engine.createDirectClient({
    fetch: async (url, init) => {
      requests.push({ url, method: init.method });
      if (/operations\/op-9\/result/.test(url)) {
        return jsonResponse(200, { id: "notebook-9" });
      }
      if (/operations\/op-9/.test(url)) {
        return jsonResponse(200, { status: "Succeeded" });
      }
      return {
        ok: true,
        status: 202,
        headers: { get: (name) => (name === "x-ms-operation-id" ? "op-9" : null) },
        text: async () => ""
      };
    },
    getToken: async () => "token",
    timer: immediateTimer
  });
  const accepted = await client.fabric("POST", "workspaces/w/notebooks", {});
  const item = await client.fabricResult(accepted);
  assert.equal(item.id, "notebook-9");
  assert.ok(requests.some((entry) => /operations\/op-9\/result/.test(entry.url)));
});

test("the Fabric client surfaces a failed long running operation", async () => {
  const client = engine.createDirectClient({
    fetch: async (url) => {
      if (/operations\/op-8/.test(url)) {
        return jsonResponse(200, { status: "Failed", error: { message: "capacity paused" } });
      }
      return {
        ok: true,
        status: 202,
        headers: { get: (name) => (name === "Location" ? "https://api.fabric.microsoft.com/v1/operations/op-8" : null) },
        text: async () => ""
      };
    },
    getToken: async () => "token",
    timer: immediateTimer
  });
  const accepted = await client.fabric("POST", "workspaces/w/notebooks", {});
  await assert.rejects(() => client.fabricResult(accepted), /capacity paused/);
});

test("packageBlobName binds the version and the digest so a release is immutable", () => {
  const name = engine.packageBlobName({ version: "1.1.0.0", sha256: SHIPPED_SHA });
  assert.equal(name, "api-1.1.0.0-" + SHIPPED_SHA.slice(0, 16) + ".zip");
  assert.notEqual(name, engine.packageBlobName({ version: "1.1.0.0", sha256: OVERRIDE_SHA }));
});


// --------------------------------------------------------- ARM drift guard

test("the browser template matches the compiled ARM template", () => {
  const compiled = JSON.parse(fs.readFileSync(path.join(repoRoot, "deployment", "azure", "main.json"), "utf8"));
  assert.deepEqual(embeddedTemplate, compiled);
});

test("the browser template exposes exactly the parameters and outputs declared in main.bicep", () => {
  const bicep = fs.readFileSync(path.join(repoRoot, "deployment", "azure", "main.bicep"), "utf8");
  const declared = (keyword) =>
    bicep
      .split(/\r?\n/)
      .map((line) => new RegExp(`^${keyword}\\s+([A-Za-z0-9_]+)\\b`).exec(line))
      .filter(Boolean)
      .map((match) => match[1])
      .sort();
  assert.deepEqual(Object.keys(embeddedTemplate.parameters).sort(), declared("param"));
  assert.deepEqual(Object.keys(embeddedTemplate.outputs).sort(), declared("output"));
});

test("every required ARM parameter is supplied by the orchestrator", () => {
  const supplied = new Set([
    "location",
    "webAppName",
    "fabricSqlServer",
    "fabricSqlDatabase",
    "fabricWorkspaceId",
    "fabricServingLakehouseId",
    "fabricDataverseConnectionId",
    "fabricDataverseDeltaFolder",
    "dataverseEnvironmentUrl",
    "behavioralApiKey",
    "requiredDataverseTables",
    "apiPackageUrl",
    "apiPackageSha256",
    "apiPackageBlobName",
    "apiPackageVersion"
  ]);
  Object.keys(embeddedTemplate.parameters).forEach((name) => {
    const optional = Object.prototype.hasOwnProperty.call(embeddedTemplate.parameters[name], "defaultValue");
    assert.ok(
      supplied.has(name) || optional,
      `The orchestrator does not supply the required ARM parameter '${name}'.`
    );
  });
  supplied.forEach((name) => {
    assert.ok(embeddedTemplate.parameters[name], `The template no longer declares '${name}'.`);
  });
});

test("the ARM template copies the package server side and never exposes it publicly", () => {
  const bicep = fs.readFileSync(path.join(repoRoot, "deployment", "azure", "main.bicep"), "utf8");
  // A release asset cannot be fetched from a Dataverse origin, so the copy runs
  // inside the customer's subscription instead of inside the browser.
  assert.match(bicep, /Microsoft\.ContainerInstance\/containerGroups/);
  assert.match(bicep, /sha256sum/);
  assert.match(bicep, /allowBlobPublicAccess:\s*false/);
  assert.match(bicep, /allowSharedKeyAccess:\s*false/);
  assert.match(bicep, /publicNetworkAccess:\s*'Disabled'/);
  assert.match(bicep, /Microsoft\.Network\/privateEndpoints/);
  assert.match(bicep, /Microsoft\.Network\/privateDnsZones/);
  assert.match(bicep, /virtualNetworkSubnetId/);
  assert.match(bicep, /--auth-mode login/);
  const resources = JSON.stringify(embeddedTemplate.resources);
  assert.ok(resources.includes("WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID"));
  assert.ok(resources.includes("SystemAssigned"));
  assert.equal(/sig=|signedPermission|listAccountSas/i.test(resources), false, "no shared access signature");
});


// -------------------------------------------------- tenant app registration

test("describeAppRegistration derives the redirect URI from the page URL", () => {
  const registration = engine.describeAppRegistration(
    "https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html?id=1#frag"
  );
  assert.equal(
    registration.redirectUri,
    "https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html"
  );
  assert.equal(registration.platform, "Single-page application");
  assert.ok(registration.steps.length >= 5);
  assert.ok(/^https:\/\/entra\.microsoft\.com\//.
test(registration.newAppUrl));
  assert.ok(/^https:\/\/entra\.microsoft\.com\//.
test(registration.appListUrl));});
test("redirectUriFor removes the Dynamics cache-busting web-resource path", () => {
  assert.equal(
    engine.redirectUriFor(
      "https://contoso.crm4.dynamics.com/%7B639231564490000157%7D/webresources/klth_/SegmentSankey/segment-preview-setup.html"
    ),
    "https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html"
  );
});

test("redirectUriFor resolves a Unified Interface web-resource page", () => {
  assert.equal(
    engine.redirectUriFor(
      "https://contoso.crm4.dynamics.com/main.aspx?appid=app-id&pagetype=webresource&webresourceName=klth_%2FSegmentSankey%2Fsegment-preview-setup.html"
    ),
    "https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html"
  );
});

test("describeAppRegistration lists exactly the delegated permissions the engine uses", () => {
  const registration = engine.describeAppRegistration("https://contoso.crm4.dynamics.com/x.html");
  const arm = registration.permissions.find((entry) => entry.api === "Azure Service Management");
  const fabric = registration.permissions.find((entry) => entry.api === "Power BI Service");
  assert.deepEqual(arm.scopes, ["user_impersonation"]);
  assert.equal(arm.type, "Delegated");
  assert.deepEqual(fabric.scopes, engine.FABRIC_DELEGATED_SCOPES);
  assert.equal(fabric.adminConsent, true);
  assert.ok(engine.ARM_SCOPE.endsWith(arm.scopes[0]));
});

test("describeAppRegistration survives a missing page URL", () => {
  assert.equal(engine.describeAppRegistration(undefined).redirectUri, null);
  assert.equal(engine.describeAppRegistration("not a url").redirectUri, null);
});

test("adminConsentUrl is built only from a valid client id", () => {
  const url = engine.adminConsentUrl(
    "11111111-2222-3333-4444-555555555555",
    "https://contoso.crm4.dynamics.com/x.html"
  );
  assert.ok(url.startsWith("https://login.microsoftonline.com/common/adminconsent?"));
  assert.ok(url.includes("client_id=11111111-2222-3333-4444-555555555555"));
  assert.ok(url.includes(encodeURIComponent("https://contoso.crm4.dynamics.com/x.html")));
  assert.equal(engine.adminConsentUrl("not-a-guid", "https://x/y"), null);
  assert.equal(engine.adminConsentUrl("11111111-2222-3333-4444-555555555555", null), null);
});

test("the consent checklist covers the tenant registration and its admin consent", () => {
  const ids = engine.describeConsent().map((entry) => entry.id);
  assert.ok(ids.includes("app-registration"));
  assert.ok(ids.includes("app-admin-consent"));
});

test("no consent guidance requires locally installed tooling", () => {
  engine.describeConsent().forEach((entry) => {
    assert.doesNotMatch(entry.guidance, /Install-SegmentPreview|\.ps1|PowerShell|command line/i);
  });
});


// ------------------------------------------------------------- auth client

function authHarness(options) {
  const opened = [];
  const posted = [];
  const responses = (options && options.responses) || [];
  let clock = 1000;
  return {
    opened,
    posted,
    advance(ms) {
      clock += ms;
    },
    client: engine.createAuthClient({
      clientId: "11111111-2222-3333-4444-555555555555",
      redirectUri: "https://contoso.crm4.dynamics.com/setup.html",
      timer: (fn) => fn(),
      now: () => clock,
      popupPollMs: 0,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      sha256: async () => new Uint8Array(32).fill(9),
      openWindow: (url) => {
        opened.push(url);
        const state = new URL(url.replace("#", "?")).searchParams.get("state");
        return {
          closed: false,
          location: {
            href:
              "https://contoso.crm4.dynamics.com/setup.html#code=AUTH-CODE&state=" +
              encodeURIComponent(state)
          },
          close() {
            this.closed = true;
          }
        };
      },
      http: {
        async send(request) {
          posted.push(request);
          return { status: 200, body: responses.shift() };
        }
      }
    })
  };
}
test("createAuthClient rejects a client id that is not a GUID", () => {
  assert.throws(
    () => engine.createAuthClient({ clientId: "nope", redirectUri: "https://x/y" }),
    /client\) id/i
  );
});

test("createAuthClient requires a redirect URI", () => {
  assert.throws(
    () => engine.createAuthClient({ clientId: "11111111-2222-3333-4444-555555555555" }),
    /redirect URI/i
  );
});

test("createAuthClient runs the PKCE authorization code flow in a popup", async () => {
  const harness = authHarness({
    responses: [{ access_token: "ARM-TOKEN", expires_in: 3600, refresh_token: "R1" }]
  });
  const token = await harness.client.getToken(engine.ARM_SCOPE);
  assert.equal(token, "ARM-TOKEN");
  const authorizeUrl = new URL(harness.opened[0].replace("#", "?"));
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("response_mode"), "fragment");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizeUrl.searchParams.get("code_challenge"));
  assert.equal(
    authorizeUrl.searchParams.get("redirect_uri"),
    "https://contoso.crm4.dynamics.com/setup.html"
  );
  assert.ok(authorizeUrl.searchParams.get("scope").includes("offline_access"));
  assert.equal(harness.posted.length, 1);
  assert.equal(harness.posted[0].method, "POST");
  assert.equal(
    harness.posted[0].url,
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"
  );
  assert.match(harness.posted[0].headers["Content-Type"], /x-www-form-urlencoded/);
  const form = new URLSearchParams(harness.posted[0].body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "AUTH-CODE");
  assert.ok(form.get("code_verifier"));
  assert.equal(form.get("client_id"), "11111111-2222-3333-4444-555555555555");
});

test("createAuthClient caches a token and does not sign in twice", async () => {
  const harness = authHarness({
    responses: [{ access_token: "ARM-TOKEN", expires_in: 3600, refresh_token: "R1" }]
  });
  await harness.client.getToken(engine.ARM_SCOPE);
  const again = await harness.client.getToken(engine.ARM_SCOPE);
  assert.equal(again, "ARM-TOKEN");
  assert.equal(harness.opened.length, 1);
  assert.equal(harness.posted.length, 1);
});

test("createAuthClient redeems the refresh token for the second resource", async () => {
  const harness = authHarness({
    responses: [
      { access_token: "ARM-TOKEN", expires_in: 3600, refresh_token: "R1" },
      { access_token: "FABRIC-TOKEN", expires_in: 3600, refresh_token: "R2" }
    ]
  });
  await harness.client.getToken(engine.ARM_SCOPE);
  const fabric = await harness.client.getToken(engine.FABRIC_SCOPE);
  assert.equal(fabric, "FABRIC-TOKEN");
  assert.equal(harness.opened.length, 1, "the administrator is prompted only once");
  const form = new URLSearchParams(harness.posted[1].body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "R1");
  assert.ok(form.get("scope").startsWith(engine.FABRIC_SCOPE));
});

test("createAuthClient signs in again when the cached token expired", async () => {
  const harness = authHarness({
    responses: [
      { access_token: "FIRST", expires_in: 60 },
      { access_token: "SECOND", expires_in: 3600 }
    ]
  });
  assert.equal(await harness.client.getToken(engine.ARM_SCOPE), "FIRST");
  harness.advance(120000);
  assert.equal(await harness.client.getToken(engine.ARM_SCOPE), "SECOND");
  assert.equal(harness.opened.length, 2);
});

test("createAuthClient reports a blocked popup instead of hanging", async () => {
  const client = engine.createAuthClient({
    clientId: "11111111-2222-3333-4444-555555555555",
    redirectUri: "https://contoso.crm4.dynamics.com/setup.html",
    randomBytes: (length) => new Uint8Array(length).fill(1),
    sha256: async () => new Uint8Array(32).fill(2),
    openWindow: () => null,
    http: { async send() { throw new Error("must not be called"); } }
  });
  await assert.rejects(() => client.getToken(engine.ARM_SCOPE), /pop-ups/i);
});

test("createAuthClient rejects a state mismatch", async () => {
  const client = engine.createAuthClient({
    clientId: "11111111-2222-3333-4444-555555555555",
    redirectUri: "https://contoso.crm4.dynamics.com/setup.html",
    timer: (fn) => fn(),
    popupPollMs: 0,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    sha256: async () => new Uint8Array(32).fill(2),
    openWindow: () => ({
      closed: false,
      location: { href: "https://contoso.crm4.dynamics.com/setup.html#code=X&state=TAMPERED" },
      close() {}
    }),
    http: { async send() { throw new Error("must not be called"); } }
  });
  await assert.rejects(() => client.getToken(engine.ARM_SCOPE), /did not match/i);
});

test("createAuthClient surfaces an error returned by Entra", async () => {
  const client = engine.createAuthClient({
    clientId: "11111111-2222-3333-4444-555555555555",
    redirectUri: "https://contoso.crm4.dynamics.com/setup.html",
    timer: (fn) => fn(),
    popupPollMs: 0,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    sha256: async () => new Uint8Array(32).fill(2),
    openWindow: (url) => {
      const state = new URL(url.replace("#", "?")).searchParams.get("state");
      return {
        closed: false,
        location: {
          href:
            "https://contoso.crm4.dynamics.com/setup.html#error=consent_required" +
            "&error_description=Admin%20consent%20is%20required&state=" +
            encodeURIComponent(state)
        },
        close() {}
      };
    },
    http: { async send() { throw new Error("must not be called"); } }
  });
  await assert.rejects(() => client.getToken(engine.ARM_SCOPE), /Admin consent is required/);
});

test("createAuthClient ignores a popup that is still on the Microsoft origin", async () => {
  let reads = 0;
  const harness = engine.createAuthClient({
    clientId: "11111111-2222-3333-4444-555555555555",
    redirectUri: "https://contoso.crm4.dynamics.com/setup.html",
    timer: (fn) => fn(),
    now: () => 1000,
    popupPollMs: 0,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    sha256: async () => new Uint8Array(32).fill(2),
    openWindow: (url) => {
      const state = new URL(url.replace("#", "?")).searchParams.get("state");
      return {
        closed: false,
        get location() {
          reads += 1;
          if (reads < 3) throw new Error("cross-origin");
          return {
            href:
              "https://contoso.crm4.dynamics.com/setup.html#code=LATE&state=" +
              encodeURIComponent(state)
          };
        },
        close() {}
      };
    },
    http: {
      async send() {
        return { status: 200, body: { access_token: "LATE-TOKEN", expires_in: 3600 } };
      }
    }
  });
  assert.equal(await harness.getToken(engine.ARM_SCOPE), "LATE-TOKEN");
  assert.ok(reads >= 3);
});

test("loadSetupContext exposes the registration guidance and admin consent link", async () => {
  const dataverse = {
    async getEnvironmentVariables() {
      return { [engine.ENV.clientId]: { value: "11111111-2222-3333-4444-555555555555" } };
    },
    effectiveValue: (record) => (record ? record.value : null)
  };
  const context = await engine.loadSetupContext(
    dataverse,
    "https://contoso.crm4.dynamics.com",
    "https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html"
  );
  assert.equal(context.mode.mode, "direct");
  assert.equal(
    context.appRegistration.redirectUri,
    "https://contoso.crm4.dynamics.com/WebResources/klth_/SegmentSankey/segment-preview-setup.html"
  );
  assert.ok(context.adminConsentUrl.includes("adminconsent"));
});

test("saveClientId validates the GUID before writing it to Dataverse", async () => {
  const written = [];
  const dataverse = {
    async setEnvironmentVariable(name, value) {
      written.push([name, value]);
    }
  };
  await engine.saveClientId(dataverse, "  11111111-2222-3333-4444-555555555555  ");
  assert.deepEqual(written, [[engine.ENV.clientId, "11111111-2222-3333-4444-555555555555"]]);
  await assert.rejects(() => engine.saveClientId(dataverse, "nope"), /GUID/);
  assert.equal(written.length, 1);
});
