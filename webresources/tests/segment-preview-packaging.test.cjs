"use strict";

/*
 * Guards the managed solution packaging: the new browser provisioning assets
 * must be declared as root components, the build script must copy them, and the
 * setup center environment variables must exist without default values.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..");
const solutionXml = fs.readFileSync(
  path.join(repoRoot, "solution", "src", "Other", "Solution.xml"),
  "utf8"
);
const buildScript = fs.readFileSync(
  path.join(repoRoot, "solution", "build-solution.ps1"),
  "utf8"
);

const NEW_WEB_RESOURCES = [
  "segment-preview-provisioning.js",
  "segment-preview-azure-template.js"
];

const SETUP_VARIABLES = [
  "klth_SetupProvisioningMode",
  "klth_SetupBrokerUrl",
  "klth_SetupBrokerScope",
  "klth_SetupEntraClientId",
  "klth_SetupConfiguration"
];

test("the solution version is ahead of the shipped 1.0.0.0 build", () => {
  const match = /<Version>([\d.]+)<\/Version>/.exec(solutionXml);
  assert.ok(match, "no version element found");
  const parts = match[1].split(".").map(Number);
  const shipped = [1, 0, 0, 0];
  const ahead = parts.some((value, index) => value > shipped[index]);
  assert.ok(ahead, `solution version ${match[1]} must be greater than 1.0.0.0`);
});

test("the provisioning web resources are declared as root components", () => {
  NEW_WEB_RESOURCES.forEach((name) => {
    const expected = `<RootComponent type="61" schemaName="klth_/SegmentSankey/${name}" behavior="0" />`;
    assert.ok(solutionXml.includes(expected), `missing root component for ${name}`);
  });
});

test("the plugin assembly root component is untouched", () => {
  assert.ok(
    solutionXml.includes("PublicKeyToken=7723c9b9c78b183b"),
    "the signed assembly identity must not change or upgrades break"
  );
});

test("the build script copies the provisioning web resources", () => {
  NEW_WEB_RESOURCES.forEach((name) => {
    assert.ok(buildScript.includes(name), `build-solution.ps1 does not copy ${name}`);
  });
});

test("each provisioning web resource has a JScript metadata sidecar", () => {
  NEW_WEB_RESOURCES.forEach((name) => {
    const sidecar = path.join(
      repoRoot,
      "solution",
      "src",
      "WebResources",
      "klth_",
      "SegmentSankey",
      `${name}.data.xml`
    );
    assert.ok(fs.existsSync(sidecar), `missing sidecar for ${name}`);
    const xml = fs.readFileSync(sidecar, "utf8");
    assert.match(xml, /<WebResourceType>3<\/WebResourceType>/);
    assert.ok(xml.includes(`<Name>klth_/SegmentSankey/${name}</Name>`));
    const id = /<WebResourceId>\{([0-9a-f-]+)\}<\/WebResourceId>/i.exec(xml);
    assert.ok(id, "no web resource id");
    assert.ok(
      xml.includes(id[1].toUpperCase()),
      "the FileName must embed the upper-case web resource id"
    );
  });
});

test("web resource ids are unique across the solution", () => {
  const folder = path.join(repoRoot, "solution", "src", "WebResources", "klth_", "SegmentSankey");
  const ids = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".data.xml"))
    .map((name) => {
      const xml = fs.readFileSync(path.join(folder, name), "utf8");
      const match = /<WebResourceId>\{([0-9a-f-]+)\}<\/WebResourceId>/i.exec(xml);
      return match ? match[1].toLowerCase() : name;
    });
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate web resource ids");
});

test("the setup center environment variables exist, are optional, and carry no default", () => {
  SETUP_VARIABLES.forEach((name) => {
    const file = path.join(
      repoRoot,
      "solution",
      "src",
      "environmentvariabledefinitions",
      name,
      "environmentvariabledefinition.xml"
    );
    assert.ok(fs.existsSync(file), `missing environment variable definition ${name}`);
    const xml = fs.readFileSync(file, "utf8");
    assert.ok(xml.includes(`schemaname="${name}"`));
    assert.match(xml, /<type>100000000<\/type>/);
    assert.match(xml, /<isrequired>0<\/isrequired>/);
    assert.ok(
      !/<defaultvalue>/.test(xml),
      `${name} must not ship a default value`
    );
  });
});

test("the setup center variable names match the provisioning engine", () => {
  const engine = fs.readFileSync(
    path.join(repoRoot, "webresources", "segment-preview-provisioning.js"),
    "utf8"
  );
  SETUP_VARIABLES.forEach((name) => {
    assert.ok(engine.includes(`"${name}"`), `${name} is not used by the engine`);
  });
});
