(function (global) {
  "use strict";

  const WEB_RESOURCE_NAME = "klth_/SegmentSankey/segment-sankey.html";
  const ICON_WEB_RESOURCE_NAME = "klth_/SegmentSankey/segment-sankey-icon.svg";
  const PANE_ID = "klth_segment_preview";
  const LEGACY_PANE_ID = "klth_segment_sankey";
  const SEGMENT_ENTITY_NAME = "msdynmkt_segmentdefinition";
  const MONITOR_INTERVAL_MS = 750;
  const FORM_READY_RETRY_DELAY_MS = 250;
  const FORM_READY_MAX_ATTEMPTS = 20;
  let activeFormContext = null;
  let monitoredSegmentId = "";
  let monitorHandle = null;
  let syncInProgress = false;
  let inactivePollCount = 0;
  let registeredFormContext = null;
  let saveInProgress = null;
  let saveInProgressSegmentId = "";

  function normalizeId(id) {
    const value = String(id || "").replace(/[{}]/g, "");
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
      ? value.toLowerCase()
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

    await saveCurrentSegment(segmentId);

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

  async function saveCurrentSegment(requestedSegmentId) {
    const page = getActivePage();
    const normalizedRequestedId = normalizeId(requestedSegmentId);
    if (
      normalizedRequestedId &&
      page.isSegment &&
      page.segmentId !== normalizedRequestedId
    ) {
      throw new Error("The active segment changed before it could be refreshed.");
    }

    const segmentId =
      normalizedRequestedId ||
      (page.isSegment ? page.segmentId : "") ||
      getFormRecordId(activeFormContext);
    if (saveInProgress && saveInProgressSegmentId === segmentId) {
      return saveInProgress;
    }

    saveInProgressSegmentId = segmentId;
    saveInProgress = saveReadyForm(segmentId);
    try {
      return await saveInProgress;
    } finally {
      saveInProgress = null;
      saveInProgressSegmentId = "";
    }
  }

  async function saveReadyForm(segmentId) {
    for (let attempt = 0; attempt < FORM_READY_MAX_ATTEMPTS; attempt++) {
      const page = getActivePage();
      if (page.isSegment && page.segmentId !== segmentId) {
        throw new Error("The active segment changed before it could be refreshed.");
      }

      const formContext = resolveFormContext(segmentId);
      const data = formContext?.data;
      const formType = formContext?.ui?.getFormType?.();
      const isReadOnly = formType === 3 || formType === 4;
      const dirtyStateAvailable = typeof data?.getIsDirty === "function";
      const isDirty = dirtyStateAvailable ? data.getIsDirty() : true;
      const shouldSave = isDirty && !isReadOnly;
      const saveAvailable = typeof data?.save === "function";
      if (data && (!shouldSave || saveAvailable)) {
        registerFormContext(formContext);
        let durationMs = 0;
        if (shouldSave) {
          const startedAt = Date.now();
          await data.save();
          durationMs = Date.now() - startedAt;
        }
        const result = {
          saved: shouldSave,
          dirty: isDirty,
          dirtyStateAvailable: dirtyStateAvailable,
          durationMs: durationMs
        };
        if (isReadOnly) {
          result.readOnly = true;
        }
        return result;
      }

      await new Promise(function (resolve) {
        window.setTimeout(resolve, FORM_READY_RETRY_DELAY_MS);
      });
    }

    throw new Error(
      "The active segment form did not finish loading. Close and reopen the preview."
    );
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
