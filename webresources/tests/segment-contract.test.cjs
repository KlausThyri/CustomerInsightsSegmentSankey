"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..");

function read(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function propertyNames(source, className) {
  const match = new RegExp(
    `public sealed class ${className}[\\s\\S]*?\\n}`,
    "m"
  ).exec(source);
  assert.ok(match, `Could not find ${className}.`);
  return [...match[0].matchAll(/public [^{;=]+ ([A-Z][A-Za-z0-9_]*)\s*\{/g)]
    .map((item) => item[1])
    .filter((name) => name !== className);
}

function customApiParameter(apiName, folder, name) {
  return read(
    "solution",
    "src",
    "customapis",
    apiName,
    folder,
    name,
    `${folder === "customapirequestparameters"
      ? "customapirequestparameter"
      : "customapiresponseproperty"}.xml`
  );
}

test("Dataverse Custom API contracts expose the expected JSON boundary", () => {
  const countApi = read(
    "solution",
    "src",
    "customapis",
    "klth_GetSegmentFilterCounts",
    "customapi.xml"
  );
  const membersApi = read(
    "solution",
    "src",
    "customapis",
    "klth_GetSegmentMembers",
    "customapi.xml"
  );

  assert.match(countApi, /<customapi uniquename="klth_GetSegmentFilterCounts">/);
  assert.match(membersApi, /<customapi uniquename="klth_GetSegmentMembers">/);
  assert.match(
    customApiParameter(
      "klth_GetSegmentFilterCounts",
      "customapirequestparameters",
      "klth_segmentid"
    ),
    /<type>12<\/type>/
  );
  assert.match(
    customApiParameter(
      "klth_GetSegmentMembers",
      "customapirequestparameters",
      "klth_requestjson"
    ),
    /<type>10<\/type>/
  );
  assert.match(
    customApiParameter(
      "klth_GetSegmentMembers",
      "customapiresponseproperties",
      "klth_resultjson"
    ),
    /<type>10<\/type>/
  );
});

test("browser requests and Fabric DTOs use the same member field names", () => {
  const browser = read("webresources", "segment-members.html");
  const fabric = read("FabricApi", "SegmentMemberModels.cs.txt");
  const browserFields = [
    "evaluationToken",
    "stageOrder",
    "viewMode",
    "search",
    "filterField",
    "filterOperator",
    "filterValue",
    "sortField",
    "sortDirection",
    "pageSize",
    "continuationToken"
  ];
  const fabricFields = [
    "QueryToken",
    "StageOrder",
    "ViewMode",
    "Search",
    "FilterField",
    "FilterOperator",
    "FilterValue",
    "SortField",
    "SortDirection",
    "PageSize",
    "ContinuationToken"
  ];

  for (const field of browserFields) {
    assert.match(browser, new RegExp(`\\b${field}\\s*:`));
  }
  assert.deepEqual(propertyNames(fabric, "SegmentMemberRequest"), fabricFields);
  assert.match(browser, /klth_requestjson:\s*JSON\.stringify\(requestShape\(\)\)/);
});

test("count and member endpoints keep their response contracts distinct", () => {
  const program = read("FabricApi", "Program.cs.txt");
  const countModels = read("FabricApi", "SegmentCountModels.cs.txt");
  const memberModels = read("FabricApi", "SegmentMemberModels.cs.txt");
  const sankey = read("webresources", "segment-sankey.html");
  const members = read("webresources", "segment-members.html");

  assert.match(program, /"\/api\/segment-counts"/);
  assert.match(program, /"\/api\/segment-members"/);
  assert.deepEqual(
    propertyNames(countModels, "SegmentCountResponse"),
    [
      "Stages",
      "SourceTables",
      "GeneratedAt",
      "QueryToken",
      "AddedTables",
      "CatalogReady",
      "Diagnostics"
    ]
  );
  assert.deepEqual(
    propertyNames(memberModels, "SegmentMemberResponse"),
    ["ProfileEntity", "ProfileIds", "NextToken", "HasMore", "GeneratedAt"]
  );
  assert.match(sankey, /klth_GetSegmentFilterCounts/);
  assert.match(members, /klth_GetSegmentMembers/);
  assert.match(memberModels, /Intentionally exposes only[\s\S]+profile identifiers/);
  assert.doesNotMatch(memberModels, /public (string|Guid)[?]? (FullName|Email|Telephone)/);
});
