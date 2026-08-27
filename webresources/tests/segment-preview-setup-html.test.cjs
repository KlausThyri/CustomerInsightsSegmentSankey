"use strict";

/*
 * Guards the setup web resource itself: the inline script must parse, every
 * element it looks up must exist in the markup, and the provisioning engine
 * plus the generated Azure template must be referenced before it runs.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML_PATH = path.join(__dirname, "..", "segment-preview-setup.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

function inlineScripts(source) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

function externalScripts(source) {
  const sources = [];
  const pattern = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    sources.push(match[1]);
  }
  return sources;
}

test("the setup web resource contains inline script", () => {
  assert.ok(inlineScripts(html).length > 0);
});

test("every inline script parses as JavaScript", () => {
  inlineScripts(html).forEach((code, index) => {
    assert.doesNotThrow(
      () => new vm.Script(code, { filename: `segment-preview-setup.html#${index}` }),
      `inline script ${index} does not parse`
    );
  });
});

test("the provisioning engine and Azure template are loaded before the inline logic", () => {
  const external = externalScripts(html);
  assert.ok(external.some((source) => source.startsWith("segment-preview-provisioning.js?rev=")));
  assert.ok(external.some((source) => source.startsWith("segment-preview-azure-template.js?rev=")));

  const engineAt = html.indexOf('src="segment-preview-provisioning.js?rev=');
  const templateAt = html.indexOf('src="segment-preview-azure-template.js?rev=');
  const logicAt = html.indexOf("SegmentPreviewProvisioning");
  assert.ok(engineAt > -1 && templateAt > -1 && logicAt > -1);
  assert.ok(engineAt < logicAt, "the engine must be loaded before it is used");
  assert.ok(templateAt < logicAt, "the template must be loaded before it is used");
});

test("all inline setup scripts are valid JavaScript", () => {
  inlineScripts(html).forEach(code => assert.doesNotThrow(() => new Function(code)));
});

test("all external setup scripts use the current cache-busting revision", () => {
  const external = externalScripts(html);
  const version = html.match(/class="app-version"[^>]*>v([^<]+)</)[1];
  assert.equal(external.length, 3);
  external.forEach((source) => assert.ok(source.endsWith(`?rev=${version}`)));
});

test("closed details and hidden status elements cannot leak component content", () => {
  assert.match(
    html,
    /\[hidden\],\s*details:not\(\[open\]\)\s*>\s*:not\(summary\)\s*\{\s*display:\s*none\s*!important;\s*\}/
  );
});

test("successful updates navigate to a cache-busted Setup URL", () => {
  assert.match(html, /new URL\(window\.parent\.location\.href\)/);
  assert.match(html, /"rev-" \+ update\.latestVersion \+ "-" \+ Date\.now\(\)/);
  assert.match(html, /window\.parent\.location\.replace\(nextUrl\.toString\(\)\)/);
  assert.doesNotMatch(html, /window\.parent\.location\.reload\(\)/);
});

test("missing Dataverse source tables are retried for two minutes", () => {
  assert.match(html, /engine\.provisionShortcutsWithRetry\(execute/);
  assert.match(html, /Setup will retry automatically/);
});

test("the Azure infrastructure step renders an accessible nested progress indicator", () => {
  assert.match(html, /step-sub-progress-azure-infra/);
  assert.match(html, /aria-label", "Azure infrastructure deployment progress"/);
  assert.match(html, /sub-progress 1\.5s ease-in-out infinite/);
  assert.match(html, /entry\.subProgress/);
  assert.match(html, /step-sub-progress-list-azure-infra/);
  assert.match(html, /Azure resources being deployed/);
  assert.match(html, /renderAzureSubsteps\(\s*substeps/);
  assert.match(html, /\.step\.running \.step-sub-progress \{ display: block; \}/);
  assert.match(html, /azureDeploymentStages/);
  assert.match(html, /Verify and copy the API package/);
});

test("selecting an existing Resource Group does not force its metadata location", () => {
  inlineScripts(html).forEach((code) => {
    assert.doesNotMatch(
      code,
      /selectedResourceGroup\?\.location|merged\.location\s*=\s*selectedResourceGroup\.location/
    );
  });
});

test("every statically referenced element id exists in the markup", () => {
  const ids = new Set();
  const pattern = /getElementById\("([A-Za-z0-9_-]+)"\)/g;
  inlineScripts(html).forEach((code) => {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      ids.add(match[1]);
    }
  });

  assert.ok(ids.size >= 15, "expected the setup center element lookups to be found");
  const missing = [...ids].filter((id) => {
    if (new RegExp(`id="${id}"`).test(html)) return false;
    if (new RegExp(`\\.id\\s*=\\s*"${id}"`).test(html)) return false;
    return !(id.startsWith("field-") && html.includes('input.id = "field-" + field.key'));
  });
  assert.deepStrictEqual(missing, [], `missing element ids: ${missing.join(", ")}`);
});

test("the one-button provisioning controls are present", () => {
  ["provisionButton", "panelProvisionButton"].forEach((id) => {
    assert.ok(new RegExp(`id="${id}"`).test(html), `${id} is missing`);
  });
  assert.doesNotMatch(html, /Preview run/);
  assert.doesNotMatch(html, /panelPreviewButton|previewButton/);

  test("installation exposes an accessible visual progress bar", () => {
    [
      "installProgress",
      "installProgressStatus",
      "installProgressPercent",
      "installProgressFill"
    ].forEach(id => assert.ok(html.includes(`id="${id}"`), `${id} is missing`));
    assert.match(html, /role="progressbar"/);
    assert.ok(inlineScripts(html).some(code => code.includes("function updateInstallProgress")));
  });

  test("Start over clears environment values and restores target defaults", () => {
    const code = inlineScripts(html).join("\n");
    assert.match(code, /resetEnvironmentVariables\(Object\.values\(engine\.ENV\)\)/);
    assert.match(code, /engine\.applyAutomaticTarget\(engine\.TARGET_DEFAULTS\)/);
    assert.match(code, /engine\.clearBrokerSession/);
  });
});

test("the setup center loads Azure resource groups into a selector", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes('document.createElement("select")'));
  assert.ok(code.includes('"Create a new resource group…"'));
  assert.ok(code.includes("direct.listResourceGroups(subscriptionId)"));
  assert.ok(code.includes('loadButton.textContent = groups.length ? "Reload" : "Load groups"'));
  assert.ok(code.includes('merged.resourceGroup = values.resourceGroup || ""'));
  assert.ok(code.includes('loadButton.hidden = state.setup?.mode?.mode !== "direct"'));
});

test("the setup center loads tenant subscriptions into a selector", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes('"Select an Azure subscription"'));
  assert.ok(code.includes("direct.listSubscriptions()"));
  assert.ok(code.includes('"Load subscriptions"'));
  assert.ok(code.includes('merged.subscriptionId = values.subscriptionId || ""'));
  assert.ok(code.includes('state.setup?.mode?.mode === "direct"'));
  assert.ok(code.includes("state.azureTokenProvider?.dispose?.()"));
});

test("the setup center loads active Fabric capacities into a selector", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes('"Select a Fabric capacity"'));
  assert.ok(code.includes("direct.listCapacities()"));
  assert.ok(code.includes('"Load capacities"'));
  assert.ok(code.includes('loadButton.id = "loadFabricCapacitiesButton"'));
  assert.ok(code.includes('state.setup?.mode?.mode === "direct"'));
});

test("required and optional fields are explicit and tenant resources use selectors", () => {
  const code = inlineScripts(html).join("\n");
  assert.match(html, /requirement\.required/);
  assert.match(html, /requirement\.conditional/);
  assert.match(html, /requirement\.optional/);
  [
    "loadAzureLocationsButton",
    "loadFabricWorkspacesButton",
    "loadFabricLakehousesButton",
    "loadFabricConnectionsButton"
  ].forEach(id => assert.ok(code.includes(id), `${id} is missing`));
  assert.ok(code.includes("direct.listLocations"));
  assert.ok(code.includes("direct.listWorkspaces"));
  assert.ok(code.includes("direct.listLakehouses"));
  assert.ok(code.includes("direct.listDataverseConnections"));
});

test("new installation exposes only subscription and resource group as required", () => {
  const code = inlineScripts(html).join("\n");
  assert.match(html, /only two selections required for a new installation/i);
  assert.match(html, /id="targetAdvanced"[\s\S]*Advanced options \(optional\)/);
  assert.ok(code.includes("engine.applyAutomaticTarget(readFields())"));
  assert.equal((code.match(/requirement:\s*"required"/g) || []).length, 2);
  assert.equal((code.match(/requirement:\s*"optional"/g) || []).length, 11);
});

test("business-unit scoping is an explicit accessible setup switch", () => {
  assert.match(html, /key: "businessUnitScopingEnabled"/);
  assert.match(html, /Business-unit scoping/);
  assert.match(html, /role", "switch"/);
  assert.match(html, /toggle-track/);
  assert.match(html, /input\.checked \? "On" : "Off"/);
  assert.match(html, /child business units are excluded/i);
  assert.match(html, /Settings > Feature switches/);
});

test("target settings are saved beside the target and advanced options", () => {
  assert.match(
    html,
    /id="targetAdvanced"[\s\S]*id="saveButton"[^>]*>Save target settings<\/button>[\s\S]*<\/section>/
  );
  assert.match(html, /Stores the Business-unit switch and all Advanced options/);
  assert.match(html, /Target settings saved to this environment/);
});

test("the Setup Center can check and install verified solution updates", () => {
  [
    "checkUpdatesButton",
    "updatePanel",
    "updateTitle",
    "updateCopy",
    "updateReleaseLink",
    "installUpdateButton"
  ].forEach(id => assert.ok(html.includes(`id="${id}"`), `${id} is missing`));
  assert.match(html, /api\.github\.com\/repos\/" \+ UPDATE_REPOSITORY \+ "\/releases\/latest"/);
  assert.match(html, /raw\.githubusercontent\.com/);
  assert.match(html, /engine\.resolveSolutionUpdate/);
  assert.match(html, /sha256Hex\(bytes\)/);
  assert.match(html, /digest !== update\.digest/);
  assert.match(html, /dataverseRequest\("ImportSolution"/);
  assert.match(html, /OverwriteUnmanagedCustomizations: !update\.managed/);
  assert.match(html, /PublishXml/);
  assert.match(html, /void checkForUpdates\(\)/);
  assert.doesNotMatch(html, /github\.com\/" \+ UPDATE_REPOSITORY \+ "\/releases\/download/);
});

test("the Dataverse source fields explain automatic shortcut discovery", () => {
  assert.match(html, /Dataverse source Lakehouse ID/);
  assert.match(html, /Automatically discovered from this environment's Link to Microsoft Fabric Lakehouse/);
  assert.match(html, /Dataverse Managed Lake folder/);
  assert.match(html, /Automatically discovered from the Dataverse source shortcut/);
});

test("provisioning is presented and gated as a three-step workflow", () => {
  const code = inlineScripts(html).join("\n");
  [
    "setupStepConnect",
    "setupStepTarget",
    "setupStepInstall",
    "workflowNavConnect",
    "workflowNavTarget",
    "workflowNavInstall"
  ].forEach(id => assert.ok(html.includes(`id="${id}"`), `${id} is missing`));
  assert.match(html, /<h3 class="stage-title">Connect this environment<\/h3>/);
  assert.match(html, /<h3 class="stage-title">Choose Subscription and Resource Group<\/h3>/);
  assert.match(html, /<h3 class="stage-title">Install everything<\/h3>/);
  assert.ok(code.includes("function updateWorkflow"));
  assert.ok(code.includes('stage.setAttribute("aria-disabled", status === "locked"'));
  assert.ok(code.includes("panelProvisionButton.disabled = state.loading || !targetReady"));
});

test("Azure and Fabric selectors are stacked and constrained within the setup grid", () => {
  const code = inlineScripts(html).join("\n");
  assert.match(html, /\.selector-field\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*width:\s*min\(100%,\s*560px\)/);
  assert.match(html, /\.selector-actions select\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.ok(code.includes('? " selector-field"'));
  assert.equal((code.match(/row\.className = "selector-actions"/g) || []).length, 7);
});

test("the setup center never renders a raw API key", () => {
  assert.ok(!/textContent\s*=\s*[^;]*\.apiKey\b/.test(html), "an API key must never be written to the DOM");
});

test("the packaged copy of the web resource matches the source", () => {
  const packaged = path.join(
    __dirname,
    "..",
    "..",
    "solution",
    "src",
    "WebResources",
    "klth_",
    "SegmentSankey",
    "segment-preview-setup.html"
  );
  if (!fs.existsSync(packaged)) return;
  assert.strictEqual(fs.readFileSync(packaged, "utf8"), html);
});

test("the packaged copies of the provisioning scripts match the source", () => {
  ["segment-preview-provisioning.js", "segment-preview-azure-template.js"].forEach((name) => {
    const source = path.join(__dirname, "..", name);
    const packaged = path.join(
      __dirname,
      "..",
      "..",
      "solution",
      "src",
      "WebResources",
      "klth_",
      "SegmentSankey",
      name
    );
    if (!fs.existsSync(packaged)) return;
    assert.strictEqual(
      fs.readFileSync(packaged, "utf8"),
      fs.readFileSync(source, "utf8"),
      `${name} is out of date in solution/src`
    );
  });
});

test("the connect wizard is part of the setup page", () => {
  [
    "connectPanel",
    "connectSteps",
    "brokerState",
    "connectBrokerUrl",
    "connectBrokerSaveButton",
    "connectBrokerError",
    "sessionBanner",
    "advancedPanel",
    "advancedSteps",
    "connectRedirectUri",
    "connectClientId",
    "connectSaveButton",
    "openPortalButton",
    "adminConsentButton",
    "copyRedirectButton",
    "connectPermissions"
  ].forEach((id) => {
    assert.ok(html.includes(`id="${id}"`), `the markup is missing #${id}`);
  });
  assert.ok(/Connect this environment/.test(html));
});

test("the single install action is labelled consistently", () => {
  const labels = html.match(/<button[^>]*id="(?:provisionButton|panelProvisionButton)"[^>]*>([^<]+)</g) || [];
  assert.equal(labels.length, 2, "both install buttons must exist");
  labels.forEach((label) => assert.match(label, />Install everything</));
});

test("the broker service URL is configurable and never hard-coded", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes("engine.saveBrokerUrl"), "the page must persist the service URL through the engine");
  assert.ok(code.includes("context.broker"), "the page must render the engine broker state");
  assert.ok(code.includes("engine.isHttpsUrl"), "the service URL must be validated as https");
  assert.ok(code.includes("mode.brokerUrl"), "the run must use the configured service URL");
  const urls = (html.match(/https:\/\/[a-z0-9.-]+/gi) || []).map((url) => url.toLowerCase());
  urls.forEach((url) => {
    assert.ok(
      url.includes("login.microsoftonline.com") ||
        url.includes("portal.azure.com") ||
        url.includes("provisioning.example.com") ||
        url.includes("storage.example.com") ||
        url.includes("azurewebsites.net") ||
        url.includes("api.github.com") ||
        url.includes("raw.githubusercontent.com") ||
        url.includes("www.w3.org"),
      `the page must not hard-code the endpoint ${url}`
    );
  });
});

test("the broker path is used for the run and the session is validated", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes("engine.createBrokerSession"));
  assert.ok(code.includes("engine.loadBrokerSession"));
  assert.ok(code.includes("engine.saveBrokerSession"));
  assert.ok(code.includes("engine.clearBrokerSession"));
  assert.ok(code.includes("resumeRunId"), "a known run must be resumable");
  assert.ok(code.includes("pageOrigin"), "the broker must learn the page origin for postMessage");
});

test("an unconfigured hosted service is stated explicitly and never presented as required", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes("broker.headline"));
  assert.ok(code.includes("broker.steps"));
  assert.ok(code.includes("broker.configured"));
  assert.match(html, /Optional: use a hosted provisioning service instead/, "the hosted service must be an optional panel");
  assert.match(
    html,
    /<details class="connect" id="advancedPanel">[\s\S]*id="connectBrokerUrl"/,
    "the service URL field must live inside the optional panel"
  );
});

test("the tenant-owned registration is the primary connect path", () => {
  const primary = html.slice(
    html.indexOf('id="connectPanel"'),
    html.indexOf('id="advancedPanel"')
  );
  ["connectRedirectUri", "connectPermissions", "connectClientId", "connectSaveButton", "openPortalButton"].forEach((id) => {
    assert.ok(primary.includes(`id="${id}"`), `#${id} must sit in the primary connect body, before the optional panel`);
  });
  assert.match(primary, /register once in your own tenant/i);
  assert.ok(!primary.includes('id="connectBrokerUrl"'), "the hosted service URL must not be in the primary path");
});

test("the page states that every provisioned resource stays in the customer tenant", () => {
  assert.match(html, /own tenant and (your )?subscription/i);
  const code = inlineScripts(html).join("\n");
  assert.match(code, /belongs to your own tenant and subscription/i);
});

test("the connect wizard is driven by the engine, never by hard-coded identifiers", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes("engine.saveClientId"));
  assert.ok(code.includes("context.appRegistration"));
  assert.ok(code.includes("context.adminConsentUrl"));
  const guids = html.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [];
  guids.forEach((guid) => {
    assert.equal(guid, "00000000-0000-0000-0000-000000000000", `the page hard-codes the id ${guid}`);
  });
});

test("direct provisioning falls back to the built-in PKCE client when MSAL is absent", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes("engine.createAuthClient"));
  assert.ok(code.includes("engine.redirectUriFor"));
});

test("the page short-circuits when it is loaded as the sign-in popup", () => {
  const code = inlineScripts(html).join("\n");
  assert.ok(code.includes("window.opener"));
  assert.match(code, /code\|error|\(code\|error\)=/);
});

test("the setup page never refers the administrator to a local installer", () => {
  assert.doesNotMatch(html, /Install-SegmentPreview|offline installer|\.ps1\b/i);
});
test("the inline script returns immediately when it is the sign-in popup", () => {
  const code = inlineScripts(html).slice(-1)[0];
  let lookups = 0;
  const body = { textContent: "" };
  const sandbox = {
    document: {
      body,
      getElementById() {
        lookups += 1;
        return null;
      },
      addEventListener() {}
    }
  };
  sandbox.window = {
    opener: { name: "opener" },
    location: { href: "https://contoso.crm4.dynamics.com/setup.html#code=ABC&state=XYZ" },
    document: sandbox.document
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "popup-guard" });
  assert.equal(lookups, 0, "the setup center must not bootstrap inside the sign-in popup");
  assert.match(body.textContent, /Signing in/);
});

test("the inline script does not short-circuit a normal page load", () => {
  const code = inlineScripts(html).slice(-1)[0];
  let lookups = 0;
  const sandbox = {
    document: {
      body: { textContent: "", setAttribute() {} },
      getElementById() {
        lookups += 1;
        return null;
      },
      addEventListener() {}
    }
  };
  sandbox.window = { location: { href: "https://contoso.crm4.dynamics.com/setup.html" }, document: sandbox.document };
  vm.createContext(sandbox);
  assert.throws(() => vm.runInContext(code, sandbox, { filename: "normal-load" }));
  assert.ok(lookups > 0, "a normal load must bootstrap the setup center");
});
