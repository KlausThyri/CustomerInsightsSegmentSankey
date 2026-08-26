/*!
 * Segment Preview - setup payload.
 *
 * GENERATED FILE - do not edit by hand.
 * Sources:    Fabric/bootstrap-events.py
 *             Fabric/bootstrap-events.platform.json
 *             Fabric/bootstrap-events.schedules.json
 * Regenerate: pwsh -File deployment/Update-SetupPayloadWebResource.ps1
 *
 * Carries the artefacts the browser Setup Center uploads on its own: the Fabric
 * bootstrap notebook definition and the API package descriptor (URL plus the
 * SHA-256 the browser verifies before it copies the package into the customer's
 * own storage account). No secret and no credential belongs in this file.
 */
(function (root, factory) {
  "use strict";
  var payload = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = payload;
  }
  if (root) {
    root.SegmentPreviewPayload = payload;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  return {
    "contentVersion": "1.1.0.24",
    "notebook": {
      "displayName": "Customer Insights Serving Bootstrap",
      "description": "Registers Journeys event folders and selected Dataverse mirror tables in one serving Lakehouse.",
      "format": "ipynb",
      "path": "notebook-content.ipynb",
      "platform": {
        "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        "metadata": {
          "type": "Notebook",
          "displayName": "Customer Insights Serving Bootstrap",
          "description": "Registers Journeys event folders and selected Dataverse mirror tables in one serving Lakehouse."
        },
        "config": {
          "version": "2.0",
          "logicalId": "00000000-0000-0000-0000-000000000000"
        }
      },
      "parameters": [
        "WORKSPACE_ID",
        "SERVING_LAKEHOUSE_ID",
        "DATAVERSE_LAKEHOUSE_ID"
      ],
      "schedule": {
        "enabled": true,
        "jobType": "Execute",
        "configuration": {
          "type": "Daily",
          "startDateTime": "2026-08-17T00:00:00",
          "endDateTime": "2030-12-31T00:00:00",
          "localTimeZoneId": "W. Europe Standard Time",
          "times": [
            "01:00"
          ]
        }
      },
      "content": {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
          "language_info": {
            "name": "python"
          },
          "kernelspec": {
            "name": "synapse_pyspark",
            "display_name": "Synapse PySpark",
            "language": "Python"
          },
          "kernel_info": {
            "name": "synapse_pyspark"
          }
        },
        "cells": [
          {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
              "# Customer Insights serving lakehouse bootstrap\n",
              "\n",
              "Registers exported Journeys events and selected Dataverse mirror tables as\n",
              "SQL-queryable OneLake shortcuts. Re-running the notebook is safe."
            ]
          },
          {
            "cell_type": "code",
            "execution_count": null,
            "metadata": {},
            "outputs": [],
            "source": [
              "from datetime import datetime, timezone\n",
              "import re\n",
              "\n",
              "from notebookutils import mssparkutils\n",
              "from pyspark.sql import functions as F\n",
              "import requests\n",
              "\n",
              "EVENT_SOURCE_ROOT = \"Files/Customer Insights Journeys\"\n",
              "EVENT_SCHEMA = \"journeys\"\n",
              "DATAVERSE_SCHEMA = \"dataverse\"\n",
              "WORKSPACE_ID = \"<fabric-workspace-id>\"\n",
              "SERVING_LAKEHOUSE_ID = \"<serving-lakehouse-id>\"\n",
              "DATAVERSE_LAKEHOUSE_ID = \"<dataverse-mirror-lakehouse-id>\"\n",
              "SHORTCUT_API = (\n",
              "    f\"https://api.fabric.microsoft.com/v1/workspaces/{WORKSPACE_ID}\"\n",
              "    f\"/items/{SERVING_LAKEHOUSE_ID}/shortcuts\"\n",
              "    \"?shortcutConflictPolicy=CreateOrOverwrite\"\n",
              ")\n",
              "DATAVERSE_SHORTCUTS_API = (\n",
              "    f\"https://api.fabric.microsoft.com/v1/workspaces/{WORKSPACE_ID}\"\n",
              "    f\"/items/{DATAVERSE_LAKEHOUSE_ID}/shortcuts?parentPath=Tables\"\n",
              ")\n",
              "HAS_DATAVERSE_MIRROR = (\n",
              "    DATAVERSE_LAKEHOUSE_ID\n",
              "    and DATAVERSE_LAKEHOUSE_ID != \"00000000-0000-0000-0000-000000000000\"\n",
              ")\n",
              "METADATA_TABLES = {\n",
              "    \"GlobalOptionsetMetadata\",\n",
              "    \"OptionsetMetadata\",\n",
              "    \"StateMetadata\",\n",
              "    \"StatusMetadata\",\n",
              "    \"TargetMetadata\",\n",
              "}\n",
              "\n",
              "spark.sql(f\"CREATE DATABASE IF NOT EXISTS `{EVENT_SCHEMA}`\")\n",
              "spark.sql(f\"CREATE DATABASE IF NOT EXISTS `{DATAVERSE_SCHEMA}`\")\n",
              "fabric_token = mssparkutils.credentials.getToken(\n",
              "    \"https://api.fabric.microsoft.com\"\n",
              ")\n",
              "headers = {\n",
              "    \"Authorization\": f\"Bearer {fabric_token}\",\n",
              "    \"Content-Type\": \"application/json\",\n",
              "}\n",
              "\n",
              "event_results = []\n",
              "for item in mssparkutils.fs.ls(EVENT_SOURCE_ROOT):\n",
              "    if not item.isDir:\n",
              "        continue\n",
              "\n",
              "    event_name = item.name.rstrip(\"/\")\n",
              "    if not re.fullmatch(r\"[A-Za-z][A-Za-z0-9_]*\", event_name):\n",
              "        event_results.append(\n",
              "            (event_name, None, \"rejected\", \"Unsafe event folder name\")\n",
              "        )\n",
              "        continue\n",
              "\n",
              "    delta_log = f\"{EVENT_SOURCE_ROOT}/{event_name}/_delta_log\"\n",
              "    try:\n",
              "        mssparkutils.fs.ls(delta_log)\n",
              "        response = requests.post(\n",
              "            SHORTCUT_API,\n",
              "            headers=headers,\n",
              "            json={\n",
              "                \"path\": f\"Tables/{EVENT_SCHEMA}\",\n",
              "                \"name\": event_name,\n",
              "                \"target\": {\n",
              "                    \"oneLake\": {\n",
              "                        \"workspaceId\": WORKSPACE_ID,\n",
              "                        \"itemId\": SERVING_LAKEHOUSE_ID,\n",
              "                        \"path\": f\"{EVENT_SOURCE_ROOT}/{event_name}\",\n",
              "                    }\n",
              "                },\n",
              "            },\n",
              "            timeout=60,\n",
              "        )\n",
              "        response.raise_for_status()\n",
              "        event_results.append((event_name, event_name, \"registered\", None))\n",
              "    except Exception as error:\n",
              "        event_results.append((event_name, event_name, \"failed\", str(error)))\n",
              "\n",
              "event_registry = spark.createDataFrame(\n",
              "    event_results,\n",
              "    \"event_name string, table_name string, status string, error string\",\n",
              ").withColumn(\"updated_at\", F.lit(datetime.now(timezone.utc)))\n",
              "\n",
              "event_registry.write.mode(\"overwrite\").option(\n",
              "    \"overwriteSchema\", \"true\"\n",
              ").saveAsTable(f\"{EVENT_SCHEMA}._event_registry\")\n",
              "\n",
              "dataverse_results = []\n",
              "if not HAS_DATAVERSE_MIRROR:\n",
              "    source_shortcuts = []\n",
              "else:\n",
              "    try:\n",
              "        source_shortcuts = []\n",
              "        continuation_token = None\n",
              "        while True:\n",
              "            source_response = requests.get(\n",
              "                DATAVERSE_SHORTCUTS_API,\n",
              "                headers=headers,\n",
              "                params=(\n",
              "                    {\"continuationToken\": continuation_token}\n",
              "                    if continuation_token\n",
              "                    else None\n",
              "                ),\n",
              "                timeout=60,\n",
              "            )\n",
              "            source_response.raise_for_status()\n",
              "            source_page = source_response.json()\n",
              "            source_shortcuts.extend(source_page.get(\"value\", []))\n",
              "            continuation_token = source_page.get(\"continuationToken\")\n",
              "            if not continuation_token:\n",
              "                break\n",
              "    except Exception as error:\n",
              "        source_shortcuts = []\n",
              "        dataverse_results.append(\n",
              "            (None, None, \"failed\", f\"Could not list Dataverse shortcuts: {error}\")\n",
              "        )\n",
              "\n",
              "for shortcut in source_shortcuts:\n",
              "    table_name = shortcut.get(\"name\")\n",
              "    target_type = shortcut.get(\"target\", {}).get(\"type\")\n",
              "    if target_type != \"Dataverse\" or table_name in METADATA_TABLES:\n",
              "        continue\n",
              "\n",
              "    if not re.fullmatch(r\"[A-Za-z][A-Za-z0-9_]*\", table_name or \"\"):\n",
              "        dataverse_results.append(\n",
              "            (table_name, None, \"rejected\", \"Unsafe Dataverse table name\")\n",
              "        )\n",
              "        continue\n",
              "\n",
              "    try:\n",
              "        response = requests.post(\n",
              "            SHORTCUT_API,\n",
              "            headers=headers,\n",
              "            json={\n",
              "                \"path\": f\"Tables/{DATAVERSE_SCHEMA}\",\n",
              "                \"name\": table_name,\n",
              "                \"target\": {\n",
              "                    \"oneLake\": {\n",
              "                        \"workspaceId\": WORKSPACE_ID,\n",
              "                        \"itemId\": DATAVERSE_LAKEHOUSE_ID,\n",
              "                        \"path\": f\"Tables/{table_name}\",\n",
              "                    }\n",
              "                },\n",
              "            },\n",
              "            timeout=60,\n",
              "        )\n",
              "        response.raise_for_status()\n",
              "        dataverse_results.append(\n",
              "            (table_name, table_name, \"registered\", None)\n",
              "        )\n",
              "    except Exception as error:\n",
              "        dataverse_results.append(\n",
              "            (table_name, table_name, \"failed\", str(error))\n",
              "        )\n",
              "\n",
              "dataverse_registry = spark.createDataFrame(\n",
              "    dataverse_results,\n",
              "    \"source_table string, table_name string, status string, error string\",\n",
              ").withColumn(\"updated_at\", F.lit(datetime.now(timezone.utc)))\n",
              "\n",
              "dataverse_registry.write.mode(\"overwrite\").option(\n",
              "    \"overwriteSchema\", \"true\"\n",
              ").saveAsTable(f\"{DATAVERSE_SCHEMA}._shortcut_registry\")\n",
              "\n",
              "event_failures = event_registry.filter(\"status = 'failed'\").count()\n",
              "dataverse_failures = dataverse_registry.filter(\"status = 'failed'\").count()\n",
              "display(event_registry.orderBy(\"event_name\"))\n",
              "display(dataverse_registry.orderBy(\"source_table\"))\n",
              "if event_failures or dataverse_failures:\n",
              "    raise RuntimeError(\n",
              "        f\"{event_failures} Journeys event folder(s) and \"\n",
              "        f\"{dataverse_failures} Dataverse shortcut(s) could not be registered\"\n",
              "    )"
            ]
          }
        ]
      }
    },
    "api": {
      "version": "1.1.0.24",
      "packageUrl": "https://github.com/KlausThyri/CustomerInsightsSegmentSankey/releases/download/v1.1.0.24/segment-preview-api-1.1.0.24.zip",
      "sha256": "b217e898946cf1998ea98eb6b2ae314d6b84cb01afa391061d5a1c80599ba3d6",
      "packageUrlTemplate": "https://github.com/KlausThyri/CustomerInsightsSegmentSankey/releases/download/v{version}/segment-preview-api-{version}.zip"
    }
  };
});
