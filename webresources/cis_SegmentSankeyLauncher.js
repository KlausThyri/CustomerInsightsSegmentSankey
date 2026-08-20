(function (global) {
  "use strict";

  const WEB_RESOURCE_NAME = "klth_/SegmentSankey/segment-sankey.html";
  const ICON_WEB_RESOURCE_NAME = "klth_/SegmentSankey/segment-sankey-icon.svg";
  const PANE_ID = "klth_segment_preview";
  const LEGACY_PANE_ID = "klth_segment_sankey";
  const SEGMENT_ENTITY_NAME = "msdynmkt_segmentdefinition";
  const MONITOR_INTERVAL_MS = 750;
  let activeFormContext = null;
  let monitoredSegmentId = "";
  let monitorHandle = null;
  let syncInProgress = false;
  let inactivePollCount = 0;
  let registeredFormContext = null;

  function normalizeId(id) {
    const value = String(id || "").replace(/[{}]/g, "");
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : "";
  }

  function getRecordId(primaryControl) {
    const directId = normalizeId(primaryControl);
    if (directId) {
      return directId;
    }

    const formId = normalizeId(primaryControl?.data?.entity?.getId?.());
    if (formId) {
      return formId;
    }

    const pageContext = Xrm.Utility.getPageContext?.();
    const pageContextId = normalizeId(pageContext?.input?.entityId);
    if (pageContextId) {
      return pageContextId;
    }

    const legacyFormId = normalizeId(Xrm.Page?.data?.entity?.getId?.());
    if (legacyFormId) {
      return legacyFormId;
    }

    try {
      return normalizeId(new URL(window.top.location.href).searchParams.get("id"));
    } catch (error) {
      console.log("Segment preview: Could not read the record ID from the page URL.", error);
      return "";
    }
  }

  function getFormRecordId(formContext) {
    return normalizeId(formContext?.data?.entity?.getId?.());
  }

  function getActivePage() {
    try {
      const url = new URL(window.top.location.href);
      const pageType = String(url.searchParams.get("pagetype") || "").toLowerCase();
      const entityName = String(url.searchParams.get("etn") || "").toLowerCase();
      const segmentId = normalizeId(url.searchParams.get("id"));
      if (pageType || entityName || segmentId) {
        return {
          isSegment:
            pageType === "entityrecord" &&
            entityName === SEGMENT_ENTITY_NAME &&
            Boolean(segmentId),
          segmentId: segmentId
        };
      }
    } catch (error) {
      console.log("Segment preview: Could not read the active page URL.", error);
    }

    const input = Xrm.Utility.getPageContext?.()?.input;
    const entityName = String(input?.entityName || "").toLowerCase();
    const segmentId = normalizeId(input?.entityId);
    return {
      isSegment:
        String(input?.pageType || "").toLowerCase() === "entityrecord" &&
        entityName === SEGMENT_ENTITY_NAME &&
        Boolean(segmentId),
      segmentId: segmentId
    };
  }

  function resolveFormContext(segmentId) {
    const candidates = [activeFormContext, Xrm.Page];
    return candidates.find(function (candidate) {
      return getFormRecordId(candidate) === segmentId;
    }) || null;
  }

  function getSegmentName(formContext) {
    const primaryName = formContext?.data?.entity?.getPrimaryAttributeValue?.();
    if (primaryName) {
      return primaryName;
    }

    return document.title
      .replace(/^Segment Definition: Information: /, "")
      .replace(/ - Dynamics 365$/, "") ||
      "Segment";
  }

  function handleFormDataLoad(executionContext) {
    const formContext =
      executionContext?.getFormContext?.() ||
      registeredFormContext;
    registerFormContext(formContext);
    synchronizePane().catch(function (error) {
      console.error("Segment preview: Form-load synchronization failed.", error);
    });
  }

  function registerFormContext(formContext) {
    if (!formContext || registeredFormContext === formContext) {
      return;
    }

    if (registeredFormContext?.data?.removeOnLoad) {
      registeredFormContext.data.removeOnLoad(handleFormDataLoad);
    }

    registeredFormContext = formContext;
    activeFormContext = formContext;
    registeredFormContext.data?.addOnLoad?.(handleFormDataLoad);
  }

  function unregisterFormContext() {
    if (registeredFormContext?.data?.removeOnLoad) {
      registeredFormContext.data.removeOnLoad(handleFormDataLoad);
    }
    registeredFormContext = null;
  }

  function stopPaneMonitor() {
    if (monitorHandle) {
      window.clearInterval(monitorHandle);
      monitorHandle = null;
    }
  }

  function startPaneMonitor() {
    if (monitorHandle) {
      return;
    }

    monitorHandle = window.setInterval(function () {
      synchronizePane().catch(function (error) {
        console.error("Segment preview: Pane synchronization failed.", error);
      });
    }, MONITOR_INTERVAL_MS);
  }

  async function synchronizePane() {
    if (syncInProgress) {
      return;
    }

    syncInProgress = true;
    try {
      const pane = Xrm.App.sidePanes.getPane(PANE_ID);
      if (!pane) {
        stopPaneMonitor();
        monitoredSegmentId = "";
        activeFormContext = null;
        unregisterFormContext();
        return;
      }

      const page = getActivePage();
      if (!page.isSegment) {
        inactivePollCount += 1;
        if (inactivePollCount < 2) {
          return;
        }

        await pane.close();
        stopPaneMonitor();
        monitoredSegmentId = "";
        activeFormContext = null;
        unregisterFormContext();
        return;
      }

      inactivePollCount = 0;
      const formContext = resolveFormContext(page.segmentId);
      if (!formContext) {
        return;
      }

      registerFormContext(formContext);
      if (page.segmentId === monitoredSegmentId) {
        return;
      }

      await pane.navigate({
        pageType: "webresource",
        webresourceName: WEB_RESOURCE_NAME,
        data: JSON.stringify({
          segmentId: page.segmentId,
          segmentName: getSegmentName(formContext)
        })
      });
      monitoredSegmentId = page.segmentId;
    } finally {
      syncInProgress = false;
    }
  }

  async function open(primaryControl) {
    const formContext = primaryControl;
    registerFormContext(formContext);
    const segmentId = getRecordId(formContext);
    if (!segmentId) {
      throw new Error("The active segment does not have a saved record ID.");
    }

    await saveCurrentSegment();

    const segmentName = getSegmentName(formContext);
    const legacyPane = Xrm.App.sidePanes.getPane(LEGACY_PANE_ID);
    if (legacyPane) {
      await legacyPane.close();
    }

    let pane = Xrm.App.sidePanes.getPane(PANE_ID);
    if (pane) {
      pane.title = "Segment preview";
    } else {
      pane = await Xrm.App.sidePanes.createPane({
        title: "Segment preview",
        paneId: PANE_ID,
        imageSrc: Xrm.Utility.getGlobalContext().getClientUrl()
          + "/WebResources/" + ICON_WEB_RESOURCE_NAME,
        canClose: true,
        width: 560,
        alwaysRender: true,
        keepBadgeOnSelect: false
      });
    }

    await pane.navigate({
      pageType: "webresource",
      webresourceName: WEB_RESOURCE_NAME,
      data: JSON.stringify({
        segmentId: segmentId,
        segmentName: segmentName
      })
    });
    monitoredSegmentId = segmentId;
    inactivePollCount = 0;
    startPaneMonitor();
  }

  async function saveCurrentSegment() {
    const page = getActivePage();
    const formContext = page.isSegment
      ? resolveFormContext(page.segmentId)
      : null;
    const data = formContext?.data;
    if (!data?.save) {
      throw new Error("The active segment form is not ready. Try again after it has loaded.");
    }

    registerFormContext(formContext);
    if (!data.getIsDirty || data.getIsDirty()) {
      await data.save();
    }
  }

  global.CISegmentSankey = Object.freeze({
    saveCurrentSegment: saveCurrentSegment,
    synchronizePane: synchronizePane,
    open: function (primaryControl) {
      return open(primaryControl).catch(function (error) {
        return Xrm.Navigation.openErrorDialog({
          message: error.message || "The segment preview could not be opened."
        });
      });
    }
  });
})(window);
