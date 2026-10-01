"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sankeyPath = path.join(__dirname, "..", "segment-sankey.html");
const membersPath = path.join(__dirname, "..", "segment-members.html");
const sankeyHtml = fs.readFileSync(sankeyPath, "utf8");
const membersHtml = fs.readFileSync(membersPath, "utf8");

function loadSplitter() {
  const match = /function splitBooleanExpression\(expression\) \{[\s\S]*?^      \}/m.exec(sankeyHtml);
  assert.ok(match, "splitBooleanExpression is missing");
  const context = {};
  vm.runInNewContext(`${match[0]}\nsplit = splitBooleanExpression;`, context);
  // The sandbox has its own Object and Array prototypes, so the result is
  // normalized before it is compared against plain host-realm literals.
  return (expression) => {
    const result = context.split(expression);
    return result === null ? null : JSON.parse(JSON.stringify(result));
  };
}

function loadPresentationSplitter() {
  const match = /function splitPresentationDetail\(expression\) \{[\s\S]*?^      \}/m.exec(sankeyHtml);
  assert.ok(match, "splitPresentationDetail is missing");
  const context = {};
  vm.runInNewContext(`${match[0]}\nsplit = splitPresentationDetail;`, context);
  return (expression) => {
    const result = context.split(expression);
    return result === null ? null : JSON.parse(JSON.stringify(result));
  };
}

function extractFunction(name) {
  const match = new RegExp(
    `(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^      \\}`,
    "m"
  ).exec(sankeyHtml);
  assert.ok(match, `${name} is missing`);
  return match[0];
}

function loadPresentationMetadataResolver(entityMetadata) {
  let calls = 0;
  const context = {
    Map,
    Promise,
    Array,
    Object,
    String,
    console,
    presentationMetadataCache: new Map(),
    getXrm() {
      return {
        Utility: {
          async getEntityMetadata() {
            calls += 1;
            return entityMetadata;
          }
        }
      };
    }
  };
  vm.runInNewContext(
    [
      extractFunction("getCollectionItem"),
      extractFunction("getLocalizedLabel"),
      extractFunction("loadPresentationMetadata"),
      "resolve = loadPresentationMetadata;"
    ].join("\n"),
    context
  );
  return {
    resolve: context.resolve,
    calls: () => calls
  };
}

function loadConsentPresentationResolver(names) {
  const calls = [];
  const context = {
    Map,
    Promise,
    String,
    console,
    presentationRecordCache: new Map(),
    getXrm() {
      return {
        WebApi: {
          async retrieveRecord(entityName, id) {
            calls.push(`${entityName}|${id}`);
            return { msdynmkt_name: names[entityName] || "" };
          }
        }
      };
    }
  };
  vm.runInNewContext(
    [
      extractFunction("loadPresentationRecord"),
      extractFunction("loadConsentPresentation"),
      "resolve = loadConsentPresentation;"
    ].join("\n"),
    context
  );
  return {
    resolve: context.resolve,
    calls: () => calls
  };
}

function loadInteractionPresentationResolver(names) {
  const calls = [];
  const context = {
    Map,
    Promise,
    String,
    console,
    presentationRecordCache: new Map(),
    getXrm() {
      return {
        WebApi: {
          async retrieveRecord(entityName, id) {
            calls.push(`${entityName}|${id}`);
            return { msdynmkt_name: names[entityName] || "" };
          }
        }
      };
    }
  };
  vm.runInNewContext(
    [
      extractFunction("loadPresentationRecord"),
      extractFunction("loadInteractionPresentation"),
      "resolve = loadInteractionPresentation;"
    ].join("\n"),
    context
  );
  return {
    resolve: context.resolve,
    calls: () => calls
  };
}

function loadSankeyLocaleResolver(globals) {
  const mapMatch = /const LANGUAGE_ID_LOCALES = \{[\s\S]*?^      \};/m.exec(sankeyHtml);
  assert.ok(mapMatch, "LANGUAGE_ID_LOCALES is missing");
  const functionMatch = /function resolveUserLocale\(\) \{[\s\S]*?^      \}/m.exec(sankeyHtml);
  assert.ok(functionMatch, "resolveUserLocale is missing in segment-sankey.html");
  const context = Object.assign({ Intl }, globals);
  vm.runInNewContext(
    `${mapMatch[0]}\n${functionMatch[0]}\nresult = resolveUserLocale();`,
    context
  );
  return context.result;
}

function loadMembersLocaleResolver(globals) {
  const functionMatch = /function resolveUserLocale\(\) \{[\s\S]*?^      \}/m.exec(membersHtml);
  assert.ok(functionMatch, "resolveUserLocale is missing in segment-members.html");
  const context = Object.assign({ Intl }, globals);
  vm.runInNewContext(`${functionMatch[0]}\nresult = resolveUserLocale();`, context);
  return context.result;
}

function xrmWithLanguage(languageId) {
  return {
    getXrm() {
      return {
        Utility: {
          getGlobalContext() {
            return { userSettings: { languageId } };
          }
        }
      };
    }
  };
}

test("number and date formats follow the Dynamics user language", () => {
  assert.strictEqual(loadSankeyLocaleResolver(xrmWithLanguage(1031)), "de-DE");
  assert.strictEqual(loadSankeyLocaleResolver(xrmWithLanguage(1033)), "en-US");
  assert.strictEqual(loadSankeyLocaleResolver(xrmWithLanguage(1036)), "fr-FR");
  assert.strictEqual(loadMembersLocaleResolver(xrmWithLanguage(1031)), "de-DE");
});

test("an unmapped language falls back to the browser locale and then to en-US", () => {
  assert.strictEqual(
    loadSankeyLocaleResolver(
      Object.assign(xrmWithLanguage(9999), { navigator: { language: "da-DK" } })
    ),
    "da-DK"
  );
  assert.strictEqual(loadSankeyLocaleResolver({}), "en-US");
  assert.strictEqual(loadMembersLocaleResolver({}), "en-US");
});

test("a host that throws while reading user settings still yields a usable locale", () => {
  const throwingHost = {
    getXrm() {
      return {
        Utility: {
          getGlobalContext() {
            throw new Error("global context unavailable");
          }
        }
      };
    }
  };
  assert.strictEqual(loadSankeyLocaleResolver(throwingHost), "en-US");
  assert.strictEqual(loadMembersLocaleResolver(throwingHost), "en-US");
});

test("no formatter is pinned to a hard-coded locale any more", () => {
  for (const html of [sankeyHtml, membersHtml]) {
    assert.ok(
      !/Intl\.(?:Number|DateTime)Format\(\s*"en-(?:US|GB)"/.test(html),
      "a formatter still hard-codes an English locale"
    );
  }
  assert.match(sankeyHtml, /const USER_LOCALE = resolveUserLocale\(\);/);
  assert.match(membersHtml, /new Intl\.NumberFormat\(resolveUserLocale\(\)\)/);
});

test("an OR expression is split into its individual branches", () => {
  const split = loadSplitter();
  assert.deepStrictEqual(
    split("(contact.city == 'Vienna' OR contact.city == 'Graz')"),
    { operator: "OR", parts: ["contact.city == 'Vienna'", "contact.city == 'Graz'"] }
  );
});

test("a real INTERSECT OR expression is split into its individual branches", () => {
  const split = loadSplitter();
  assert.deepStrictEqual(
    split("INTERSECT (firstname CONTAINS 'a' OR firstname CONTAINS 'a')"),
    { operator: "OR", parts: ["firstname CONTAINS 'a'", "firstname CONTAINS 'a'"] }
  );
});

test("an AND expression keeps its branches and reports the AND operator", () => {
  const split = loadSplitter();
  assert.deepStrictEqual(
    split("(ISNOTNULL(contact.emailaddress1) AND contact.statecode == 0)"),
    { operator: "AND", parts: ["ISNOTNULL(contact.emailaddress1)", "contact.statecode == 0"] }
  );
});

test("nested groups, lists and quoted literals stay attached to their branch", () => {
  const split = loadSplitter();
  assert.deepStrictEqual(
    split("((a == 1 AND b == 2) OR c IN [3, 4] OR d == 'O''Brien OR nothing')"),
    {
      operator: "OR",
      parts: ["(a == 1 AND b == 2)", "c IN [3, 4]", "d == 'O''Brien OR nothing'"]
    }
  );
});

test("expressions without a top-level operator are left untouched", () => {
  const split = loadSplitter();
  assert.strictEqual(split("(contact.city == 'Vienna')"), null);
  assert.strictEqual(split("ISNULL(contact.city)"), null);
  assert.strictEqual(split("NOT((a == 1 OR b == 2))"), null);
  assert.strictEqual(split(""), null);
  assert.strictEqual(split(undefined), null);
});

test("malformed or ambiguous expressions degrade to the plain single line", () => {
  const split = loadSplitter();
  assert.strictEqual(split("(a == 1) AND (b == 2)"), null, "two sibling groups are not one group");
  assert.strictEqual(split("(a == 1 OR b == 2"), null, "unbalanced parentheses");
  assert.strictEqual(split("(a == 'unterminated OR b == 2)"), null, "unterminated literal");
  assert.strictEqual(split("(a == 1 AND b == 2 OR c == 3)"), null, "mixed operators");
});

test("interaction details are split into a readable title and labeled facts", () => {
  const split = loadPresentationSplitter();
  assert.deepStrictEqual(
    split(
      "Email delivered\n" +
      "Scope: Contact interactions with a message template\n" +
      "Frequency: At least 1 occurrence\n" +
      "Period: Last 24 months"
    ),
    {
      title: "Email delivered",
      items: [
        { label: "Scope", value: "Contact interactions with a message template" },
        { label: "Frequency", value: "At least 1 occurrence" },
        { label: "Period", value: "Last 24 months" }
      ]
    }
  );
});

test("consent names are loaded asynchronously and cached by Dataverse record", async () => {
  const records = loadConsentPresentationResolver({
    msdynmkt_compliancesettings4: "Volksbank",
    msdynmkt_purpose: "Commercial",
    msdynmkt_topic: "Finanzieren"
  });
  const hint = {
    complianceProfileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    purposeId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    topicId: "cccccccc-cccc-cccc-cccc-cccccccccccc"
  };

  const first = await records.resolve(hint);
  const second = await records.resolve(hint);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), {
    complianceProfile: "Volksbank",
    purpose: "Commercial",
    topic: "Finanzieren"
  });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(second)),
    JSON.parse(JSON.stringify(first))
  );
  assert.strictEqual(records.calls().length, 3);
});

test("the filtered email name is loaded asynchronously and cached", async () => {
  const records = loadInteractionPresentationResolver({
    msdynmkt_email: "bank99 - Bestätigung Termin"
  });
  const hint = {
    messageTemplateId: "285c0765-7053-f111-bec6-6045bde0d602"
  };

  const first = await records.resolve(hint);
  const second = await records.resolve(hint);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), {
    email: "bank99 - Bestätigung Termin"
  });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(second)),
    JSON.parse(JSON.stringify(first))
  );
  assert.strictEqual(records.calls().length, 1);
});

test("filter metadata resolves official key-value choice options and is cached", async () => {
  const metadata = loadPresentationMetadataResolver({
    Attributes: {
      klth_risikoprofil: {
        DisplayName: "Risikoprofil",
        OptionSet: {
          700370003: "Hoch",
          700370004: "Sehr hoch"
        }
      }
    }
  });
  const hint = {
    entity: "contact",
    field: "klth_risikoprofil"
  };

  const first = await metadata.resolve(hint);
  const second = await metadata.resolve(hint);

  assert.strictEqual(first.fieldLabel, "Risikoprofil");
  assert.strictEqual(first.optionLabels.get("700370003"), "Hoch");
  assert.strictEqual(first.optionLabels.get("700370004"), "Sehr hoch");
  assert.strictEqual(second, first);
  assert.strictEqual(metadata.calls(), 1);
});

test("filter metadata resolves the Dynamics client attribute descriptor", async () => {
  const metadata = loadPresentationMetadataResolver({
    Attributes: {
      klth_risikoprofil: {
        _displayName: "Risikoprofil",
        _optionSet: null,
        attributeDescriptor: {
          DisplayName: "Risikoprofil",
          OptionSet: [
            { Label: "Risikobereit", Value: 700370003 },
            { Label: "Spekulativ", Value: 700370004 }
          ]
        }
      }
    }
  });

  const resolved = await metadata.resolve({
    entity: "contact",
    field: "klth_risikoprofil"
  });

  assert.strictEqual(resolved.fieldLabel, "Risikoprofil");
  assert.strictEqual(
    resolved.optionLabels.get("700370003"),
    "Risikobereit"
  );
  assert.strictEqual(
    resolved.optionLabels.get("700370004"),
    "Spekulativ"
  );
});

test("filter metadata enrichment runs only after the first diagram render", () => {
  const renderPosition = sankeyHtml.indexOf(
    "render(result, performance.now() - startedAt);"
  );
  const enrichmentPosition = sankeyHtml.lastIndexOf(
    "enrichStagePresentations(result, requestGeneration)"
  );

  assert.ok(renderPosition >= 0, "the final diagram render is missing");
  assert.ok(enrichmentPosition > renderPosition, "metadata blocks the first render");
  assert.ok(
    sankeyHtml.indexOf("loadConsentPresentation(presentation)") < enrichmentPosition,
    "consent enrichment is not part of the asynchronous enrichment pass"
  );
  assert.ok(
    sankeyHtml.indexOf("loadInteractionPresentation(presentation)") < enrichmentPosition,
    "email enrichment is not part of the asynchronous enrichment pass"
  );
});

test("business group labels override technical stage indexes", () => {
  assert.match(
    sankeyHtml,
    /const displayGroup = stage\.groupLabel \|\| String\(index\);/
  );
  assert.match(
    sankeyHtml,
    /"Group " \+ displayGroup/
  );
});

test("choice labels replace whole numeric values without changing field names", () => {
  const context = {};
  vm.runInNewContext(
    `${extractFunction("replaceChoiceValue")}\nreplace = replaceChoiceValue;`,
    context
  );

  assert.strictEqual(
    context.replace(
      "Email address 1 is one of 1, 10",
      "1",
      "Allowed"
    ),
    "Email address 1 is one of Allowed, 10"
  );
});

test("a referenced segment detail keeps its business name", () => {
  const split = loadPresentationSplitter();
  assert.deepStrictEqual(
    split("Newsletter 2026\nSource: Referenced segment"),
    {
      title: "Newsletter 2026",
      items: [{ label: "Source", value: "Referenced segment" }]
    }
  );
});

test("the expanded card renders branches and grows to fit them", () => {
  assert.match(sankeyHtml, /function createBranchList\(expression\)/);
  assert.match(sankeyHtml, /function createPresentationList\(expression\)/);
  assert.match(sankeyHtml, /expressionWrapper\.append\(expandedDetail \|\| expression\);/);
  assert.match(sankeyHtml, /if \(splitBooleanExpression\(stage\.detail\)\) \{\s*return true;/);
  assert.match(sankeyHtml, /"Any of " \+ split\.parts\.length \+ " conditions"/);
  assert.match(sankeyHtml, /"All of " \+ split\.parts\.length \+ " conditions"/);
  assert.match(sankeyHtml, /\.journey-card-branches-list \{/);
});
