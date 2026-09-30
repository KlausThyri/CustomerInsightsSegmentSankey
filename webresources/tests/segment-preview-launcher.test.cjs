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

test("launcher skips clean forms and conservatively saves without a dirty-state API", async () => {
  const recordId = "F2E4EEAE-4C5F-F111-A825-6045BDE0D602";
  let saves = 0;
  const formContext = {
    data: {
      entity: {
        getId: () => `{${recordId}}`,
        getPrimaryAttributeValue: () => "Clean segment"
      },
      getIsDirty: () => false,
      save: async () => {
        saves++;
      },
      addOnLoad() {},
      removeOnLoad() {}
    }
  };
  const Xrm = {
    Page: formContext,
    App: {
      sidePanes: {
        getPane: () => null
      }
    },
    Utility: {
      getPageContext: () => ({
        input: {
          pageType: "entityrecord",
          entityName: "msdynmkt_segmentdefinition",
          entityId: `{${recordId}}`
        }
      })
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
    document: { title: "Clean segment - Dynamics 365" },
    URL,
    console
  });
  vm.runInContext(fs.readFileSync(launcherPath, "utf8"), context, { filename: launcherPath });

  const result = await window.CISegmentSankey.saveCurrentSegment();

  assert.equal(saves, 0);
  assert.deepStrictEqual(
    { ...result },
    { saved: false, dirty: false, dirtyStateAvailable: true, durationMs: 0 }
  );

  delete formContext.data.getIsDirty;
  const conservativeResult = await window.CISegmentSankey.saveCurrentSegment();

  assert.equal(saves, 1);
  assert.deepStrictEqual(
    { ...conservativeResult },
    {
      saved: true,
      dirty: true,
      dirtyStateAvailable: false,
      durationMs: conservativeResult.durationMs
    }
  );
  assert.equal(Number.isFinite(conservativeResult.durationMs), true);
});

test("launcher uses the requested record when a published form is absent from the shell URL", async () => {
  const recordId = "F2E4EEAE-4C5F-F111-A825-6045BDE0D602";
  let saves = 0;
  let navigations = 0;
  const formContext = {
    data: {
      entity: {
        getId: () => `{${recordId}}`,
        getPrimaryAttributeValue: () => "Published segment"
      },
      getIsDirty: () => false,
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
    App: {
      sidePanes: {
        getPane: () => null,
        createPane: async () => pane
      }
    },
    Utility: {
      getPageContext: () => ({ input: {} }),
      getGlobalContext: () => ({
        getClientUrl: () => "https://contoso.crm4.dynamics.com"
      })
    }
  };
  const window = {
    top: {
      location: {
        href: "https://contoso.crm4.dynamics.com/main.aspx?appid=journeys"
      }
    },
    setInterval: () => 1,
    clearInterval() {}
  };
  const context = vm.createContext({
    window,
    Xrm,
    document: { title: "Published segment - Dynamics 365" },
    URL,
    console
  });
  vm.runInContext(fs.readFileSync(launcherPath, "utf8"), context, {
    filename: launcherPath
  });

  await window.CISegmentSankey.open(formContext);
  const refreshResult =
    await window.CISegmentSankey.saveCurrentSegment(recordId.toLowerCase());

  assert.equal(saves, 0);
  assert.equal(navigations, 1);
  assert.deepStrictEqual(
    { ...refreshResult },
    { saved: false, dirty: false, dirtyStateAvailable: true, durationMs: 0 }
  );
});

test("launcher accepts a clean read-only published form without a save API", async () => {
  const recordId = "F2E4EEAE-4C5F-F111-A825-6045BDE0D602";
  let navigations = 0;
  let readinessWaits = 0;
  const formContext = {
    data: {
      entity: {
        getId: () => `{${recordId}}`,
        getPrimaryAttributeValue: () => "Read-only published segment"
      },
      getIsDirty: () => false,
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
    App: {
      sidePanes: {
        getPane: () => null,
        createPane: async () => pane
      }
    },
    Utility: {
      getPageContext: () => ({ input: {} }),
      getGlobalContext: () => ({
        getClientUrl: () => "https://contoso.crm4.dynamics.com"
      })
    }
  };
  const window = {
    top: {
      location: {
        href: "https://contoso.crm4.dynamics.com/main.aspx?appid=journeys"
      }
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(resolve) {
      readinessWaits++;
      resolve();
    }
  };
  const context = vm.createContext({
    window,
    Xrm,
    document: { title: "Read-only published segment - Dynamics 365" },
    URL,
    console
  });
  vm.runInContext(fs.readFileSync(launcherPath, "utf8"), context, {
    filename: launcherPath
  });

  await window.CISegmentSankey.open(formContext);
  const refreshResult =
    await window.CISegmentSankey.saveCurrentSegment(recordId.toLowerCase());

  assert.equal(navigations, 1);
  assert.equal(readinessWaits, 0);
  assert.deepStrictEqual(
    { ...refreshResult },
    { saved: false, dirty: false, dirtyStateAvailable: true, durationMs: 0 }
  );
});

test("launcher accepts a dirty disabled form without a save API", async () => {
  const recordId = "F2E4EEAE-4C5F-F111-A825-6045BDE0D602";
  let readinessWaits = 0;
  const formContext = {
    data: {
      entity: {
        getId: () => `{${recordId}}`,
        getPrimaryAttributeValue: () => "Linked published segment"
      },
      getIsDirty: () => true,
      addOnLoad() {},
      removeOnLoad() {}
    },
    ui: {
      getFormType: () => 4
    }
  };
  const Xrm = {
    Page: formContext,
    App: {
      sidePanes: {
        getPane: () => null
      }
    },
    Utility: {
      getPageContext: () => ({ input: {} })
    }
  };
  const window = {
    top: {
      location: {
        href: "https://contoso.crm4.dynamics.com/main.aspx?appid=journeys"
      }
    },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(resolve) {
      readinessWaits++;
      resolve();
    }
  };
  const context = vm.createContext({
    window,
    Xrm,
    document: { title: "Linked published segment - Dynamics 365" },
    URL,
    console
  });
  vm.runInContext(fs.readFileSync(launcherPath, "utf8"), context, {
    filename: launcherPath
  });

  const result =
    await window.CISegmentSankey.saveCurrentSegment(recordId.toLowerCase());

  assert.equal(readinessWaits, 0);
  assert.deepStrictEqual(
    { ...result },
    {
      saved: false,
      dirty: true,
      dirtyStateAvailable: true,
      durationMs: 0,
      readOnly: true
    }
  );
});

test("launcher waits for a form that is still initializing after an early click", async () => {
  const recordId = "F2E4EEAE-4C5F-F111-A825-6045BDE0D602";
  let saves = 0;
  let readinessChecks = 0;
  const data = {
    entity: {
      getId: () => `{${recordId}}`,
      getPrimaryAttributeValue: () => "Initializing segment"
    },
    addOnLoad() {},
    removeOnLoad() {}
  };
  const formContext = { data };
  const pane = {
    async navigate() {}
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
      getGlobalContext: () => ({
        getClientUrl: () => "https://contoso.crm4.dynamics.com"
      })
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
    clearInterval() {},
    setTimeout(resolve) {
      readinessChecks++;
      data.getIsDirty = () => false;
      data.save = async () => {
        saves++;
      };
      resolve();
    }
  };
  const context = vm.createContext({
    window,
    Xrm,
    document: { title: "Initializing segment - Dynamics 365" },
    URL,
    console
  });
  vm.runInContext(fs.readFileSync(launcherPath, "utf8"), context, {
    filename: launcherPath
  });

  await window.CISegmentSankey.open(formContext);

  assert.equal(readinessChecks, 1);
  assert.equal(saves, 0);
});
