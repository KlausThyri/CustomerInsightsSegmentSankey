"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const launcherPath = path.join(
  __dirname,
  "..",
  "cis_SegmentSankeyLauncher.js"
);

test("launcher matches uppercase Xrm record ids to lowercase page ids", async () => {
  const recordId = "F2E4EEAE-4C5F-F111-A825-6045BDE0D602";
  let saves = 0;
  let navigations = 0;
  let errors = 0;
  const formContext = {
    data: {
      entity: {
        getId: () => `{${recordId}}`,
        getPrimaryAttributeValue: () => "Segment TEST with intersect"
      },
      getIsDirty: () => true,
      save: async () => {
        saves++;
      },
      addOnLoad() {},
      removeOnLoad() {}
    }
  };
  const pane = {
    async navigate() {
      navigations++;
    }
  };
  const Xrm = {
    Page: formContext,
    App: {
      sidePanes: {
        getPane: () => null,
        createPane: async () => pane
      }
    },
    Utility: {
      getPageContext: () => ({
        input: {
          pageType: "entityrecord",
          entityName: "msdynmkt_segmentdefinition",
          entityId: `{${recordId}}`
        }
      }),
      getGlobalContext: () => ({ getClientUrl: () => "https://contoso.crm4.dynamics.com" })
    },
    Navigation: {
      openErrorDialog: async () => {
        errors++;
      }
    }
  };
  const window = {
    top: {
      location: {
        href:
          "https://contoso.crm4.dynamics.com/main.aspx?pagetype=entityrecord" +
          "&etn=msdynmkt_segmentdefinition&id=" +
          recordId.toLowerCase()
      }
    },
    setInterval: () => 1,
    clearInterval() {}
  };
  const context = vm.createContext({
    window,
    Xrm,
    document: { title: "Segment TEST with intersect - Dynamics 365" },
    URL,
    console
  });
  vm.runInContext(fs.readFileSync(launcherPath, "utf8"), context, { filename: launcherPath });

  await window.CISegmentSankey.open(formContext);

  assert.equal(errors, 0);
  assert.equal(saves, 1);
  assert.equal(navigations, 1);
});
