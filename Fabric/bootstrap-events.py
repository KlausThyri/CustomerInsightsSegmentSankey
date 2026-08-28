# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# # Customer Insights serving lakehouse bootstrap
#
# Registers exported Journeys events and selected Dataverse mirror tables as
# SQL-queryable OneLake shortcuts. Re-running the notebook is safe.

# CELL ********************

from datetime import datetime, timezone
import re

from notebookutils import mssparkutils
import requests

EVENT_SOURCE_ROOT = "Files/Customer Insights Journeys"
EVENT_SOURCE_CANDIDATES = [
    f"{EVENT_SOURCE_ROOT}/Files/Customer%20Insights%20Journeys",
    f"{EVENT_SOURCE_ROOT}/Files/Customer Insights Journeys",
    EVENT_SOURCE_ROOT,
    "Files",
]
EVENT_SCHEMA = "journeys"
DATAVERSE_SCHEMA = "dataverse"
WORKSPACE_ID = "<fabric-workspace-id>"
SERVING_LAKEHOUSE_ID = "<serving-lakehouse-id>"
DATAVERSE_LAKEHOUSE_ID = "<dataverse-mirror-lakehouse-id>"
SHORTCUTS_API = (
    f"https://api.fabric.microsoft.com/v1/workspaces/{WORKSPACE_ID}"
    f"/items/{SERVING_LAKEHOUSE_ID}/shortcuts"
)
SHORTCUT_API = SHORTCUTS_API + "?shortcutConflictPolicy=CreateOrOverwrite"
DATAVERSE_SHORTCUTS_API = (
    f"https://api.fabric.microsoft.com/v1/workspaces/{WORKSPACE_ID}"
    f"/items/{DATAVERSE_LAKEHOUSE_ID}/shortcuts?parentPath=Tables"
)
HAS_DATAVERSE_MIRROR = (
    DATAVERSE_LAKEHOUSE_ID
    and DATAVERSE_LAKEHOUSE_ID != "00000000-0000-0000-0000-000000000000"
)
METADATA_TABLES = {
    "GlobalOptionsetMetadata",
    "OptionsetMetadata",
    "StateMetadata",
    "StatusMetadata",
    "TargetMetadata",
}

fabric_token = mssparkutils.credentials.getToken(
    "https://api.fabric.microsoft.com"
)
headers = {
    "Authorization": f"Bearer {fabric_token}",
    "Content-Type": "application/json",
}
DIAGNOSTIC_PATH = "Files/_segment_preview/bootstrap-status.txt"


def write_diagnostic(message):
    try:
        mssparkutils.fs.mkdirs("Files/_segment_preview")
        mssparkutils.fs.put(
            DIAGNOSTIC_PATH,
            f"{datetime.now(timezone.utc).isoformat()} {message}",
            True,
        )
    except Exception as error:
        print(f"Could not write bootstrap diagnostic: {error}")


write_diagnostic("Starting Journeys event folder discovery")


CREATABLE_TARGET_ARMS = (
    "oneLake",
    "amazonS3",
    "adlsGen2",
    "googleCloudStorage",
    "s3Compatible",
    "dataverse",
    "azureBlobStorage",
    "oneDriveSharePoint",
)


def creatable_shortcut_target(target):
    if not isinstance(target, dict):
        return None
    populated_arms = [
        arm
        for arm in CREATABLE_TARGET_ARMS
        if isinstance(target.get(arm), dict) and target.get(arm)
    ]
    if len(populated_arms) != 1:
        return None
    arm = populated_arms[0]
    return {arm: target[arm]}


def list_serving_shortcuts(parent_path):
    shortcuts = {}
    unsupported = []
    request_url = SHORTCUTS_API
    request_params = {"parentPath": parent_path}
    try:
        while True:
            response = requests.get(
                request_url,
                headers=headers,
                params=request_params,
                timeout=60,
            )
            response.raise_for_status()
            page = response.json()
            for item in page.get("value", []):
                name = item.get("name")
                exact_parent = (
                    str(item.get("path", "")).strip("/").lower()
                    == parent_path.strip("/").lower()
                )
                if not name or not exact_parent:
                    continue
                create_target = creatable_shortcut_target(item.get("target"))
                if create_target:
                    shortcuts[name] = create_target
                else:
                    unsupported.append(name)
            request_url = page.get("continuationUri")
            request_params = None
            if not request_url:
                break
        if not shortcuts and unsupported:
            return {}, (
                "Serving shortcuts under "
                f"{parent_path} do not expose a supported writable target: "
                + ", ".join(sorted(unsupported))
            )
        return shortcuts, None
    except Exception as error:
        return {}, f"Could not list Serving shortcuts under {parent_path}: {error}"


def find_event_folders():
    inspected = []
    root_shortcuts, root_shortcut_error = list_serving_shortcuts("Files")
    for source_root in EVENT_SOURCE_CANDIDATES:
        if source_root == "Files" and root_shortcut_error:
            inspected.append(root_shortcut_error)
            continue
        try:
            items = mssparkutils.fs.ls(source_root)
        except Exception as error:
            inspected.append(f"{source_root}: {error}")
            continue

        event_folders = []
        for item in items:
            if not item.isDir:
                continue
            event_name = item.name.rstrip("/")
            if source_root == "Files" and event_name not in root_shortcuts:
                continue
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", event_name):
                continue
            try:
                mssparkutils.fs.ls(f"{source_root}/{event_name}/_delta_log")
                event_folders.append(
                    (
                        event_name,
                        source_root,
                        root_shortcuts[event_name]
                        if source_root == "Files"
                        else None,
                    )
                )
            except Exception:
                continue
        if event_folders:
            return event_folders, None
        inspected.append(f"{source_root}: no Delta event folders")

    return [], (
        "No Customer Insights - Journeys Delta event folders were found. "
        "Enable the Journeys export to Fabric and verify its shortcut. Inspected: "
        + "; ".join(inspected)
    )


event_results = []
event_folders, event_discovery_error = find_event_folders()
if event_discovery_error:
    event_results.append((None, None, "failed", event_discovery_error))
    write_diagnostic(event_discovery_error)
else:
    write_diagnostic(
        f"Discovered {len(event_folders)} Journeys Delta event folders under "
        f"{event_folders[0][1]}"
    )

for event_name, source_root, source_target in event_folders:
    try:
        response = requests.post(
            SHORTCUT_API,
            headers=headers,
            json={
                "path": f"Tables/{EVENT_SCHEMA}",
                "name": event_name,
                "target": source_target
                or {
                    "oneLake": {
                        "workspaceId": WORKSPACE_ID,
                        "itemId": SERVING_LAKEHOUSE_ID,
                        "path": f"{source_root}/{event_name}",
                    }
                },
            },
            timeout=60,
        )
        response.raise_for_status()
        event_results.append((event_name, event_name, "registered", None))
    except Exception as error:
        event_results.append((event_name, event_name, "failed", str(error)))

write_diagnostic(
    f"Registered {len(event_results)} Journeys event table shortcuts"
)

dataverse_results = []
if not HAS_DATAVERSE_MIRROR:
    source_shortcuts = []
else:
    try:
        source_shortcuts = []
        continuation_token = None
        while True:
            source_response = requests.get(
                DATAVERSE_SHORTCUTS_API,
                headers=headers,
                params=(
                    {"continuationToken": continuation_token}
                    if continuation_token
                    else None
                ),
                timeout=60,
            )
            source_response.raise_for_status()
            source_page = source_response.json()
            source_shortcuts.extend(source_page.get("value", []))
            continuation_token = source_page.get("continuationToken")
            if not continuation_token:
                break
    except Exception as error:
        source_shortcuts = []
        dataverse_results.append(
            (None, None, "failed", f"Could not list Dataverse shortcuts: {error}")
        )

for shortcut in source_shortcuts:
    table_name = shortcut.get("name")
    source_target = shortcut.get("target", {})
    target_type = source_target.get("type")
    dataverse_target = source_target.get("dataverse", {})
    if target_type != "Dataverse" or table_name in METADATA_TABLES:
        continue

    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", table_name or ""):
        dataverse_results.append(
            (table_name, None, "rejected", "Unsafe Dataverse table name")
        )
        continue

    try:
        response = requests.post(
            SHORTCUT_API,
            headers=headers,
            json={
                "path": f"Tables/{DATAVERSE_SCHEMA}",
                "name": table_name,
                "target": {
                    "dataverse": {
                        "connectionId": dataverse_target.get("connectionId"),
                        "deltaLakeFolder": dataverse_target.get("deltaLakeFolder"),
                        "environmentDomain": dataverse_target.get(
                            "environmentDomain"
                        ),
                        "tableName": table_name,
                    }
                },
            },
            timeout=60,
        )
        response.raise_for_status()
        dataverse_results.append(
            (table_name, table_name, "registered", None)
        )
    except Exception as error:
        dataverse_results.append(
            (table_name, table_name, "failed", str(error))
        )

write_diagnostic(
    f"Processed {len(dataverse_results)} Dataverse table shortcuts"
)

event_failures = sum(1 for result in event_results if result[2] == "failed")
dataverse_failures = sum(
    1 for result in dataverse_results if result[2] == "failed"
)
print("Journeys results:", event_results)
print("Dataverse results:", dataverse_results)
if event_failures or dataverse_failures:
    write_diagnostic(
        "Bootstrap completed with incomplete shortcuts: "
        f"{event_failures} Journeys event folder(s) and "
        f"{dataverse_failures} Dataverse shortcut(s) could not be registered"
    )
else:
    write_diagnostic("Bootstrap completed successfully")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
