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
from pyspark.sql import functions as F
import requests

EVENT_SOURCE_ROOT = "Files/Customer Insights Journeys"
EVENT_SCHEMA = "journeys"
DATAVERSE_SCHEMA = "dataverse"
WORKSPACE_ID = "<fabric-workspace-id>"
SERVING_LAKEHOUSE_ID = "<serving-lakehouse-id>"
DATAVERSE_LAKEHOUSE_ID = "<dataverse-mirror-lakehouse-id>"
SHORTCUT_API = (
    f"https://api.fabric.microsoft.com/v1/workspaces/{WORKSPACE_ID}"
    f"/items/{SERVING_LAKEHOUSE_ID}/shortcuts"
    "?shortcutConflictPolicy=CreateOrOverwrite"
)
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

spark.sql(f"CREATE DATABASE IF NOT EXISTS `{EVENT_SCHEMA}`")
spark.sql(f"CREATE DATABASE IF NOT EXISTS `{DATAVERSE_SCHEMA}`")
fabric_token = mssparkutils.credentials.getToken(
    "https://api.fabric.microsoft.com"
)
headers = {
    "Authorization": f"Bearer {fabric_token}",
    "Content-Type": "application/json",
}

event_results = []
for item in mssparkutils.fs.ls(EVENT_SOURCE_ROOT):
    if not item.isDir:
        continue

    event_name = item.name.rstrip("/")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", event_name):
        event_results.append(
            (event_name, None, "rejected", "Unsafe event folder name")
        )
        continue

    delta_log = f"{EVENT_SOURCE_ROOT}/{event_name}/_delta_log"
    try:
        mssparkutils.fs.ls(delta_log)
        response = requests.post(
            SHORTCUT_API,
            headers=headers,
            json={
                "path": f"Tables/{EVENT_SCHEMA}",
                "name": event_name,
                "target": {
                    "oneLake": {
                        "workspaceId": WORKSPACE_ID,
                        "itemId": SERVING_LAKEHOUSE_ID,
                        "path": f"{EVENT_SOURCE_ROOT}/{event_name}",
                    }
                },
            },
            timeout=60,
        )
        response.raise_for_status()
        event_results.append((event_name, event_name, "registered", None))
    except Exception as error:
        event_results.append((event_name, event_name, "failed", str(error)))

event_registry = spark.createDataFrame(
    event_results,
    "event_name string, table_name string, status string, error string",
).withColumn("updated_at", F.lit(datetime.now(timezone.utc)))

event_registry.write.mode("overwrite").option(
    "overwriteSchema", "true"
).saveAsTable(f"{EVENT_SCHEMA}._event_registry")

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
    target_type = shortcut.get("target", {}).get("type")
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
                    "oneLake": {
                        "workspaceId": WORKSPACE_ID,
                        "itemId": DATAVERSE_LAKEHOUSE_ID,
                        "path": f"Tables/{table_name}",
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

dataverse_registry = spark.createDataFrame(
    dataverse_results,
    "source_table string, table_name string, status string, error string",
).withColumn("updated_at", F.lit(datetime.now(timezone.utc)))

dataverse_registry.write.mode("overwrite").option(
    "overwriteSchema", "true"
).saveAsTable(f"{DATAVERSE_SCHEMA}._shortcut_registry")

event_failures = event_registry.filter("status = 'failed'").count()
dataverse_failures = dataverse_registry.filter("status = 'failed'").count()
display(event_registry.orderBy("event_name"))
display(dataverse_registry.orderBy("source_table"))
if event_failures or dataverse_failures:
    raise RuntimeError(
        f"{event_failures} Journeys event folder(s) and "
        f"{dataverse_failures} Dataverse shortcut(s) could not be registered"
    )

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
