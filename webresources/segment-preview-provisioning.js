/*!
 * Segment Preview - browser provisioning engine.
 *
 * Runs inside the Dataverse "Segment Preview" setup web resource and drives the
 * one-button provisioning flow. Every network dependency is injected so the
 * whole engine can be unit tested and executed as a dry run.
 *
 * Bootstrap problem
 * -----------------
 * The Azure API that the finished installation talks to does not exist yet when
 * this code runs, so the browser cannot use the product's own API to provision
 * the product. Two bootstrap paths are supported:
 *
 *   direct  (primary, self-service) The browser itself calls Azure Resource
 *           Manager and the Fabric REST API with delegated tokens from a
 *           single-page application that the administrator registers once in
 *           their own tenant. "Connect this environment" on the setup page shows
 *           the exact redirect URI and permission list and opens the Microsoft
 *           Entra admin center, so the registration is guided from this page and
 *           needs no local tooling. The application is a public client with no
 *           secret, and every resource the run creates - the Entra app, the
 *           Azure resource group and Web App, the Fabric workspace and lakehouse,
 *           the Dataverse configuration - belongs to the customer's own tenant
 *           and subscription. One registration per Dataverse environment,
 *           because the redirect URI is this environment's URL.
 *
 *   broker  (optional) A hosted, multi-tenant confidential provisioning service
 *           with one fixed redirect URI of its own. This page opens a popup on
 *           the broker, the administrator signs in and consents there, and the
 *           broker performs the Azure and Fabric work with delegated permissions
 *           on behalf of that administrator. It exists for organisations that
 *           prefer not to register an application themselves; the resources it
 *           creates still belong to the customer's tenant and subscription.
 *
 * The engine reads its identifiers from Dataverse environment variables and
 * reports an explicit, non-guessing "manual" mode when they are absent. No
 * client id, broker URL, or secret is ever invented here, and no broker is
 * assumed to exist: when none is configured the setup center says so plainly.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SegmentPreviewProvisioning = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Version of the browser <-> broker contract implemented here. */
  var CONTRACT_VERSION = "1.1";

  /** postMessage envelope type used by the broker sign-in popup. */
  var BROKER_MESSAGE_TYPE = "segment-preview-broker-session";

  /** sessionStorage key holding the short-lived broker session for resume. */
  var BROKER_SESSION_KEY = "segment-preview.broker-session";

  /** Dataverse environment variables the setup center reads and writes. */
  var ENV = {
    mode: "klth_SetupProvisioningMode",
    brokerUrl: "klth_SetupBrokerUrl",
    brokerScope: "klth_SetupBrokerScope",
    clientId: "klth_SetupEntraClientId",
    apiPackageUrl: "klth_SetupApiPackageUrl",
    configuration: "klth_SetupConfiguration",
    apiUrl: "klth_FabricBehavioralApiUrl",
    apiKey: "klth_FabricBehavioralApiKey"
  };

  var ALL_ENV_NAMES = Object.keys(ENV).map(function (key) {
    return ENV[key];
  });

  var ARM_SCOPE = "https://management.azure.com/user_impersonation";
  var FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
  var ARM_ROOT = "https://management.azure.com";
  var FABRIC_ROOT = "https://api.fabric.microsoft.com/v1";
  var ARM_API_VERSION = "2021-04-01";

  /** api-version used for the Microsoft.Web control-plane calls. */
  var WEB_API_VERSION = "2022-03-01";

  /** Container in the customer's own storage account that holds the package. */
  var PACKAGE_CONTAINER = "segment-preview-api";

  /** App setting that makes App Service run the package from customer storage. */
  var RUN_FROM_PACKAGE_SETTING = "WEBSITE_RUN_FROM_PACKAGE";

  /** Makes App Service read that blob with its own identity instead of a SAS. */
  var PACKAGE_IDENTITY_SETTING = "WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID";

  var PACKAGE_VERSION_SETTING = "SEGMENT_PREVIEW_PACKAGE_VERSION";
  var PACKAGE_SHA_SETTING = "SEGMENT_PREVIEW_PACKAGE_SHA256";

  /** App setting the Web App stores its API key under. Read back when resuming. */
  var API_KEY_SETTING = "BEHAVIORAL_API_KEY";

  /**
   * How long the page waits for a restarted Web App to serve its own health
   * endpoint. Mounting the package blob and the propagation of the managed
   * identity role assignment can each take minutes, so the poll runs for about
   * five minutes before it gives up.
   */
  var HEALTH_ATTEMPTS = 60;
  var HEALTH_DELAY_MS = 5000;

  var EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

  var DEFAULT_REQUIRED_TABLES =
    "contact,msdynmkt_contactpointconsent4,msdynmkt_purpose,msdynmkt_topic";

  /**
   * Ordered provisioning steps. The ids are shared with the PowerShell
   * orchestrator and with the broker contract so progress can be correlated
   * across all three surfaces.
   */
  var STEPS = [
    { id: "preflight", name: "Validate configuration", phase: "Preflight" },
    { id: "consent", name: "Sign in and grant consent", phase: "Preflight", interactive: true },
    { id: "secret", name: "Generate the server-side API key", phase: "Preflight" },
    { id: "fabric-discovery", name: "Discover Fabric workspace and lakehouse", phase: "Fabric" },
    { id: "fabric-notebook", name: "Publish the serving bootstrap notebook", phase: "Fabric" },
    { id: "azure-infra", name: "Deploy the Azure infrastructure", phase: "Azure" },
    { id: "fabric-permissions", name: "Grant Fabric access to the managed identity", phase: "Fabric" },
    { id: "azure-app", name: "Deploy the Segment Preview API", phase: "Azure" },
    { id: "dataverse-config", name: "Write the Dataverse environment variables", phase: "Dataverse" },
    { id: "verify", name: "Verify the end-to-end setup", phase: "Verify" }
  ];

  /**
   * Interactive consent that Microsoft requires and that no automation can
   * remove. The setup center shows this list before anything is changed.
   */
  var CONSENT = [
    {
      id: "entra-sign-in",
      title: "Microsoft Entra sign-in and multi-factor authentication",
      role: "Deploying administrator",
      automatable: false,
      guidance:
        "The setup center opens a Microsoft sign-in window to obtain delegated Azure and Fabric permissions. Conditional access and MFA prompts cannot be suppressed."
    },
    {
      id: "broker-admin-consent",
      title: "Optional broker mode only: one-time tenant consent for a provisioning service",
      role: "Global Administrator or Privileged Role Administrator",
      automatable: false,
      guidance:
        "Applies only when this environment is pointed at an optional hosted provisioning service. The first sign-in in that popup shows the Microsoft consent screen for its multi-tenant application. Self-service installations do not use it: they register an application in your own tenant instead."
    },
    {
      id: "app-registration",
      title: "Register a single-page application in your own tenant",
      role: "Application Administrator or Global Administrator",
      automatable: false,
      guidance:
        "'Connect this environment' on this page shows the exact redirect URI and permission list, opens the Microsoft Entra admin center, and stores the resulting client id in this environment. The application is a public client with no secret, it stays in your tenant, and you may delete it once setup is finished. One registration is required per Dataverse environment because the redirect URI is this environment's URL."
    },
    {
      id: "app-admin-consent",
      title: "Tenant admin consent for that application",
      role: "Global Administrator or Privileged Role Administrator",
      automatable: false,
      guidance:
        "The Fabric (Power BI Service) delegated permissions require admin consent. Press 'Grant admin consent' on this page or in the Entra admin center; the consent screen opens in the browser."
    },
    {
      id: "azure-rbac",
      title: "Azure permissions on the target subscription",
      role: "Subscription Owner or Contributor + User Access Administrator",
      automatable: false,
      guidance:
        "The signed-in administrator must be able to create a resource group, an App Service plan, a Web App, and Application Insights."
    },
    {
      id: "fabric-service-principal-apis",
      title: 'Fabric tenant setting "Service principals can use Fabric APIs"',
      role: "Fabric tenant administrator",
      automatable: false,
      guidance:
        "Enable the setting in the Fabric admin portal and add the Web App managed identity to the allowed security group. Microsoft exposes no public write API for tenant settings."
    },
    {
      id: "fabric-capacity",
      title: "Fabric capacity assignment for the workspace",
      role: "Fabric capacity administrator",
      automatable: true,
      guidance:
        "Provide a capacity id to let the setup center create the workspace. Purchasing or resuming a capacity remains a commercial decision."
    },
    {
      id: "fabric-dataverse-connection",
      title: "Fabric cloud connection to the Dataverse environment",
      role: "Fabric workspace administrator",
      automatable: false,
      guidance:
        "The Dataverse connection is created through an interactive OAuth dialog in the Fabric portal. The setup center discovers an existing connection and reports precisely when none exists."
    },
    {
      id: "dataverse-fabric-link",
      title: 'Dataverse "Link to Microsoft Fabric" and the Journeys export',
      role: "Power Platform / Customer Insights administrator",
      automatable: false,
      guidance:
        "The Dataverse mirror and the Customer Insights - Journeys export to Fabric are enabled in the maker and Customer Insights portals. Neither has a documented public provisioning API."
    },
    {
      id: "dataverse-sysadmin",
      title: "System Administrator role in this Dataverse environment",
      role: "Dataverse system administrator",
      automatable: false,
      guidance:
        "Writing environment variable values and running the setup Custom API require the System Administrator role for the signed-in user."
    }
  ];

  // ---------------------------------------------------------------- helpers

  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === "";
  }

  function trimOrNull(value) {
    return isBlank(value) ? null : String(value).trim();
  }

  var GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

  function isGuid(value) {
    var text = trimOrNull(value);
    return Boolean(text) && GUID_PATTERN.test(text) && text.toLowerCase() !== EMPTY_GUID;
  }

  function isWebAppName(value) {
    var text = trimOrNull(value);
    if (!text) return false;
    return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(text) && text.indexOf("--") === -1;
  }

  function isResourceGroupName(value) {
    var text = trimOrNull(value);
    if (!text) return false;
    return text.length <= 90 && /^[-\w._()]+[^.]$/.test(text);
  }

  /** True for an absolute https URL. The broker endpoint must never be plain http. */
  function isHttpsUrl(value) {
    var text = trimOrNull(value);
    if (!text) return false;
    try {
      return new URL(text).protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  /** True for a lower/upper case 64 character SHA-256 hex digest. */
  function isSha256(value) {
    var text = trimOrNull(value);
    if (!text) return false;
    return /^[0-9a-fA-F]{64}$/.test(text);
  }

  /**
   * Origin of the broker endpoint. Every popup message is checked against this
   * value, so a malformed URL must yield null rather than a permissive default.
   */
  function brokerOrigin(value) {
    var text = trimOrNull(value);
    if (!text) return null;
    try {
      var parsed = new URL(text);
      return parsed.protocol === "https:" ? parsed.origin : null;
    } catch (error) {
      return null;
    }
  }

  function environmentDomain(url) {
    var text = trimOrNull(url);
    if (!text) return null;
    if (!/^https?:\/\//i.test(text)) text = "https://" + text;
    var parsed;
    try {
      parsed = new URL(text);
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  }

  function apiBaseUrl(hostName) {
    var text = trimOrNull(hostName);
    if (!text) return null;
    if (!/^https?:\/\//i.test(text)) text = "https://" + text;
    var parsed;
    try {
      parsed = new URL(text);
    } catch (error) {
      return null;
    }
    return "https://" + parsed.host + "/api/";
  }

  function fabricSqlServer(connectionString) {
    var text = trimOrNull(connectionString);
    if (!text) return null;
    var match = /(?:Data Source|Server|Address|Addr|Network Address)\s*=\s*([^;]+)/i.exec(text);
    var value = match ? match[1] : text;
    value = value.trim().replace(/^tcp:/i, "");
    var comma = value.indexOf(",");
    if (comma > -1) value = value.slice(0, comma);
    return value.trim().toLowerCase() || null;
  }

  function requiredTables(value) {
    var source = isBlank(value) ? DEFAULT_REQUIRED_TABLES : String(value);
    var seen = Object.create(null);
    var result = [];
    source.split(",").forEach(function (item) {
      var name = item.trim().toLowerCase();
      if (!name) return;
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        throw new Error("'" + item.trim() + "' is not a valid Dataverse table name.");
      }
      if (!seen[name]) {
        seen[name] = true;
        result.push(name);
      }
    });
    return result.sort();
  }

  function delay(milliseconds, timer) {
    var schedule = timer || setTimeout;
    return new Promise(function (resolve) {
      schedule(resolve, milliseconds);
    });
  }

  // ---------------------------------------------------------------- secrets

  /**
   * Generates a 48-byte URL-safe API key with the browser CSPRNG. The alphabet
   * deliberately excludes "+", "/", and "=" so the value is safe in HTTP
   * headers and in ARM template parameters.
   */
  function generateApiKey(cryptoImpl, byteCount) {
    var provider = cryptoImpl || (typeof crypto !== "undefined" ? crypto : null);
    if (!provider || typeof provider.getRandomValues !== "function") {
      throw new Error("A cryptographically secure random number generator is not available.");
    }
    var bytes = new Uint8Array(byteCount || 48);
    provider.getRandomValues(bytes);
    var binary = "";
    for (var index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
    var base64 =
      typeof btoa === "function"
        ? btoa(binary)
        : Buffer.from(bytes).toString("base64");
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Lower case hex of an ArrayBuffer or byte array. */
  function toHex(buffer) {
    return Array.prototype.map
      .call(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), function (byte) {
        return byte.toString(16).padStart(2, "0");
      })
      .join("");
  }

  /** Short, non-reversible identifier used to display and compare a secret. */
  async function fingerprint(value, cryptoImpl) {
    if (isBlank(value)) return "sha256:none";
    var provider = cryptoImpl || (typeof crypto !== "undefined" ? crypto : null);
    if (!provider || !provider.subtle) {
      throw new Error("SubtleCrypto is not available in this context.");
    }
    var data = new TextEncoder().encode(String(value));
    var digest = await provider.subtle.digest("SHA-256", data);
    return "sha256:" + toHex(digest).slice(0, 16);
  }

  // ------------------------------------------------------ solution payload

  /**
   * Base64 of a UTF-8 string. The Fabric item-definition API expects
   * "InlineBase64" parts, so the browser has to encode the notebook itself.
   */
  function toBase64(text) {
    var value = String(text === undefined || text === null ? "" : text);
    if (typeof TextEncoder !== "undefined" && typeof btoa === "function") {
      var bytes = new TextEncoder().encode(value);
      var binary = "";
      for (var index = 0; index < bytes.length; index++) {
        binary += String.fromCharCode(bytes[index]);
      }
      return btoa(binary);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "utf8").toString("base64");
    }
    throw new Error("No base64 encoder is available in this context.");
  }

  /** Constant values may never terminate the Python string literal. */
  var NOTEBOOK_VALUE_PATTERN = /^[A-Za-z0-9 ._/-]+$/;

  /**
   * Rewrites the top-level `NAME = "value"` constants of the bootstrap
   * notebook. Mirrors Set-SegmentPreviewNotebookParameter of the PowerShell
   * module so both surfaces publish an identical notebook.
   */
  function applyNotebookParameters(content, parameters) {
    var values = parameters || {};
    var names = Object.keys(values);
    var applied = [];
    var missing = [];
    var clone = JSON.parse(JSON.stringify(content || {}));
    var cells = Array.isArray(clone.cells) ? clone.cells : [];

    names.forEach(function (name) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new Error("'" + name + "' is not a valid notebook constant name.");
      }
      var value = String(values[name] === undefined || values[name] === null ? "" : values[name]);
      if (!NOTEBOOK_VALUE_PATTERN.test(value)) {
        throw new Error("The value for the notebook constant '" + name + "' contains unsupported characters.");
      }
      var pattern = new RegExp("^(" + name + "\\s*=\\s*)\"[^\"]*\"");
      var hit = false;
      cells.forEach(function (cell) {
        if (cell.cell_type !== "code" || !Array.isArray(cell.source)) return;
        cell.source = cell.source.map(function (line) {
          if (!pattern.test(line)) return line;
          hit = true;
          return line.replace(pattern, '$1"' + value + '"');
        });
      });
      (hit ? applied : missing).push(name);
    });

    return { content: clone, applied: applied, missing: missing };
  }

  /**
   * Produces the Fabric item definition for the bootstrap notebook that ships
   * inside the managed solution. Everything happens in the browser: no file is
   * read from disk and no packaging tool is involved.
   */
  function buildNotebookDefinition(notebook, parameters) {
    if (!notebook || !notebook.content) {
      throw new Error("The setup payload does not contain the bootstrap notebook.");
    }
    var expected = notebook.parameters || [];
    var supplied = parameters || {};
    var absent = expected.filter(function (name) {
      return isBlank(supplied[name]);
    });
    if (absent.length) {
      throw new Error("The bootstrap notebook needs: " + absent.join(", ") + ".");
    }
    var result = applyNotebookParameters(notebook.content, supplied);
    if (result.missing.length) {
      throw new Error("The bootstrap notebook does not declare: " + result.missing.join(", ") + ".");
    }
    var parts = [
      {
        path: notebook.path || "notebook-content.ipynb",
        payload: toBase64(JSON.stringify(result.content)),
        payloadType: "InlineBase64"
      }
    ];
    if (notebook.platform) {
      parts.push({
        path: ".platform",
        payload: toBase64(JSON.stringify(notebook.platform)),
        payloadType: "InlineBase64"
      });
    }
    return {
      format: notebook.format || "ipynb",
      parts: parts
    };
  }

  /**
   * Reads the API package override. The value carries the https URL and the
   * SHA-256 digest of the exact asset, separated by whitespace, because a URL
   * without a digest cannot be verified and must not be trusted.
   */
  function parseApiPackageSetting(value) {
    var text = trimOrNull(value);
    if (!text) return { url: null, sha256: null };
    var parts = text.split(/[\s,;|]+/).filter(function (item) {
      return item.length > 0;
    });
    var url = null;
    var sha = null;
    parts.forEach(function (part) {
      if (isSha256(part)) sha = part.toLowerCase();
      else if (!url) url = part;
    });
    return { url: url, sha256: sha };
  }

  /**
   * Resolves the published API package the installation copies into the
   * customer's own storage. A URL is only usable together with the SHA-256 it
   * was published with: without the digest the browser cannot prove that the
   * bytes it fetched are the bytes the maintainer released, so an unverifiable
   * URL is treated as "not configured" rather than trusted.
   */
  function resolveApiPackage(payload, override) {
    var api = (payload && payload.api) || {};
    var version = api.version || (payload && payload.contentVersion) || null;
    var parsed = parseApiPackageSetting(override);
    var usingOverride = Boolean(parsed.url);
    var candidate = usingOverride ? parsed.url : api.packageUrl;
    var digest = usingOverride ? parsed.sha256 : api.sha256;
    var source = usingOverride ? ENV.apiPackageUrl : "payload";
    var template = api.packageUrlTemplate || null;

    function unusable(hint) {
      return {
        configured: false,
        url: null,
        version: version,
        sha256: null,
        source: usingOverride ? source : null,
        template: template,
        hint: hint
      };
    }

    if (isBlank(candidate)) {
      return unusable(
        "No API package is published for this solution version yet, so the installation cannot deploy the API. " +
          "The maintainer stamps the release asset" +
          (template && version ? " " + template.replace(/\{version\}/g, version) : "") +
          " and its SHA-256 into the solution. You can also store the https URL of your own verified copy in " +
          ENV.apiPackageUrl +
          " on this page and install again."
      );
    }
    if (!isHttpsUrl(candidate)) {
      return unusable(
        "The configured API package URL is not an absolute https address. Correct " +
          ENV.apiPackageUrl +
          " on this page."
      );
    }
    if (!isSha256(digest)) {
      return unusable(
        "The API package URL has no SHA-256 digest, so the download cannot be verified and is refused. " +
          "Enter the URL together with the SHA-256 of the exact asset" +
          (usingOverride ? ", or clear " + ENV.apiPackageUrl + " to use the package that ships with this solution" : "") +
          "."
      );
    }
    return {
      configured: true,
      url: String(candidate).trim(),
      version: version,
      sha256: String(digest).trim().toLowerCase(),
      source: source,
      template: template,
      hint: null
    };
  }

  /**
   * Immutable blob name. Version and digest are part of the name, so a new
   * release lands beside the old one and redeploying the same release is a
   * no-op instead of an overwrite.
   */
  function packageBlobName(pkg) {
    var version = String((pkg && pkg.version) || "0")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 40);
    var digest = String((pkg && pkg.sha256) || "").slice(0, 16);
    return "api-" + version + "-" + digest + ".zip";
  }

  /**
   * Steps that run again on every attempt. `preflight` and `verify` are pure
   * checks; `secret` has to run so a resumed installation either recovers the
   * key an earlier run stored or generates a new one, because every later step
   * needs the key in memory.
   */
  var ALWAYS_RUN = ["preflight", "consent", "secret", "verify"];

  /** Remedial action the setup Custom API offers for the Fabric shortcuts. */
  var PROVISION_SHORTCUTS_ACTION = "provision-shortcuts";

  /**
   * True when the reported setup status still offers to install missing
   * Dataverse shortcuts in Fabric. The shortcuts themselves are created by the
   * Web App's own managed identity behind the Custom API, so the browser needs
   * no Fabric write permission of its own to ask for them.
   */
  function needsShortcutProvisioning(status) {
    var components = (status && status.components) || [];
    if (!Array.isArray(components)) return false;
    return components.some(function (component) {
      return component && component.action === PROVISION_SHORTCUTS_ACTION;
    });
  }

  /** A setup response is only usable as a status when it carries components. */
  function hasStatusComponents(status) {
    return Boolean(status && Array.isArray(status.components) && status.components.length);
  }

  // ------------------------------------------------------------ configuration

  function normalizeMode(value) {
    var text = (trimOrNull(value) || "").toLowerCase();
    if (text === "broker" || text === "direct" || text === "manual") return text;
    return null;
  }

  /**
   * Decides which bootstrap path is usable with the identifiers this environment
   * actually holds. Never guesses a client id or endpoint.
   *
   * The primary path is `direct`: an application registered in the customer's own
   * tenant, whose redirect URI is this very page. Every resource it creates stays
   * in the customer's tenant and subscription. `broker` is optional: it points the
   * page at a hosted provisioning service with its own fixed redirect URI, for
   * organisations that prefer not to register an application themselves. When both
   * are configured `direct` wins unless the environment explicitly asks for
   * `broker`.
   */
  function resolveMode(settings) {
    var input = settings || {};
    var requested = normalizeMode(input[ENV.mode]);
    var brokerUrl = trimOrNull(input[ENV.brokerUrl]);
    var brokerScope = trimOrNull(input[ENV.brokerScope]);
    var clientId = trimOrNull(input[ENV.clientId]);

    var brokerReady = isHttpsUrl(brokerUrl);
    var directReady = isGuid(clientId);

    var blockers = [];
    if (!directReady) {
      blockers.push({
        id: "client-id-not-configured",
        message:
          "This environment is not connected yet. Use 'Connect this environment' on this page: it shows the exact redirect URI and permissions, opens the Microsoft Entra admin center so you can register a single-page application in your own tenant, and stores its Application (client) ID in " +
          ENV.clientId +
          ". Everything the installation creates stays in your tenant and your subscription.",
        owner: "administrator",
        resolvable: "in-page",
        optional: brokerReady
      });
    }
    if (!brokerReady) {
      blockers.push({
        id: "broker-not-configured",
        message:
          "Optional: this environment is not pointed at a hosted provisioning service. Only organisations that prefer not to register an application of their own need one; paste its HTTPS address into " +
          ENV.brokerUrl +
          " under 'Advanced'. Self-service installation does not require it.",
        owner: "publisher",
        resolvable: "in-page",
        optional: true
      });
    }

    var mode = "manual";
    var reason;
    if (requested === "broker" && brokerReady) {
      mode = "broker";
    } else if (requested === "direct" && directReady) {
      mode = "direct";
    } else if (requested === "manual") {
      mode = "manual";
      reason = ENV.mode + " is set to 'manual'.";
    } else if (!requested && directReady) {
      mode = "direct";
    } else if (!requested && brokerReady) {
      mode = "broker";
    }

    if (mode === "manual" && !reason) {
      reason = requested
        ? "The requested mode '" + requested + "' is not configured completely."
        : "This environment is not connected yet.";
    }

    return {
      mode: mode,
      requested: requested,
      automated: mode !== "manual",
      brokerReady: brokerReady,
      directReady: directReady,
      brokerUrl: brokerUrl,
      brokerScope: brokerScope,
      brokerOrigin: brokerOrigin(brokerUrl),
      clientId: clientId,
      reason: reason || null,
      blockers: mode === "manual" ? blockers : []
    };
  }

  /** Reads the persisted target configuration; tolerates corrupt JSON. */
  function parseConfiguration(json) {
    if (isBlank(json)) return {};
    try {
      var parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  var TARGET_KEYS = [
    "subscriptionId",
    "resourceGroup",
    "location",
    "webAppName",
    "fabricWorkspaceId",
    "fabricWorkspaceName",
    "fabricCapacityId",
    "fabricServingLakehouseId",
    "fabricServingLakehouseName",
    "fabricDataverseLakehouseId",
    "fabricDataverseConnectionId",
    "fabricDataverseDeltaFolder",
    "requiredDataverseTables"
  ];

  var TARGET_DEFAULTS = {
    location: "westeurope",
    fabricServingLakehouseName: "SegmentPreviewServing",
    fabricDataverseDeltaFolder: "deltalake",
    requiredDataverseTables: DEFAULT_REQUIRED_TABLES
  };

  /** Later sources win. Blank values and unfilled <placeholders> are ignored. */
  function mergeConfiguration() {
    var result = {};
    Object.keys(TARGET_DEFAULTS).forEach(function (key) {
      result[key] = TARGET_DEFAULTS[key];
    });
    for (var index = 0; index < arguments.length; index++) {
      var source = arguments[index];
      if (!source || typeof source !== "object") continue;
      TARGET_KEYS.forEach(function (key) {
        var value = source[key];
        if (isBlank(value)) return;
        var text = String(value).trim();
        if (/^<.*>$/.test(text)) return;
        result[key] = text;
      });
    }
    return result;
  }

  function shortHash(text) {
    var value = 2166136261;
    String(text || "").toLowerCase().split("").forEach(function (character) {
      value ^= character.charCodeAt(0);
      value = Math.imul(value, 16777619);
    });
    return (value >>> 0).toString(36).slice(0, 6);
  }

  function applyAutomaticTarget(target) {
    var result = mergeConfiguration(target);
    if (isGuid(result.subscriptionId) && isResourceGroupName(result.resourceGroup)) {
      if (isBlank(result.webAppName)) {
        result.webAppName =
          "segment-preview-" +
          result.subscriptionId.substring(0, 8).toLowerCase() +
          "-" +
          shortHash(result.resourceGroup);
      }
      if (isBlank(result.fabricWorkspaceName)) {
        result.fabricWorkspaceName = result.resourceGroup + " Segment Preview";
      }
    }
    return result;
  }

  /**
   * Non-secret facts a completed step discovered. They are persisted so a
   * resumed run has the same knowledge as a fresh one; without them a skipped
   * step would leave the later steps working with nulls.
   */
  var FACT_KEYS = [
    "workspaceId",
    "workspaceName",
    "servingLakehouseId",
    "servingLakehouseName",
    "fabricSqlServer",
    "fabricSqlDatabase",
    "dataverseConnectionId",
    "notebookId",
    "apiBaseUrl",
    "principalId",
    "packageUrl",
    "packageVersion",
    "packageSha256",
    "packageBlobUrl"
  ];

  /** Never write these to Dataverse, whatever a caller hands over. */
  var SECRET_KEYS = ["apiKey", "behavioralApiKey", "sasToken", "accountKey", "accessToken"];

  function stripSecrets(record) {
    if (!record || typeof record !== "object") return {};
    var clean = {};
    Object.keys(record).forEach(function (key) {
      if (SECRET_KEYS.indexOf(key) > -1) return;
      if (/key|secret|token|password|sas/i.test(key) && key !== "apiKeyFingerprint") return;
      clean[key] = record[key];
    });
    return clean;
  }

  /** Reduces a run context to the durable, non-secret facts. */
  function collectFacts(context, previous) {
    var facts = {};
    var earlier = previous || {};
    FACT_KEYS.forEach(function (key) {
      if (!isBlank(earlier[key])) facts[key] = earlier[key];
    });
    var source = context || {};
    var discovered = {
      workspaceId: source.workspace && source.workspace.id,
      workspaceName: source.workspace && source.workspace.displayName,
      servingLakehouseId: source.serving && source.serving.id,
      servingLakehouseName: source.serving && source.serving.displayName,
      fabricSqlServer: source.fabricSqlServer,
      fabricSqlDatabase: source.fabricSqlDatabase,
      dataverseConnectionId: source.dataverseConnectionId,
      notebookId: source.notebookId,
      apiBaseUrl: source.apiBaseUrl,
      principalId: source.principalId,
      packageUrl: source.apiPackage && source.apiPackage.url,
      packageVersion: source.apiPackage && source.apiPackage.version,
      packageSha256: source.apiPackage && source.apiPackage.sha256,
      packageBlobUrl: source.packageBlobUrl
    };
    Object.keys(discovered).forEach(function (key) {
      if (!isBlank(discovered[key])) facts[key] = String(discovered[key]);
    });
    return stripSecrets(facts);
  }

  /**
   * Steps whose result is only durable once the API key has been written to a
   * place a later run can read it back from. `azure-infra` puts the key into the
   * Web App application settings, which is what `secret` recovers from.
   */
  var SECRET_DURABLE_STEP = "azure-infra";
  var SECRET_DEPENDENTS = ["azure-infra", "azure-app", "dataverse-config", "verify"];

  /**
   * Decides which steps may be recorded as completed. A step that succeeded in a
   * run that later failed is still recorded — the work really happened and the
   * facts are persisted with it — except for `secret`, which may only be
   * recorded once the generated key is durable. Recording it earlier would make
   * the next run skip generation, find no key and deploy nulls, so the
   * installation would never converge.
   */
  function completedFromResults(previous, results) {
    var completed = {};
    Object.keys(previous || {}).forEach(function (key) {
      completed[key] = previous[key];
    });
    var byId = {};
    (results || []).forEach(function (entry) {
      byId[entry.id] = entry.status;
      if (entry.status === "succeeded" || entry.status === "resumed") completed[entry.id] = true;
    });
    var durable = byId[SECRET_DURABLE_STEP];
    if (byId.secret === "succeeded" && durable !== "succeeded" && durable !== "resumed") {
      delete completed.secret;
      SECRET_DEPENDENTS.forEach(function (id) {
        if (byId[id] !== "succeeded" && byId[id] !== "resumed") delete completed[id];
      });
    }
    return completed;
  }

  /**
   * Serializes the target configuration, the resume state and the non-secret
   * facts. Secrets are removed defensively: only a fingerprint is ever persisted.
   */
  function serializeConfiguration(target, state, facts) {
    var payload = {
      contractVersion: CONTRACT_VERSION,
      target: {},
      state: stripSecrets(state || {}),
      facts: {}
    };
    TARGET_KEYS.forEach(function (key) {
      if (!isBlank(target && target[key])) payload.target[key] = String(target[key]).trim();
    });
    delete payload.target.behavioralApiKey;
    var source = stripSecrets(facts || {});
    FACT_KEYS.forEach(function (key) {
      if (!isBlank(source[key])) payload.facts[key] = String(source[key]);
    });
    return JSON.stringify(payload, null, 2);
  }

  function validateTarget(target, options) {
    var input = applyAutomaticTarget(target || {});
    var settings = options || {};
    var errors = [];

    if (!settings.skipAzure) {
      if (!isGuid(input.subscriptionId)) {
        errors.push({ field: "subscriptionId", message: "Enter the Azure subscription id (GUID)." });
      }
      if (!isResourceGroupName(input.resourceGroup)) {
        errors.push({ field: "resourceGroup", message: "Enter a valid Azure resource group name." });
      }
      if (isBlank(input.location)) {
        errors.push({ field: "location", message: "Choose an Azure region." });
      }
      if (
        isGuid(input.subscriptionId) &&
        isResourceGroupName(input.resourceGroup) &&
        !isWebAppName(input.webAppName)
      ) {
        errors.push({
          field: "webAppName",
          message:
            "The Web App name must be 2-40 lower-case letters, digits, or single hyphens and must not start or end with a hyphen."
        });
      }
    }

    if (!settings.skipFabric) {
      if (!isBlank(input.fabricDataverseConnectionId) && !isGuid(input.fabricDataverseConnectionId)) {
        errors.push({
          field: "fabricDataverseConnectionId",
          message: "The Fabric Dataverse connection must be a GUID."
        });
      }
      if (isBlank(input.fabricDataverseDeltaFolder)) {
        errors.push({
          field: "fabricDataverseDeltaFolder",
          message: "Enter the Dataverse delta folder."
        });
      }
      ["fabricCapacityId", "fabricServingLakehouseId", "fabricDataverseLakehouseId"].forEach(
        function (key) {
          if (!isBlank(input[key]) && !isGuid(input[key])) {
            errors.push({ field: key, message: "This value must be a GUID." });
          }
        }
      );
    }

    try {
      requiredTables(input.requiredDataverseTables);
    } catch (error) {
      errors.push({ field: "requiredDataverseTables", message: error.message });
    }

    return { valid: errors.length === 0, errors: errors };
  }

  /** Steps that will actually run for the given context. */
  function buildPlan(context) {
    var input = context || {};
    var manual = input.mode === "manual";
    return STEPS.map(function (step) {
      var skipped = false;
      var reason = null;
      if (input.skipFabric && step.phase === "Fabric") {
        skipped = true;
        reason = "Fabric steps were skipped.";
      }
      if (input.skipAzure && step.phase === "Azure") {
        skipped = true;
        reason = "Azure steps were skipped.";
      }
      if (step.id === "fabric-notebook" && input.skipNotebook) {
        skipped = true;
        reason = "Notebook publication was skipped.";
      }
      if (manual && step.id !== "preflight" && step.id !== "verify") {
        skipped = true;
        reason = "Connect this environment first.";
      }
      return {
        id: step.id,
        name: step.name,
        phase: step.phase,
        interactive: Boolean(step.interactive),
        skipped: skipped,
        reason: reason,
        status: input.completed && input.completed[step.id] ? "completed" : "pending"
      };
    });
  }

  function describeConsent() {
    return CONSENT.map(function (item) {
      return {
        id: item.id,
        title: item.title,
        role: item.role,
        automatable: item.automatable,
        guidance: item.guidance
      };
    });
  }

  // ------------------------------------------------------------- HTTP helper

  function collectErrorMessages(payload) {
    var messages = [];
    var seen = [];

    function visit(value) {
      if (!value || typeof value !== "object" || seen.indexOf(value) !== -1) return;
      seen.push(value);
      if (typeof value.message === "string" && value.message.trim() && messages.indexOf(value.message.trim()) === -1) {
        messages.push(value.message.trim());
      }
      if (value.error) visit(value.error);
      if (Array.isArray(value.details)) value.details.forEach(visit);
      if (value.innererror) visit(value.innererror);
      if (value.innerError) visit(value.innerError);
    }

    visit(payload);
    return messages;
  }

  function errorHasCode(error, expectedCode) {
    var found = false;
    var seen = [];

    function visit(value) {
      if (found || !value || typeof value !== "object" || seen.indexOf(value) !== -1) return;
      seen.push(value);
      if (String(value.code || "").toLowerCase() === String(expectedCode).toLowerCase()) {
        found = true;
        return;
      }
      if (value.error) visit(value.error);
      if (Array.isArray(value.details)) value.details.forEach(visit);
      if (value.innererror) visit(value.innererror);
      if (value.innerError) visit(value.innerError);
    }

    visit(error && error.body);
    return found;
  }

  function createHttp(options) {
    var settings = options || {};
    var fetchImpl = settings.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetchImpl) {
      throw new Error("No fetch implementation is available.");
    }
    var maxAttempts = settings.maxAttempts || 5;
    var timer = settings.timer;

    async function send(request) {
      var attempt = 0;
      for (;;) {
        attempt++;
        var response = await fetchImpl(request.url, {
          method: request.method || "GET",
          headers: request.headers || {},
          body: request.body,
          credentials: request.credentials
        });
        var text = await response.text();
        var payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (error) {
            payload = text;
          }
        }
        if (response.ok) {
          return { status: response.status, body: payload, headers: response.headers };
        }
        var retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          var nestedMessages = collectErrorMessages(payload);
          var message =
            nestedMessages.join("\n") ||
            (typeof payload === "string" && payload) ||
            "HTTP " + response.status;
          var failure = new Error(message);
          failure.status = response.status;
          failure.body = payload;
          throw failure;
        }
        var retryAfter = response.headers && response.headers.get && response.headers.get("Retry-After");
        var waitMs = retryAfter ? Number(retryAfter) * 1000 : Math.min(30000, 500 * Math.pow(2, attempt));
        await delay(isFinite(waitMs) && waitMs > 0 ? waitMs : 1000, timer);
      }
    }

    return { send: send };
  }

  // -------------------------------------------------------- Dataverse client

  /**
   * Talks to the Dataverse Web API with the browser session of the signed-in
   * administrator. No token is needed: the setup page runs inside the app.
   */
  function createDataverseClient(options) {
    var settings = options || {};
    var http = settings.http || createHttp(settings);
    var clientUrl = String(settings.clientUrl || "").replace(/\/+$/, "");
    var root = clientUrl + "/api/data/v9.2/";

    function headers(extra) {
      var result = {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0"
      };
      Object.keys(extra || {}).forEach(function (key) {
        result[key] = extra[key];
      });
      return result;
    }

    async function request(method, path, body, extraHeaders) {
      return http.send({
        url: /^https?:\/\//i.test(path) ? path : root + path,
        method: method,
        headers: headers(extraHeaders),
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }

    /** Reads definitions plus their current values in a single round trip. */
    async function getEnvironmentVariables(names) {
      var wanted = names && names.length ? names : ALL_ENV_NAMES;
      var filter = wanted
        .map(function (name) {
          return "schemaname eq '" + name + "'";
        })
        .join(" or ");
      var path =
        "environmentvariabledefinitions?$select=schemaname,defaultvalue,environmentvariabledefinitionid" +
        "&$expand=environmentvariabledefinition_environmentvariablevalue($select=value,environmentvariablevalueid)" +
        "&$filter=" +
        encodeURIComponent(filter);
      var response = await request("GET", path);
      var records = (response.body && response.body.value) || [];
      var result = {};
      records.forEach(function (record) {
        var values = record.environmentvariabledefinition_environmentvariablevalue || [];
        var current = values.length ? values[0] : null;
        result[record.schemaname] = {
          definitionId: record.environmentvariabledefinitionid,
          valueId: current ? current.environmentvariablevalueid : null,
          value: current && !isBlank(current.value) ? current.value : null,
          defaultValue: isBlank(record.defaultvalue) ? null : record.defaultvalue
        };
      });
      return result;
    }

    /** Effective value: an explicit value always overrides the default. */
    function effectiveValue(record) {
      if (!record) return null;
      return record.value !== null && record.value !== undefined ? record.value : record.defaultValue;
    }

    async function setEnvironmentVariable(name, value, known) {
      var record = known && known[name];
      if (!record) {
        var lookup = await getEnvironmentVariables([name]);
        record = lookup[name];
      }
      if (!record) {
        throw new Error(
          "The environment variable '" + name + "' does not exist in this environment."
        );
      }
      if (record.valueId) {
        await request("PATCH", "environmentvariablevalues(" + record.valueId + ")", { value: String(value) });
        return { name: name, created: false };
      }
      await request("POST", "environmentvariablevalues", {
        value: String(value),
        "EnvironmentVariableDefinitionId@odata.bind":
          "/environmentvariabledefinitions(" + record.definitionId + ")"
      });
      return { name: name, created: true };
    }

    /** Calls the setup Custom API that ships with the managed solution. */
    async function executeSetupAction(action) {
      var response = await request("POST", "klth_ManageSegmentPreviewSetup", { klth_action: action });
      var payload = response.body || {};
      if (!payload.klth_resultjson) {
        throw new Error("The setup API returned no result.");
      }
      return JSON.parse(payload.klth_resultjson);
    }
    async function whoAmI() {
      var response = await request("GET", "WhoAmI");
      return response.body || {};
    }

    return {
      request: request,
      getEnvironmentVariables: getEnvironmentVariables,
      setEnvironmentVariable: setEnvironmentVariable,
      executeSetupAction: executeSetupAction,
      effectiveValue: effectiveValue,
      whoAmI: whoAmI
    };
  }

  // ---------------------------------------------------- app registration help

  var FABRIC_DELEGATED_SCOPES = [
    "Workspace.ReadWrite.All",
    "Item.ReadWrite.All",
    "Item.Execute.All",
    "Capacity.Read.All",
    "Connection.Read.All"
  ];

  var PORTAL_NEW_APP_URL =
    "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false";
  var PORTAL_APP_LIST_URL =
    "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";

  /** Redirect URI that the tenant app registration must contain, exactly. */
  function redirectUriFor(pageUrl) {
    var text = trimOrNull(pageUrl);
    if (!text) return null;
    var parsed;
    try {
      parsed = new URL(text);
    } catch (error) {
      return null;
    }
    var webResourceMarker = "/webresources/";
    var markerIndex = parsed.pathname.toLowerCase().indexOf(webResourceMarker);
    if (markerIndex >= 0) {
      return (
        parsed.origin +
        "/WebResources/" +
        parsed.pathname.substring(markerIndex + webResourceMarker.length)
      );
    }
    if (
      parsed.pathname.toLowerCase().endsWith("/main.aspx") &&
      String(parsed.searchParams.get("pagetype") || "").toLowerCase() === "webresource"
    ) {
      var webResourceName = trimOrNull(parsed.searchParams.get("webresourceName"));
      if (webResourceName) {
        return parsed.origin + "/WebResources/" + webResourceName.replace(/^\/+/, "");
      }
    }
    return parsed.origin + parsed.pathname;
  }

  /**
   * Everything an administrator needs to create the one-time app registration
   * in their own tenant. This is what makes the setup page self-sufficient: no
   * publisher-owned application and no desktop tooling are required.
   */
  function describeAppRegistration(pageUrl) {
    var redirectUri = redirectUriFor(pageUrl);
    return {
      redirectUri: redirectUri,
      platform: "Single-page application",
      supportedAccountTypes: "Accounts in this organizational directory only",
      newAppUrl: PORTAL_NEW_APP_URL,
      appListUrl: PORTAL_APP_LIST_URL,
      permissions: [
        {
          api: "Azure Service Management",
          scopes: ["user_impersonation"],
          type: "Delegated",
          adminConsent: false
        },
        {
          api: "Power BI Service",
          scopes: FABRIC_DELEGATED_SCOPES,
          type: "Delegated",
          adminConsent: true
        }
      ],
      steps: [
        "Open Microsoft Entra admin center > App registrations > New registration.",
        "Name it for example 'Segment Preview Setup' and keep the single-tenant default.",
        "Under Redirect URI choose Single-page application (SPA) and paste the URI shown on this page.",
        "Open API permissions and add the delegated permissions listed on this page.",
        "Press Grant admin consent for the tenant.",
        "Confirm that the signed-in administrator has at least the Contributor role in the target Fabric workspace.",
        "Copy the Application (client) ID back into this page and press Save."
      ]
    };
  }

  /** Admin consent URL for the tenant-registered application. */
  function adminConsentUrl(clientId, redirectUri, tenant) {
    if (!isGuid(clientId) || !redirectUri) return null;
    return (
      "https://login.microsoftonline.com/" +
      encodeURIComponent(trimOrNull(tenant) || "common") +
      "/adminconsent?client_id=" +
      encodeURIComponent(clientId) +
      "&redirect_uri=" +
      encodeURIComponent(redirectUri)
    );
  }

  // ------------------------------------------------------------ token access

  function base64Url(bytes) {
    var binary = "";
    for (var index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /**
   * Minimal OAuth 2.0 authorization-code + PKCE client for Microsoft Entra.
   *
   * It exists so the setup page needs no third-party library and no CDN, both of
   * which the Dataverse content security policy makes unreliable. The redirect
   * URI is this very web resource, so the popup lands back on the same origin and
   * the opener can read the authorization code directly.
   */
  function createAuthClient(options) {
    var settings = options || {};
    var clientId = trimOrNull(settings.clientId);
    if (!isGuid(clientId)) {
      throw new Error("A valid application (client) id is required to sign in.");
    }
    var tenant = trimOrNull(settings.tenant) || "organizations";
    var authority =
      trimOrNull(settings.authority) ||
      "https://login.microsoftonline.com/" + encodeURIComponent(tenant);
    var redirectUri = settings.redirectUri;
    if (!redirectUri) {
      throw new Error("A redirect URI is required to sign in.");
    }
    var http = settings.http || createHttp(settings);
    var timer = settings.timer;
    var openWindow =
      settings.openWindow ||
      function (url) {
        return window.open(url, "segment-preview-auth", "width=520,height=680");
      };
    var randomBytes =
      settings.randomBytes ||
      function (length) {
        var bytes = new Uint8Array(length);
        (settings.crypto || globalThis.crypto).getRandomValues(bytes);
        return bytes;
      };
    var sha256 =
      settings.sha256 ||
      async function (text) {
        var digest = await (settings.crypto || globalThis.crypto).subtle.digest(
          "SHA-256",
          new TextEncoder().encode(text)
        );
        return new Uint8Array(digest);
      };
    var now = settings.now || function () {
      return Date.now();
    };
    var popupTimeoutMs = settings.popupTimeoutMs === undefined ? 300000 : settings.popupTimeoutMs;
    var popupPollMs = settings.popupPollMs === undefined ? 250 : settings.popupPollMs;

    var refreshToken = null;
    var account = null;
    var cache = Object.create(null);

    function cacheKey(scope) {
      return String(scope).toLowerCase();
    }

    function store(scope, payload) {
      var expiresIn = Number(payload.expires_in || 0);
      cache[cacheKey(scope)] = {
        accessToken: payload.access_token,
        expiresAt: now() + Math.max(0, expiresIn - 60) * 1000
      };
      if (payload.refresh_token) refreshToken = payload.refresh_token;
      if (payload.id_token && !account) {
        account = readAccount(payload.id_token);
      }
      return payload.access_token;
    }

    function readAccount(idToken) {
      try {
        var part = String(idToken).split(".")[1];
        var json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
        var claims = JSON.parse(json);
        return {
          username: claims.preferred_username || claims.upn || null,
          tenantId: claims.tid || null,
          name: claims.name || null
        };
      } catch (error) {
        return null;
      }
    }

    async function post(body) {
      var form = Object.keys(body)
        .filter(function (key) {
          return body[key] !== undefined && body[key] !== null;
        })
        .map(function (key) {
          return encodeURIComponent(key) + "=" + encodeURIComponent(body[key]);
        })
        .join("&");
      var response = await http.send({
        url: authority + "/oauth2/v2.0/token",
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
        },
        body: form
      });
      return response.body || {};
    }

    function readCode(popup, state) {
      var href;
      try {
        href = popup.location && popup.location.href;
      } catch (error) {
        return null; // still on the Microsoft origin
      }
      if (!href || href.indexOf(redirectUri) !== 0) return null;
      var fragment = href.split("#")[1] || href.split("?")[1] || "";
      var params = new URLSearchParams(fragment);
      if (!params.get("code") && !params.get("error")) return null;
      if (params.get("state") !== state) {
        throw new Error("The sign-in response did not match the request.");
      }
      if (params.get("error")) {
        throw new Error(
          params.get("error_description") || params.get("error") || "Sign-in failed."
        );
      }
      return params.get("code");
    }

    async function authorize(scope) {
      var verifier = base64Url(randomBytes(48));
      var challenge = base64Url(await sha256(verifier));
      var state = base64Url(randomBytes(16));
      var url =
        authority +
        "/oauth2/v2.0/authorize?client_id=" +
        encodeURIComponent(clientId) +
        "&response_type=code&response_mode=fragment&redirect_uri=" +
        encodeURIComponent(redirectUri) +
        "&scope=" +
        encodeURIComponent(scope + " offline_access openid profile") +
        "&state=" +
        encodeURIComponent(state) +
        "&code_challenge=" +
        encodeURIComponent(challenge) +
        "&code_challenge_method=S256&prompt=select_account";

      var popup = openWindow(url);
      if (!popup) {
        throw new Error(
          "The sign-in window was blocked. Allow pop-ups for this site and press the button again."
        );
      }
      var deadline = now() + popupTimeoutMs;
      var code = null;
      try {
        for (;;) {
          code = readCode(popup, state);
          if (code) break;
          if (popup.closed) {
            throw new Error("The sign-in window was closed before sign-in completed.");
          }
          if (now() > deadline) {
            throw new Error("Sign-in timed out.");
          }
          await delay(popupPollMs, timer);
        }
      } finally {
        try {
          popup.close();
        } catch (error) {
          /* the popup may already be gone */
        }
      }

      return store(
        scope,
        await post({
          client_id: clientId,
          grant_type: "authorization_code",
          code: code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          scope: scope + " offline_access openid profile"
        })
      );
    }

    async function refresh(scope) {
      return store(
        scope,
        await post({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: scope + " offline_access openid profile"
        })
      );
    }

    /**
     * Returns an access token for one resource. The first call signs in; every
     * later resource is obtained from the rotating refresh token, so the
     * administrator sees a single sign-in prompt for the whole run.
     */
    async function getToken(scope) {
      var wanted = Array.isArray(scope) ? scope[0] : scope;
      var cached = cache[cacheKey(wanted)];
      if (cached && cached.expiresAt > now()) return cached.accessToken;
      if (refreshToken) {
        try {
          return await refresh(wanted);
        } catch (error) {
          refreshToken = null;
        }
      }
      return authorize(wanted);
    }

    function dispose() {
      refreshToken = null;
      cache = Object.create(null);
    }

    return {
      getToken: getToken,
      getAccount: function () {
        return account;
      },
      dispose: dispose
    };
  }

  /**
   * Wraps an injected MSAL browser instance. Optional: the engine ships its own
   * PKCE client (createAuthClient) and does not depend on MSAL. This wrapper is
   * kept so an environment that already loads MSAL can reuse that session.
   */
  function createMsalTokenProvider(options) {
    var settings = options || {};
    var instance = settings.instance;
    if (!instance) {
      throw new Error("An MSAL instance is required for the direct provisioning mode.");
    }
    var account = settings.account || null;

    async function ensureAccount(scopes) {
      if (account) return account;
      var existing = instance.getAllAccounts ? instance.getAllAccounts() : [];
      if (existing && existing.length) {
        account = existing[0];
        return account;
      }
      var login = await instance.loginPopup({ scopes: scopes, prompt: "select_account" });
      account = login.account;
      return account;
    }

    async function getToken(scope) {
      var scopes = Array.isArray(scope) ? scope : [scope];
      var current = await ensureAccount(scopes);
      try {
        var silent = await instance.acquireTokenSilent({ scopes: scopes, account: current });
        return silent.accessToken;
      } catch (error) {
        var interactive = await instance.acquireTokenPopup({ scopes: scopes, account: current });
        return interactive.accessToken;
      }
    }

    return {
      getToken: getToken,
      getAccount: function () {
        return account;
      }
    };
  }

  // --------------------------------------------------------- broker session

  /**
   * Client for the publisher-hosted, multi-tenant provisioning service.
   *
   * The service owns one fixed redirect URI of its own, so nothing has to be
   * registered for this Dataverse origin. The browser never sees an Azure or
   * Fabric token: it opens a popup on the broker, the administrator signs in and
   * consents to the publisher's multi-tenant application there, and the broker
   * returns a short-lived session token through postMessage.
   *
   *   POST   {baseUrl}/v1/sessions                     -> 201 { sessionId, authorizeUrl, expiresAt }
   *   (popup) {authorizeUrl}                           -> postMessage { type, sessionId, nonce, status, sessionToken, expiresAt, account }
   *   POST   {baseUrl}/v1/sessions/{id}/runs           -> 202 { runId, status }
   *   GET    {baseUrl}/v1/sessions/{id}/runs/{runId}   -> 200 { status, steps[], outputs, manual[] }
   *   DELETE {baseUrl}/v1/sessions/{id}                -> 204
   *
   * See documentation/setup-center-contract.md for the full contract. No broker
   * endpoint is built in; the URL always comes from the environment variable.
   */
  function createBrokerSession(options) {
    var settings = options || {};
    var http = settings.http || createHttp(settings);
    var baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
    var origin = brokerOrigin(baseUrl);
    if (!origin) {
      throw new Error("The provisioning service URL must be an absolute https URL.");
    }
    var pageOrigin = settings.pageOrigin || (typeof location !== "undefined" ? location.origin : null);
    var timer = settings.timer;
    var pollIntervalMs = settings.pollIntervalMs === undefined ? 4000 : settings.pollIntervalMs;
    var maxPolls = settings.maxPolls || 300;
    var popupTimeoutMs = settings.popupTimeoutMs === undefined ? 300000 : settings.popupTimeoutMs;
    var popupPollMs = settings.popupPollMs === undefined ? 250 : settings.popupPollMs;
    var now = settings.now || function () {
      return Date.now();
    };
    var openWindow =
      settings.openWindow ||
      function (url) {
        return window.open(url, "segment-preview-broker", "width=520,height=680");
      };
    var messages = settings.messages || {
      addEventListener: function (handler) {
        window.addEventListener("message", handler);
      },
      removeEventListener: function (handler) {
        window.removeEventListener("message", handler);
      }
    };
    var randomBytes =
      settings.randomBytes ||
      function (length) {
        var bytes = new Uint8Array(length);
        (settings.crypto || globalThis.crypto).getRandomValues(bytes);
        return bytes;
      };

    function newNonce() {
      return base64Url(randomBytes(32));
    }

    async function call(method, path, body, token) {
      var headers = {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "x-segment-preview-contract": CONTRACT_VERSION
      };
      if (token) headers.Authorization = "Bearer " + token;
      return http.send({
        url: baseUrl + path,
        method: method,
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }

    /**
     * Asks the broker for a short-lived session. The returned authorize URL must
     * live on the broker origin; anything else is a redirect attempt and is
     * refused before a window is opened.
     */
    async function createSession(request) {
      var nonce = newNonce();
      var response = await call("POST", "/v1/sessions", {
        contractVersion: CONTRACT_VERSION,
        nonce: nonce,
        origin: pageOrigin,
        environmentUrl: (request && request.environmentUrl) || null,
        environmentDomain: (request && request.environmentDomain) || null
      });
      var payload = response.body || {};
      if (!payload.sessionId || !payload.authorizeUrl) {
        throw new Error("The provisioning service did not return a sign-in session.");
      }
      if (brokerOrigin(payload.authorizeUrl) !== origin) {
        throw new Error("The provisioning service returned a sign-in URL on a different origin. Sign-in was cancelled.");
      }
      return {
        sessionId: String(payload.sessionId),
        authorizeUrl: String(payload.authorizeUrl),
        nonce: nonce,
        expiresAt: payload.expiresAt || null,
        brokerUrl: baseUrl
      };
    }

    /**
     * Opens the broker popup and waits for its postMessage. Origin, message
     * type, session id and nonce are all verified before anything is accepted.
     */
    function authorize(session) {
      return new Promise(function (resolve, reject) {
        var popup;
        try {
          popup = openWindow(session.authorizeUrl);
        } catch (error) {
          reject(new Error("The sign-in window could not be opened: " + (error.message || error)));
          return;
        }
        if (!popup) {
          reject(new Error("The sign-in window was blocked. Allow pop-ups for this site and try again."));
          return;
        }

        var settled = false;
        var pollHandle = null;

        function cleanup() {
          settled = true;
          messages.removeEventListener(onMessage);
          if (pollHandle && typeof clearInterval === "function") clearInterval(pollHandle);
          try {
            if (popup && !popup.closed) popup.close();
          } catch (error) {
            /* closing a cross-origin popup may throw; ignore */
          }
        }

        function fail(message) {
          if (settled) return;
          cleanup();
          reject(new Error(message));
        }

        function onMessage(event) {
          if (settled) return;
          if (!event || event.origin !== origin) return;
          var data = event.data;
          if (!data || typeof data !== "object") return;
          if (data.type !== BROKER_MESSAGE_TYPE) return;
          if (data.sessionId !== session.sessionId) return;
          if (data.nonce !== session.nonce) {
            fail("The provisioning service returned an unexpected sign-in response. Sign-in was cancelled.");
            return;
          }
          if (data.status !== "authorized" || !data.sessionToken) {
            fail(
              (data.error && data.error.message) ||
                "Sign-in with the provisioning service was not completed."
            );
            return;
          }
          cleanup();
          resolve({
            sessionId: session.sessionId,
            brokerUrl: baseUrl,
            sessionToken: String(data.sessionToken),
            expiresAt: data.expiresAt || null,
            account: data.account || null,
            tenantId: data.tenantId || null
          });
        }

        messages.addEventListener(onMessage);

        var deadline = now() + popupTimeoutMs;
        if (typeof setInterval === "function") {
          pollHandle = setInterval(function () {
            if (settled) return;
            if (now() > deadline) {
              fail("Sign-in with the provisioning service timed out.");
              return;
            }
            var closed = false;
            try {
              closed = Boolean(popup.closed);
            } catch (error) {
              closed = false;
            }
            if (closed) fail("The sign-in window was closed before sign-in finished.");
          }, popupPollMs);
        }
      });
    }

    /** Creates and authorizes a session, or reuses one that is still valid. */
    async function connect(request, resume) {
      var reusable = validSession(resume, { brokerUrl: baseUrl, now: now });
      if (reusable) return reusable;
      var session = await createSession(request || {});
      return authorize(session);
    }

    async function startRun(session, request) {
      var response = await call(
        "POST",
        "/v1/sessions/" + encodeURIComponent(session.sessionId) + "/runs",
        request,
        session.sessionToken
      );
      var payload = response.body || {};
      if (!payload.runId) {
        throw new Error("The provisioning service did not return a run id.");
      }
      return payload;
    }

    async function getRun(session, runId) {
      var response = await call(
        "GET",
        "/v1/sessions/" +
          encodeURIComponent(session.sessionId) +
          "/runs/" +
          encodeURIComponent(runId),
        undefined,
        session.sessionToken
      );
      return response.body || {};
    }

    async function poll(session, runId, hooks) {
      var callbacks = hooks || {};
      var seen = Object.create(null);
      for (var attempt = 0; attempt < maxPolls; attempt++) {
        var snapshot = await getRun(session, runId);
        (snapshot.steps || []).forEach(function (step) {
          var key = step.id + ":" + step.status;
          if (seen[key]) return;
          seen[key] = true;
          if (callbacks.onProgress) callbacks.onProgress(step);
        });
        if (snapshot.status === "succeeded" || snapshot.status === "actionRequired") return snapshot;
        if (snapshot.status === "failed") {
          var failure = new Error(
            (snapshot.error && snapshot.error.message) || "The provisioning service reported a failure."
          );
          failure.operation = snapshot;
          throw failure;
        }
        await delay(pollIntervalMs, timer);
      }
      throw new Error("The provisioning service did not finish within the expected time.");
    }

    /** Starts a run (or re-attaches to a known one) and polls it to completion. */
    async function run(session, request, hooks, existingRunId) {
      var callbacks = hooks || {};
      var runId = existingRunId;
      if (runId) {
        try {
          var existing = await getRun(session, runId);
          if (existing.status === "failed" || existing.status === "actionRequired") runId = null;
        } catch (error) {
          if (error.status === 404 || error.status === 410) runId = null;
          else throw error;
        }
      }
      if (!runId) {
        var started = await startRun(session, request);
        runId = started.runId;
        if (callbacks.onRun) callbacks.onRun({ sessionId: session.sessionId, runId: runId });
      }
      var snapshot = await poll(session, runId, callbacks);
      snapshot.runId = runId;
      return snapshot;
    }

    /** Best-effort revocation of the short-lived session. */
    async function end(session) {
      if (!session || !session.sessionId || !session.sessionToken) return false;
      try {
        await call("DELETE", "/v1/sessions/" + encodeURIComponent(session.sessionId), undefined, session.sessionToken);
        return true;
      } catch (error) {
        return false;
      }
    }

    return {
      origin: origin,
      createSession: createSession,
      authorize: authorize,
      connect: connect,
      startRun: startRun,
      getRun: getRun,
      run: run,
      end: end
    };
  }

  // ------------------------------------------------- broker session storage

  function parseTime(value) {
    if (!value) return null;
    var parsed = typeof value === "number" ? value : Date.parse(value);
    return isFinite(parsed) ? parsed : null;
  }

  /**
   * Returns the session only when it is complete, still valid and issued by the
   * broker that is configured now. Anything else is treated as absent, so a
   * stale record can never silently authorize a new run.
   */
  function validSession(record, options) {
    var settings = options || {};
    var clock = settings.now || function () {
      return Date.now();
    };
    if (!record || typeof record !== "object") return null;
    if (!record.sessionId || !record.sessionToken) return null;
    if (settings.brokerUrl && record.brokerUrl !== String(settings.brokerUrl).replace(/\/+$/, "")) return null;
    if (settings.environmentDomain && record.environmentDomain && record.environmentDomain !== settings.environmentDomain) {
      return null;
    }
    var expiresAt = parseTime(record.expiresAt);
    if (expiresAt !== null && expiresAt - 30000 <= clock()) return null;
    return record;
  }

  function saveBrokerSession(storage, record) {
    if (!storage) return false;
    try {
      storage.setItem(BROKER_SESSION_KEY, JSON.stringify(record));
      return true;
    } catch (error) {
      return false;
    }
  }

  function loadBrokerSession(storage, options) {
    if (!storage) return null;
    var raw;
    try {
      raw = storage.getItem(BROKER_SESSION_KEY);
    } catch (error) {
      return null;
    }
    if (!raw) return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    var valid = validSession(parsed, options);
    if (!valid) clearBrokerSession(storage);
    return valid;
  }

  function clearBrokerSession(storage) {
    if (!storage) return false;
    try {
      storage.removeItem(BROKER_SESSION_KEY);
      return true;
    } catch (error) {
      return false;
    }
  }

  // ---------------------------------------------------------- direct client

  /**
   * Performs the Azure Resource Manager and Fabric REST calls straight from the
   * browser with delegated tokens from the tenant-registered SPA application.
   */
  function createDirectClient(options) {
    var settings = options || {};
    var http = settings.http || createHttp(settings);
    var fetchImpl = settings.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    var getToken = settings.getToken;
    var timer = settings.timer;
    var armRoot = settings.armRoot || ARM_ROOT;
    var fabricRoot = settings.fabricRoot || FABRIC_ROOT;

    async function arm(method, path, body, apiVersion) {
      var token = await getToken(settings.armScope || ARM_SCOPE);
      var absolute = /^https?:\/\//i.test(path);
      var separator = path.indexOf("?") > -1 ? "&" : "?";
      return http.send({
        url: absolute
          ? path
          : armRoot + path + separator + "api-version=" + (apiVersion || ARM_API_VERSION),
        method: method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          Authorization: "Bearer " + token
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }

    async function fabric(method, path, body) {
      var token = await getToken(settings.fabricScope || FABRIC_SCOPE);
      return http.send({
        url: /^https?:\/\//i.test(path) ? path : fabricRoot + "/" + path.replace(/^\/+/, ""),
        method: method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          Authorization: "Bearer " + token
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }

    async function fabricCollection(path) {
      var items = [];
      var next = path;
      var guard = 0;
      while (next && guard++ < 100) {
        var response = await fabric("GET", next);
        var payload = response.body || {};
        if (Array.isArray(payload.value)) items = items.concat(payload.value);
        next = payload.continuationUri || null;
      }
      return items;
    }

    async function listSubscriptions() {
      var subscriptions = [];
      var next = "/subscriptions";
      var guard = 0;
      while (next && guard++ < 100) {
        var response = await arm("GET", next, undefined, "2020-01-01");
        var payload = response.body || {};
        if (Array.isArray(payload.value)) subscriptions = subscriptions.concat(payload.value);
        next = payload.nextLink || null;
      }
      return subscriptions
        .map(function (subscription) {
          return {
            id: subscription.subscriptionId || "",
            name: subscription.displayName || subscription.subscriptionId || "",
            state: subscription.state || "",
            tenantId: subscription.tenantId || ""
          };
        })
        .filter(function (subscription) {
          return subscription.id && (!subscription.state || subscription.state === "Enabled");
        })
        .sort(function (left, right) {
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    async function listCapacities() {
      var capacities = await fabricCollection("capacities");
      return capacities
        .map(function (capacity) {
          return {
            id: capacity.id || "",
            name: capacity.displayName || capacity.id || "",
            sku: capacity.sku || "",
            state: capacity.state || "",
            region: capacity.region || ""
          };
        })
        .filter(function (capacity) {
          return capacity.id && (!capacity.state || capacity.state === "Active");
        })
        .sort(function (left, right) {
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    async function listLocations(subscriptionId) {
      var response = await arm(
        "GET",
        "/subscriptions/" + subscriptionId + "/locations",
        undefined,
        "2022-12-01"
      );
      return ((response.body && response.body.value) || [])
        .filter(function (location) {
          return location.name && (!location.metadata || location.metadata.regionType === "Physical");
        })
        .map(function (location) {
          return {
            name: location.name,
            displayName: location.displayName || location.name,
            regionalDisplayName: location.regionalDisplayName || "",
            recommended:
              Boolean(location.metadata) && location.metadata.regionCategory === "Recommended"
          };
        })
        .sort(function (left, right) {
          if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
          return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
        });
    }

    async function listWorkspaces() {
      return (await fabricCollection("workspaces"))
        .filter(function (workspace) {
          return workspace.id && workspace.type !== "Personal";
        })
        .map(function (workspace) {
          return {
            id: workspace.id,
            name: workspace.displayName || workspace.id,
            capacityId: workspace.capacityId || "",
            region: workspace.capacityRegion || ""
          };
        })
        .sort(function (left, right) {
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    async function listLakehouses(workspaceId) {
      return (await fabricCollection("workspaces/" + workspaceId + "/lakehouses"))
        .filter(function (lakehouse) {
          return lakehouse.id;
        })
        .map(function (lakehouse) {
          return { id: lakehouse.id, name: lakehouse.displayName || lakehouse.id };
        })
        .sort(function (left, right) {
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    async function listDataverseConnections(environmentUrl) {
      var expected = environmentDomain(environmentUrl);
      return (await fabricCollection("connections"))
        .filter(function (connection) {
          var details = connection.connectionDetails || {};
          if (!connection.id || details.type !== "CommonDataService") return false;
          if (!expected) return true;
          var path = String(details.path || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
          return path.toLowerCase() === expected.toLowerCase();
        })
        .map(function (connection) {
          return {
            id: connection.id,
            name: connection.displayName || connection.id,
            credentialType:
              (connection.credentialDetails && connection.credentialDetails.credentialType) || ""
          };
        })
        .sort(function (left, right) {
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    async function ensureResourceGroup(subscriptionId, name, location) {
      var path = "/subscriptions/" + subscriptionId + "/resourcegroups/" + encodeURIComponent(name);
      try {
        var existing = await arm("GET", path);
        if (existing.body && existing.body.location) return existing.body;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      var response = await arm(
        "PUT",
        path,
        { location: location }
      );
      return response.body;
    }

    async function listResourceGroups(subscriptionId) {
      var groups = [];
      var next = "/subscriptions/" + subscriptionId + "/resourcegroups";
      var guard = 0;
      while (next && guard++ < 100) {
        var response = await arm("GET", next, undefined, "2021-04-01");
        var payload = response.body || {};
        if (Array.isArray(payload.value)) groups = groups.concat(payload.value);
        next = payload.nextLink || null;
      }
      return groups
        .map(function (group) {
          return {
            id: group.id || "",
            name: group.name || "",
            location: group.location || ""
          };
        })
        .filter(function (group) { return group.name; })
        .sort(function (left, right) {
          return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    /** Starts a resource-group deployment and waits for a terminal state. */
    async function deployTemplate(subscriptionId, resourceGroup, deploymentName, template, parameters, hooks) {
      var callbacks = hooks || {};
      var wrapped = {};
      Object.keys(parameters || {}).forEach(function (key) {
        wrapped[key] = { value: parameters[key] };
      });
      var path =
        "/subscriptions/" +
        subscriptionId +
        "/resourcegroups/" +
        encodeURIComponent(resourceGroup) +
        "/providers/Microsoft.Resources/deployments/" +
        encodeURIComponent(deploymentName);
      await arm("PUT", path, {
        properties: { mode: "Incremental", template: template, parameters: wrapped }
      });

      for (var poll = 0; poll < 240; poll++) {
        var snapshot = await arm("GET", path);
        var state = snapshot.body && snapshot.body.properties && snapshot.body.properties.provisioningState;
        if (callbacks.onProgress) callbacks.onProgress({ id: "azure-infra", status: state });
        if (state === "Succeeded") {
          return (snapshot.body.properties && snapshot.body.properties.outputs) || {};
        }
        if (state === "Failed" || state === "Canceled") {
          throw new Error("The Azure deployment finished with state '" + state + "'.");
        }
        await delay(5000, timer);
      }
      throw new Error("The Azure deployment did not finish within the expected time.");
    }

    /**
     * Resolves a Fabric response that may be a long running operation. Item
     * creation and definition updates answer 202 with an operation id, so the
     * caller has to poll before the new item id exists.
     */
    async function fabricResult(response) {
      var current = response;
      if (!current || current.status !== 202) return current && current.body;
      var operationId = header(current, "x-ms-operation-id");
      var location = header(current, "Location") || header(current, "location");
      if (!operationId && location) {
        var match = /\/operations\/([^/?]+)/i.exec(location);
        if (match) operationId = match[1];
      }
      if (!operationId) return current.body;
      for (var poll = 0; poll < 120; poll++) {
        var snapshot = await fabric("GET", "operations/" + encodeURIComponent(operationId));
        var status = (snapshot.body && snapshot.body.status) || "";
        if (/^succeeded$/i.test(status)) {
          var result = await fabric("GET", "operations/" + encodeURIComponent(operationId) + "/result");
          return result.body;
        }
        if (/^(failed|undefined)$/i.test(status)) {
          var error = (snapshot.body && snapshot.body.error && snapshot.body.error.message) || status || "unknown";
          throw new Error("The Fabric operation finished with state '" + error + "'.");
        }
        await delay(3000, timer);
      }
      throw new Error("The Fabric operation did not finish within the expected time.");
    }

    function header(response, name) {
      if (!response || !response.headers || typeof response.headers.get !== "function") return null;
      return response.headers.get(name) || null;
    }

    /** Reads the current application settings of the Web App. */
    async function webAppSettings(subscriptionId, resourceGroup, webAppName) {
      var response = await arm(
        "POST",
        sitePath(subscriptionId, resourceGroup, webAppName) + "/config/appsettings/list",
        undefined,
        WEB_API_VERSION
      );
      return (response.body && response.body.properties) || {};
    }

    /** Replaces the application settings of the Web App with the merged set. */
    async function setWebAppSettings(subscriptionId, resourceGroup, webAppName, properties) {
      var response = await arm(
        "PUT",
        sitePath(subscriptionId, resourceGroup, webAppName) + "/config/appsettings",
        { properties: properties || {} },
        WEB_API_VERSION
      );
      return (response.body && response.body.properties) || {};
    }

    /** Restarts the Web App so a new package is picked up. */
    async function restartWebApp(subscriptionId, resourceGroup, webAppName) {
      await arm(
        "POST",
        sitePath(subscriptionId, resourceGroup, webAppName) + "/restart",
        undefined,
        WEB_API_VERSION
      );
      return true;
    }

    /**
     * Polls the deployed API until it answers its own health endpoint. A Web App
     * that has just been restarted needs time to mount the package blob, and the
     * blob read only starts working once the managed identity role assignment has
     * propagated, so a first failure means "not ready yet" rather than "broken".
     * A cross-origin failure surfaces in the browser as a TypeError with no
     * status, which is treated the same way.
     */
    async function apiHealth(baseUrl, options) {
      var config = options || {};
      var attempts = config.attempts || HEALTH_ATTEMPTS;
      var delayMs = config.delayMs || HEALTH_DELAY_MS;
      var url = String(baseUrl || "").replace(/\/+$/, "") + "/health";
      var lastError = null;
      for (var attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0 && timer) await timer(delayMs);
        try {
          var response = await http.send({ url: url, method: "GET", headers: { Accept: "application/json" } });
          if (response.status >= 200 && response.status < 300) {
            return { ok: true, attempts: attempt + 1, status: response.status, body: response.body || null };
          }
          lastError = "HTTP " + response.status;
        } catch (error) {
          lastError = (error && error.message) || String(error);
        }
      }
      return { ok: false, attempts: attempts, error: lastError, url: url };
    }

    function sitePath(subscriptionId, resourceGroup, webAppName) {
      return (
        "/subscriptions/" +
        subscriptionId +
        "/resourcegroups/" +
        encodeURIComponent(resourceGroup) +
        "/providers/Microsoft.Web/sites/" +
        encodeURIComponent(webAppName)
      );
    }

    return {
      arm: arm,
      fabric: fabric,
      fabricResult: fabricResult,
      fabricCollection: fabricCollection,
      listSubscriptions: listSubscriptions,
      listCapacities: listCapacities,
      listLocations: listLocations,
      listWorkspaces: listWorkspaces,
      listLakehouses: listLakehouses,
      listDataverseConnections: listDataverseConnections,
      listResourceGroups: listResourceGroups,
      ensureResourceGroup: ensureResourceGroup,
      deployTemplate: deployTemplate,
      webAppSettings: webAppSettings,
      setWebAppSettings: setWebAppSettings,
      restartWebApp: restartWebApp,
      apiHealth: apiHealth
    };
  }

  // ------------------------------------------------------------- orchestrator

  /**
   * Drives the one-button flow. Every step reports progress through the hooks so
   * the UI can render live status. With dryRun the engine performs no write call
   * at all and produces the exact same step sequence, which is what the test
   * suite and the "Preview run" button use.
   */
  function createOrchestrator(options) {
    var settings = options || {};
    var dataverse = settings.dataverse;
    var mode = settings.mode || "manual";
    var target = applyAutomaticTarget(settings.target || {});
    var environmentUrl = settings.environmentUrl;
    var dryRun = Boolean(settings.dryRun);
    var hooks = settings.hooks || {};
    var cryptoImpl = settings.crypto;
    var broker = settings.broker || null;
    var direct = settings.direct || null;
    var template = settings.template || null;
    var payload = settings.payload || null;
    var completed = settings.completed || {};
    var facts = stripSecrets(settings.facts || {});
    var timer = settings.timer;

    var context = {
      target: target,
      environmentDomain: environmentDomain(environmentUrl),
      apiKey: null,
      apiKeyFingerprint: null,
      apiBaseUrl: null,
      outputs: {},
      manual: []
    };

    /**
     * Restores what earlier runs discovered. Without this a resumed run skips
     * the discovery steps and then works with nulls, which used to make the
     * later steps deploy blank settings while still reporting success.
     */
    (function hydrate() {
      if (!isBlank(facts.workspaceId)) {
        context.workspace = { id: facts.workspaceId, displayName: facts.workspaceName || null };
      }
      if (!isBlank(facts.servingLakehouseId)) {
        context.serving = { id: facts.servingLakehouseId, displayName: facts.servingLakehouseName || null };
      }
      if (!isBlank(facts.fabricSqlServer)) context.fabricSqlServer = facts.fabricSqlServer;
      if (!isBlank(facts.fabricSqlDatabase)) context.fabricSqlDatabase = facts.fabricSqlDatabase;
      if (!isBlank(facts.dataverseConnectionId)) {
        context.dataverseConnectionId = facts.dataverseConnectionId;
      }
      if (!isBlank(facts.notebookId)) context.notebookId = facts.notebookId;
      if (!isBlank(facts.apiBaseUrl)) context.apiBaseUrl = facts.apiBaseUrl;
      if (!isBlank(facts.principalId)) context.principalId = facts.principalId;
      if (!isBlank(facts.packageBlobUrl)) context.packageBlobUrl = facts.packageBlobUrl;
    })();

    /**
     * Steps this run has to repeat even though an earlier run finished them,
     * because a fact they produced could not be restored.
     */
    var forced = {};

    function forceRerun(stepIds, reason) {
      stepIds.forEach(function (id) {
        forced[id] = reason;
      });
    }

    var desiredPackage = resolveApiPackage(payload, settings.apiPackageUrl);
    if (
      mode === "direct" &&
      desiredPackage.configured &&
      completed["azure-infra"] &&
      (
        !completed["azure-app"] ||
        facts.packageSha256 !== desiredPackage.sha256 ||
        facts.packageVersion !== desiredPackage.version
      )
    ) {
      forceRerun(
        ["azure-infra", "azure-app"],
        "The current API package was not recorded by the earlier run, so Azure deployment and package verification run again."
      );
    }

    /** Fails loudly instead of letting a later step deploy a null. */
    function requireFact(value, stepId, label) {
      if (isBlank(value)) {
        throw new Error(
          label +
            " is not known. The '" +
            stepId +
            "' step did not record it. Choose 'Start over' on the setup page so the installation runs from the beginning."
        );
      }
      return value;
    }

    /**
     * Reads the key an earlier run stored in the Web App application settings.
     * The key never leaves the customer tenant: it is written by the Azure
     * deployment and read back with the same delegated Azure token.
     */
    async function recoverApiKey() {
      if (mode !== "direct" || !direct || typeof direct.webAppSettings !== "function") return null;
      if (isBlank(target.subscriptionId) || isBlank(target.resourceGroup) || isBlank(target.webAppName)) {
        return null;
      }
      var current;
      try {
        current = await direct.webAppSettings(target.subscriptionId, target.resourceGroup, target.webAppName);
      } catch (error) {
        return null;
      }
      var value = current && current[API_KEY_SETTING];
      return isBlank(value) ? null : String(value);
    }

    var results = [];

    function report(step, status, message, extra) {
      var entry = {
        id: step.id,
        name: step.name,
        phase: step.phase,
        status: status,
        message: message || null
      };
      if (extra) Object.keys(extra).forEach(function (key) { entry[key] = extra[key]; });
      if (status !== "running") results.push(entry);
      if (hooks.onProgress) hooks.onProgress(entry);
      return entry;
    }

    function addManual(message) {
      if (context.manual.indexOf(message) === -1) context.manual.push(message);
      if (hooks.onManual) hooks.onManual(message);
    }

    /**
     * Broker mode delegates the whole Azure and Fabric work to the publisher
     * provisioning service. The run is started once, on the first delegated
     * step, and every later step reports the outcome the service published for
     * that step id.
     */
    async function ensureBrokerRun() {
      if (context.brokerRun) return context.brokerRun;
      if (!broker) {
        throw new Error("No provisioning service client is configured.");
      }
      if (!context.session) {
        throw new Error("The provisioning service session is missing. Sign in again.");
      }
      // The service never resolves the package itself. The browser owns the
      // solution payload, so it pins the exact URL, digest, blob name and
      // version the deployment must use, and refuses the run when they are
      // missing rather than letting the service deploy a codeless Web App.
      var pkg = context.apiPackage || resolveApiPackage(payload, settings.apiPackageUrl);
      context.apiPackage = pkg;
      if (!pkg.configured) {
        addManual(pkg.hint);
        throw new Error(
          "No verified API package is available, so the provisioning service was not started. " + pkg.hint
        );
      }
      var snapshot = await broker.run(
        context.session,
        {
          contractVersion: CONTRACT_VERSION,
          dataverse: {
            environmentUrl: "https://" + context.environmentDomain,
            requiredTables: context.requiredTables || []
          },
          azure: {
            subscriptionId: target.subscriptionId,
            resourceGroup: target.resourceGroup,
            location: target.location,
            webAppName: target.webAppName
          },
          fabric: {
            workspaceId: target.fabricWorkspaceId || null,
            workspaceName: target.fabricWorkspaceName || null,
            capacityId: target.fabricCapacityId || null,
            servingLakehouseId: target.fabricServingLakehouseId || null,
            servingLakehouseName: target.fabricServingLakehouseName || null,
            dataverseConnectionId: target.fabricDataverseConnectionId || null,
            dataverseDeltaFolder: target.fabricDataverseDeltaFolder || null
          },
          secrets: { behavioralApiKey: context.apiKey },
          apiPackage: {
            url: pkg.url,
            sha256: pkg.sha256,
            blobName: packageBlobName(pkg),
            version: pkg.version || ""
          },
          options: { skipNotebook: Boolean(settings.skipNotebook) }
        },
        hooks,
        settings.resumeRunId || null
      );
      context.brokerRun = snapshot;
      var outputs = snapshot.outputs || {};
      if (outputs.apiBaseUrl) context.apiBaseUrl = apiBaseUrl(outputs.apiBaseUrl);
      if (outputs.webAppUrl && !context.apiBaseUrl) context.apiBaseUrl = apiBaseUrl(outputs.webAppUrl);
      var principal = outputs.principalId || outputs.managedIdentityPrincipalId;
      if (principal) context.principalId = principal;
      if (outputs.workspaceId) context.workspace = { id: outputs.workspaceId };
      if (outputs.servingLakehouseId) context.serving = { id: outputs.servingLakehouseId };
      if (outputs.notebookId) context.notebookId = outputs.notebookId;
      if (outputs.packageBlobUrl) context.packageBlobUrl = outputs.packageBlobUrl;
      context.outputs = outputs;
      (snapshot.manual || []).forEach(addManual);
      return snapshot;
    }

    async function brokerDelegate(stepId) {
      var snapshot = await ensureBrokerRun();
      var step = (snapshot.steps || []).filter(function (item) {
        return item.id === stepId;
      })[0];
      if (step && step.status === "failed") {
        throw new Error(step.message || "The provisioning service failed at '" + stepId + "'.");
      }
      if (step && step.status === "skipped") return "Skipped by the provisioning service.";
      return (step && step.message) || "Completed by the provisioning service.";
    }

    var handlers = {
      preflight: async function () {
        var validation = validateTarget(target, settings);
        if (!validation.valid) {
          throw new Error(
            validation.errors
              .map(function (item) {
                return item.message;
              })
              .join(" ")
          );
        }
        if (!context.environmentDomain) {
          throw new Error("The Dataverse environment URL could not be resolved.");
        }
        context.requiredTables = requiredTables(target.requiredDataverseTables);
        return "Configuration validated for " + context.environmentDomain + ".";
      },

      consent: async function () {
        if (dryRun) return "Sign-in and consent would be requested here.";
        if (mode === "direct") {
          await settings.getToken(ARM_SCOPE);
          await settings.getToken(FABRIC_SCOPE);
          return "Delegated Azure and Fabric tokens acquired.";
        }
        if (!broker) {
          throw new Error("No provisioning service client is configured.");
        }
        var session = await broker.connect(
          {
            environmentUrl: "https://" + context.environmentDomain,
            environmentDomain: context.environmentDomain
          },
          settings.resumeSession || null
        );
        session.environmentDomain = context.environmentDomain;
        context.session = session;
        if (hooks.onSession) hooks.onSession(session);
        return session.account
          ? "Signed in to the provisioning service as " + session.account + "."
          : "Signed in to the provisioning service.";
      },

      "fabric-discovery": async function () {
        if (dryRun) return "Fabric workspace and lakehouse would be resolved.";
        if (mode === "broker") return brokerDelegate("fabric-discovery");
        var workspaces = await direct.fabricCollection("workspaces");
        var workspace = workspaces.filter(function (item) {
          return (
            (target.fabricWorkspaceId && item.id === target.fabricWorkspaceId) ||
            (!target.fabricWorkspaceId && item.displayName === target.fabricWorkspaceName)
          );
        })[0];
        if (!workspace) {
          var capacityId = target.fabricCapacityId;
          if (!isGuid(capacityId)) {
            var capacities = await direct.listCapacities();
            var eligible = capacities.filter(function (capacity) {
              return !/^PP/i.test(capacity.sku || "");
            });
            if (!eligible.length) {
              throw new Error(
                "No active Fabric capacity that can host a workspace is available. Select or create a Fabric capacity and run setup again."
              );
            }
            var wantedRegion = String(target.location || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
            var regional = eligible.filter(function (capacity) {
              return (
                String(capacity.region || "").replace(/[^a-z0-9]/gi, "").toLowerCase() ===
                wantedRegion
              );
            });
            capacityId = (regional[0] || eligible[0]).id;
          }
          var created = await direct.fabric("POST", "workspaces", {
            displayName: target.fabricWorkspaceName,
            capacityId: capacityId
          });
          workspace = created.body;
        }
        context.workspace = workspace;

        var lakehouses = await direct.fabricCollection("workspaces/" + workspace.id + "/lakehouses");
        var serving = lakehouses.filter(function (item) {
          return (
            (target.fabricServingLakehouseId && item.id === target.fabricServingLakehouseId) ||
            (!target.fabricServingLakehouseId && item.displayName === target.fabricServingLakehouseName)
          );
        })[0];
        if (!serving) {
          var newLakehouse = await direct.fabric("POST", "workspaces/" + workspace.id + "/lakehouses", {
            displayName: target.fabricServingLakehouseName,
            description: "Serving lakehouse for the Customer Insights Segment Preview."
          });
          serving = newLakehouse.body;
        }
        context.serving = serving;

        var details = await direct.fabric(
          "GET",
          "workspaces/" + workspace.id + "/lakehouses/" + serving.id
        );
        var endpoint =
          details.body && details.body.properties && details.body.properties.sqlEndpointProperties;
        if (!endpoint || !endpoint.connectionString) {
          addManual(
            "The SQL analytics endpoint of the serving lakehouse is still provisioning. Wait until Fabric reports 'Success' and run the setup again."
          );
          throw new Error("The Fabric SQL analytics endpoint is not available yet.");
        }
        context.fabricSqlServer = fabricSqlServer(endpoint.connectionString);
        context.fabricSqlDatabase = endpoint.id;

        context.dataverseConnectionId = target.fabricDataverseConnectionId;
        if (!isGuid(context.dataverseConnectionId)) {
          var connections = await direct.listDataverseConnections(
            "https://" + context.environmentDomain
          );
          if (!connections.length) {
            throw new Error(
              "No Fabric Dataverse connection for this environment was found. Create one in Fabric > Settings > Manage connections and gateways, then run setup again."
            );
          }
          var workspaceIdentity = connections.filter(function (connection) {
            return connection.credentialType === "WorkspaceIdentity";
          });
          context.dataverseConnectionId = (workspaceIdentity[0] || connections[0]).id;
        }
        return "Workspace '" + workspace.displayName + "' and lakehouse '" + serving.displayName + "' resolved.";
      },

      "fabric-notebook": async function () {
        if (dryRun) return "The bootstrap notebook would be published and scheduled.";
        if (mode === "broker") return brokerDelegate("fabric-notebook");
        var notebook = payload && payload.notebook;
        if (!notebook) {
          throw new Error("The setup payload does not contain the bootstrap notebook.");
        }
        if (!context.workspace || !context.serving) {
          throw new Error("The Fabric workspace and serving lakehouse must be resolved first.");
        }

        var mirrorId = target.fabricDataverseLakehouseId;
        if (!isGuid(mirrorId)) {
          addManual(
            "A Dataverse mirror lakehouse id is still missing. In make.powerapps.com select this environment, open Tables > Analyze > Link to Microsoft Fabric, and mirror the required tables. Then open the created Lakehouse in Fabric, copy the GUID after /lakehouses/ from its URL into Advanced options > Dataverse mirror Lakehouse ID, and install again."
          );
          mirrorId = EMPTY_GUID;
        }

        var definition = buildNotebookDefinition(notebook, {
          WORKSPACE_ID: context.workspace.id,
          SERVING_LAKEHOUSE_ID: context.serving.id,
          DATAVERSE_LAKEHOUSE_ID: mirrorId
        });

        var workspacePath = "workspaces/" + context.workspace.id;
        var existing = (await direct.fabricCollection(workspacePath + "/notebooks")).filter(function (item) {
          return item.displayName === notebook.displayName;
        })[0];

        var notebookId;
        try {
          if (existing) {
            var updateMetadata = definition.parts.some(function (part) {
              return part.path === ".platform";
            });
            var updated = await direct.fabric(
              "POST",
              workspacePath + "/items/" + existing.id +
                "/updateDefinition?updateMetadata=" + String(updateMetadata),
              { definition: definition }
            );
            await direct.fabricResult(updated);
            notebookId = existing.id;
          } else {
            var created = await direct.fabric("POST", workspacePath + "/notebooks", {
              displayName: notebook.displayName,
              description: notebook.description || "",
              definition: definition
            });
            var item = await direct.fabricResult(created);
            notebookId = item && item.id;
          }
        } catch (error) {
          if (/insufficient scopes|does not have sufficient scopes/i.test(String(error && error.message))) {
            var permissionMessage =
              "Fabric rejected the notebook update for insufficient scopes. Confirm that the tenant application has the delegated Power BI Service permission Item.ReadWrite.All with admin consent and that your user has at least the Contributor role in this Fabric workspace. Then close and reopen this setup page before installing again.";
            addManual(permissionMessage);
            throw new Error(permissionMessage);
          }
          throw error;
        }
        if (!notebookId) {
          throw new Error("Fabric did not return an id for the bootstrap notebook.");
        }
        context.notebookId = notebookId;

        if (!notebook.schedule) {
          return "Bootstrap notebook '" + notebook.displayName + "' published.";
        }

        var schedulePath = workspacePath + "/items/" + notebookId + "/jobs/" +
          (notebook.schedule.jobType || "Execute") + "/schedules";
        var schedules = [];
        try {
          schedules = await direct.fabricCollection(schedulePath);
        } catch (error) {
          schedules = [];
        }
        if (schedules.length) {
          return "Bootstrap notebook '" + notebook.displayName + "' published; existing schedule kept.";
        }
        try {
          await direct.fabric("POST", schedulePath, {
            enabled: notebook.schedule.enabled !== false,
            configuration: notebook.schedule.configuration
          });
        } catch (error) {
          if (/insufficient scopes|does not have sufficient scopes/i.test(String(error && error.message))) {
            var schedulePermissionMessage =
              "Fabric rejected the notebook schedule for insufficient scopes. Add the delegated Power BI Service permission Item.Execute.All to the tenant application, grant admin consent, then close and reopen this setup page before installing again.";
            addManual(schedulePermissionMessage);
            throw new Error(schedulePermissionMessage);
          }
          throw error;
        }
        return "Bootstrap notebook '" + notebook.displayName + "' published and scheduled.";
      },

      secret: async function () {
        if (dryRun) {
          context.apiKeyFingerprint = "sha256:dry-run";
          return "A new API key would be generated.";
        }
        if (completed.secret) {
          var recovered = await recoverApiKey();
          if (recovered) {
            context.apiKey = recovered;
            context.apiKeyFingerprint = await fingerprint(recovered, cryptoImpl);
            return "The API key of the earlier run was recovered from the Web App (" + context.apiKeyFingerprint + ").";
          }
        }
        context.apiKey = generateApiKey(cryptoImpl);
        context.apiKeyFingerprint = await fingerprint(context.apiKey, cryptoImpl);
        if (completed.secret) {
          forceRerun(
            SECRET_DEPENDENTS,
            "A new API key was generated, so every step that stores it runs again."
          );
          return (
            "The earlier API key could not be read back, so a new one was generated (" +
            context.apiKeyFingerprint +
            "). Every step that stores it runs again."
          );
        }
        return "API key generated (" + context.apiKeyFingerprint + ").";
      },

      "azure-infra": async function () {
        if (dryRun) return "The Azure infrastructure and the verified API package copy would be deployed.";
        if (mode === "broker") return brokerDelegate("azure-infra");
        if (!template) throw new Error("The Azure template could not be loaded.");
        requireFact(context.apiKey, "secret", "The behavioural API key");
        if (!settings.skipFabric) {
          requireFact(context.workspace && context.workspace.id, "fabric-discovery", "The Fabric workspace id");
          requireFact(context.serving && context.serving.id, "fabric-discovery", "The serving lakehouse id");
        }
        // The package URL and digest are handed to the template, which copies the
        // package into customer-owned storage from inside Azure. A browser cannot
        // do that itself: release assets carry no cross-origin headers.
        //
        // Deploying without them is never acceptable: the template writes the
        // application settings as a complete set, so a package-less deployment
        // would strip WEBSITE_RUN_FROM_PACKAGE from a Web App that was already
        // running the API and leave it serving nothing. The run stops here
        // instead, before a single Azure resource is touched.
        var pkg = resolveApiPackage(payload, settings.apiPackageUrl);
        context.apiPackage = pkg;
        if (!pkg.configured) {
          addManual(pkg.hint);
          throw new Error(
            "No verified API package is available, so the Azure deployment was not started. " +
              "Deploying without one would remove the code an existing Web App runs. " +
              pkg.hint
          );
        }
        await direct.ensureResourceGroup(
          target.subscriptionId,
          target.resourceGroup,
          target.location
        );
        var deploymentLocation = target.location;
        var deploymentParameters = {
          location: deploymentLocation,
          webAppName: target.webAppName,
          fabricSqlServer: context.fabricSqlServer || "",
          fabricSqlDatabase: context.fabricSqlDatabase || "",
          fabricWorkspaceId: (context.workspace && context.workspace.id) || target.fabricWorkspaceId || "",
          fabricServingLakehouseId:
            (context.serving && context.serving.id) || target.fabricServingLakehouseId || "",
          fabricDataverseConnectionId: context.dataverseConnectionId || "",
          fabricDataverseDeltaFolder: target.fabricDataverseDeltaFolder,
          dataverseEnvironmentUrl: "https://" + context.environmentDomain,
          behavioralApiKey: context.apiKey,
          requiredDataverseTables: (context.requiredTables || []).join(","),
          apiPackageUrl: pkg.configured ? pkg.url : "",
          apiPackageSha256: pkg.configured ? pkg.sha256 : "",
          apiPackageBlobName: pkg.configured ? packageBlobName(pkg) : "",
          apiPackageVersion: pkg.configured ? pkg.version || "" : ""
        };
        var usedQuotaFallback = false;
        var outputs;
        try {
          outputs = await direct.deployTemplate(
            target.subscriptionId,
            target.resourceGroup,
            "segment-preview",
            template,
            deploymentParameters,
            hooks
          );
        } catch (error) {
          if (
            errorHasCode(error, "InternalSubscriptionIsOverQuotaForSku") &&
            deploymentLocation.toLowerCase() !== "westeurope"
          ) {
            deploymentLocation = "westeurope";
            deploymentParameters = Object.assign({}, deploymentParameters, {
              location: deploymentLocation
            });
            target.location = deploymentLocation;
            usedQuotaFallback = true;
            if (hooks.onProgress) {
              hooks.onProgress({
                id: "azure-infra",
                status: "Retrying in West Europe because the selected region has no B1 App Service quota."
              });
            }
            try {
              outputs = await direct.deployTemplate(
                target.subscriptionId,
                target.resourceGroup,
                "segment-preview",
                template,
                deploymentParameters,
                hooks
              );
            } catch (fallbackError) {
              if (errorHasCode(fallbackError, "InternalSubscriptionIsOverQuotaForSku")) {
                var quotaMessage =
                  "Azure has no B1 App Service Plan quota in either the selected region or West Europe. " +
                  "Request an App Service quota of at least 1 at https://aka.ms/antquotahelp, or choose another Azure subscription.";
                addManual(quotaMessage);
                throw new Error(quotaMessage + "\n" + fallbackError.message);
              }
              throw fallbackError;
            }
          } else {
            if (errorHasCode(error, "InternalSubscriptionIsOverQuotaForSku")) {
              var quotaGuidance =
                "Azure has no B1 App Service Plan quota in West Europe. " +
                "Request an App Service quota of at least 1 at https://aka.ms/antquotahelp, or choose another Azure subscription.";
              addManual(quotaGuidance);
              throw new Error(quotaGuidance + "\n" + error.message);
            }
            throw error;
          }
        }
        context.outputs = outputs || {};
        var webAppUrl = outputs && outputs.webAppUrl && outputs.webAppUrl.value;
        context.apiBaseUrl = apiBaseUrl(webAppUrl || target.webAppName + ".azurewebsites.net");
        context.principalId =
          (outputs && outputs.managedIdentityPrincipalId && outputs.managedIdentityPrincipalId.value) || null;
        context.packageBlobUrl = (outputs && outputs.packageBlobUrl && outputs.packageBlobUrl.value) || null;
        return (
          "Azure infrastructure deployed" +
          (usedQuotaFallback ? " in West Europe after the selected region reported no B1 App Service quota" : "") +
          " and the verified API package was copied into your own storage account."
        );
      },

      "fabric-permissions": async function () {
        if (dryRun) return "The managed identity would receive the Contributor workspace role.";
        if (mode === "broker") return brokerDelegate("fabric-permissions");
        requireFact(context.principalId, "azure-infra", "The Web App managed identity object id");
        requireFact(context.workspace && context.workspace.id, "fabric-discovery", "The Fabric workspace id");
        await direct.fabric("POST", "workspaces/" + context.workspace.id + "/roleAssignments", {
          principal: { id: context.principalId, type: "ServicePrincipal" },
          role: "Contributor"
        });
        return "Contributor role assigned to the managed identity.";
      },

      "azure-app": async function () {
        if (dryRun) return "The deployed API package would be confirmed, the Web App restarted and /health polled until it answers.";
        if (mode === "broker") return brokerDelegate("azure-app");
        var pkg = context.apiPackage || resolveApiPackage(payload, settings.apiPackageUrl);
        context.apiPackage = pkg;
        if (!pkg.configured) {
          addManual(pkg.hint);
          throw new Error(
            "No verified API package is available, so the Web App cannot be confirmed to run the API. " + pkg.hint
          );
        }

        // The deployment already downloaded, verified and stored the package, so
        // this step confirms what Azure actually applied and never trusts a
        // setting it did not read back.
        var current = await direct.webAppSettings(
          target.subscriptionId,
          target.resourceGroup,
          target.webAppName
        );
        var blobName = packageBlobName(pkg);
        var deployed = String(current[RUN_FROM_PACKAGE_SETTING] || "");
        if (deployed.indexOf("/" + PACKAGE_CONTAINER + "/" + blobName) === -1) {
          throw new Error(
            "The Web App does not run the expected API package. Its " +
              RUN_FROM_PACKAGE_SETTING +
              " setting is " +
              (deployed || "empty") +
              " instead of a blob named " +
              blobName +
              ". Re-run the installation; if it keeps failing, inspect the '" +
              target.webAppName +
              "-package-copy' container group in resource group " +
              target.resourceGroup +
              "."
          );
        }
        if (deployed.indexOf("?") > -1) {
          throw new Error(
            "The Web App reads the API package through a shared access signature, which expires. " +
              "Re-run the installation so it is switched to its own managed identity."
          );
        }
        if (current[PACKAGE_SHA_SETTING] !== pkg.sha256) {
          throw new Error(
            "The Web App reports API package digest " +
              (current[PACKAGE_SHA_SETTING] || "none") +
              " instead of the pinned " +
              pkg.sha256 +
              "."
          );
        }
        if (current[PACKAGE_IDENTITY_SETTING] !== "SystemAssigned") {
          throw new Error(
            "The Web App is not configured to read the package with its own managed identity (" +
              PACKAGE_IDENTITY_SETTING +
              " is " +
              (current[PACKAGE_IDENTITY_SETTING] || "empty") +
              ")."
          );
        }

        context.packageBlobUrl = deployed;
        await direct.restartWebApp(target.subscriptionId, target.resourceGroup, target.webAppName);

        // Settings alone do not prove the API runs. The blob mount and the role
        // assignment that lets the site read it both propagate asynchronously,
        // so the page waits for the API's own health endpoint before it declares
        // this step done and writes the URL into Dataverse.
        var healthBase = context.apiBaseUrl || apiBaseUrl(target.webAppName + ".azurewebsites.net");
        var health = await direct.apiHealth(healthBase, {
          attempts: settings.healthAttempts,
          delayMs: settings.healthDelayMs
        });
        if (!health || !health.ok) {
          throw new Error(
            "The API package was deployed but " +
              healthBase +
              "health did not answer within " +
              Math.round(((settings.healthAttempts || HEALTH_ATTEMPTS) * (settings.healthDelayMs || HEALTH_DELAY_MS)) / 60000) +
              " minutes (" +
              ((health && health.error) || "no response") +
              "). App Service may still be mounting the package or the storage role assignment may not have propagated. " +
              "Wait a few minutes and install again; the step is safe to repeat."
          );
        }
        context.apiHealthy = true;
        return (
          "API package " +
          (pkg.version || "") +
          " runs from your own storage account and answered /health after " +
          health.attempts +
          (health.attempts === 1 ? " attempt." : " attempts.")
        );
      },

      "dataverse-config": async function () {
        var url = context.apiBaseUrl || apiBaseUrl((target.webAppName || "") + ".azurewebsites.net");
        if (dryRun) {
          return "The environment variables would be set to " + url + ".";
        }
        requireFact(context.apiKey, "secret", "The behavioural API key");
        requireFact(url, "azure-infra", "The API base URL");
        var known = await dataverse.getEnvironmentVariables([ENV.apiUrl, ENV.apiKey]);
        await dataverse.setEnvironmentVariable(ENV.apiUrl, url, known);
        await dataverse.setEnvironmentVariable(ENV.apiKey, context.apiKey, known);
        context.apiBaseUrl = url;
        return "Environment variables written (" + context.apiKeyFingerprint + ").";
      },

      verify: async function () {
        if (dryRun) {
          return "The setup status would be re-checked and any missing Fabric shortcuts installed.";
        }
        var status = await dataverse.executeSetupAction("status");
        var provisioned = false;
        if (needsShortcutProvisioning(status)) {
          // Idempotent and server-side: the Custom API calls the Web App, which
          // creates the shortcuts with its own managed identity.
          var afterProvision = await dataverse.executeSetupAction(PROVISION_SHORTCUTS_ACTION);
          provisioned = true;
          status = hasStatusComponents(afterProvision)
            ? afterProvision
            : await dataverse.executeSetupAction("status");
          if (needsShortcutProvisioning(status)) {
            // A shortcut can become visible a moment after it is created, so the
            // status is read once more before the run reports what it found.
            status = await dataverse.executeSetupAction("status");
          }
        }
        context.status = status;
        context.shortcutsProvisioned = provisioned;
        return (
          "Setup status: " +
          (status.overallState || "unknown") +
          "." +
          (provisioned ? " Missing Fabric shortcuts were installed." : "")
        );
      }
    };

    async function run() {
      var plan = buildPlan({
        mode: mode,
        completed: completed,
        skipFabric: settings.skipFabric,
        skipAzure: settings.skipAzure,
        skipNotebook: settings.skipNotebook
      });
      if (hooks.onPlan) hooks.onPlan(plan);

      for (var index = 0; index < plan.length; index++) {
        var step = plan[index];
        if (step.skipped) {
          report(step, "skipped", step.reason);
          continue;
        }
        if (step.status === "completed" && ALWAYS_RUN.indexOf(step.id) === -1 && !forced[step.id]) {
          report(step, "resumed", "Completed in an earlier run.");
          continue;
        }
        report(step, "running");
        try {
          var message = await handlers[step.id]();
          report(step, "succeeded", message);
        } catch (error) {
          report(step, "failed", error && error.message ? error.message : String(error));
          return {
            ok: false,
            failedStep: step.id,
            results: results,
            manual: context.manual,
            facts: collectFacts(context, facts),
            completed: completedFromResults(completed, results),
            context: publicContext()
          };
        }
      }

      return {
        ok: true,
        results: results,
        manual: context.manual,
        facts: collectFacts(context, facts),
        completed: completedFromResults(completed, results),
        context: publicContext()
      };
    }

    function publicContext() {
      return {
        environmentDomain: context.environmentDomain,
        apiBaseUrl: context.apiBaseUrl,
        apiKeyFingerprint: context.apiKeyFingerprint,
        workspaceId: context.workspace ? context.workspace.id : null,
        servingLakehouseId: context.serving ? context.serving.id : null,
        notebookId: context.notebookId || null,
        apiPackageVersion: context.apiPackage ? context.apiPackage.version : null,
        packageBlobUrl: context.packageBlobUrl || null,
        overallState: context.status ? context.status.overallState : null,
        shortcutsProvisioned: Boolean(context.shortcutsProvisioned),
        status: context.status || null
      };
    }

    function dispose() {
      context.apiKey = null;
    }

    return { run: run, dispose: dispose, context: publicContext };
  }

  // ---------------------------------------------------------------- facade

  /**
   * Describes the optional hosted provisioning service state for this
   * environment. When none is configured this returns `configured: false`
   * together with the exact steps an administrator has to take. Nothing is
   * guessed: the setup center must never imply that a service exists when the
   * URL is empty, and it must never present the service as required.
   */
  function describeBrokerSetup(brokerUrl) {
    var url = trimOrNull(brokerUrl);
    var configured = isHttpsUrl(url);
    return {
      configured: configured,
      url: configured ? url : null,
      origin: brokerOrigin(url),
      variable: ENV.brokerUrl,
      invalid: Boolean(url) && !configured,
      headline: configured
        ? "Hosted provisioning service configured"
        : "No hosted provisioning service is configured (not required)",
      summary: configured
        ? "Installing signs you in to " +
          brokerOrigin(url) +
          " in a pop-up window. That service performs the Azure and Fabric work with your delegated permissions; this page never handles an Azure token. Every resource it creates belongs to your own tenant and subscription."
        : "A hosted provisioning service is optional. Self-service installation registers a single-page application in your own tenant instead, guided from this page. Supply a service URL in " +
          ENV.brokerUrl +
          " only if your organisation prefers not to register an application itself.",
      steps: configured
        ? [
            "Press 'Install everything'.",
            "Sign in and consent in the pop-up window that opens on " + brokerOrigin(url) + ".",
            "Leave this page open while the service reports progress."
          ]
        : [
            "Nothing to do for a self-service installation: use 'Connect this environment' above.",
            "If your organisation runs a provisioning service, paste its https URL below and press 'Save service URL'. It is stored in the " +
              ENV.brokerUrl +
              " environment variable of this solution.",
            "The service performs the same steps with your delegated permissions; the resources still belong to your tenant."
          ],
      contractDocumentation: "documentation/setup-center-contract.md"
    };
  }

  /** Loads every setting the setup center needs, in one round trip. */
  async function loadSetupContext(dataverse, environmentUrl, pageUrl) {
    var variables = await dataverse.getEnvironmentVariables(ALL_ENV_NAMES);
    var settings = {};
    ALL_ENV_NAMES.forEach(function (name) {
      settings[name] = dataverse.effectiveValue(variables[name]);
    });
    var stored = parseConfiguration(settings[ENV.configuration]);
    var resolution = resolveMode(settings);
    var registration = describeAppRegistration(pageUrl);
    return {
      contractVersion: CONTRACT_VERSION,
      variables: variables,
      settings: settings,
      missingVariables: ALL_ENV_NAMES.filter(function (name) {
        return !variables[name];
      }),
      mode: resolution,
      target: applyAutomaticTarget(stored.target),
      state: (stored && stored.state) || {},
      facts: (stored && stored.facts) || {},
      environmentDomain: environmentDomain(environmentUrl),
      consent: describeConsent(),
      broker: describeBrokerSetup(resolution.brokerUrl),
      apiPackageUrl: settings[ENV.apiPackageUrl] || null,
      apiPackage: parseApiPackageSetting(settings[ENV.apiPackageUrl]),
      appRegistration: registration,
      adminConsentUrl: adminConsentUrl(resolution.clientId, registration.redirectUri, null),
      plan: buildPlan({ mode: resolution.mode, completed: (stored && stored.state) || {} })
    };
  }

  /** Stores the optional hosted provisioning service URL for this environment. */
  async function saveBrokerUrl(dataverse, url) {
    var value = trimOrNull(url);
    if (!isHttpsUrl(value)) {
      throw new Error("Enter the provisioning service URL as an absolute https address.");
    }
    return dataverse.setEnvironmentVariable(ENV.brokerUrl, value.replace(/\/+$/, ""));
  }

  /** Stores the tenant-registered application id used for browser sign-in. */
  async function saveClientId(dataverse, clientId) {
    var value = trimOrNull(clientId);
    if (!isGuid(value)) {
      throw new Error("Enter the Application (client) ID as a GUID.");
    }
    return dataverse.setEnvironmentVariable(ENV.clientId, value);
  }

  /**
   * Stores the https URL of the published API package together with the
   * SHA-256 digest of that exact asset. Both are required: the browser refuses
   * to upload a package it cannot verify.
   */
  async function saveApiPackageUrl(dataverse, url, sha256) {
    var value = trimOrNull(url);
    var digest = trimOrNull(sha256);
    if (!isHttpsUrl(value)) {
      throw new Error("Enter the API package URL as an absolute https address.");
    }
    if (!isSha256(digest)) {
      throw new Error("Enter the SHA-256 digest of the package as 64 hexadecimal characters.");
    }
    return dataverse.setEnvironmentVariable(ENV.apiPackageUrl, value + " " + digest.toLowerCase());
  }

  async function saveSetupContext(dataverse, target, state, facts) {
    return dataverse.setEnvironmentVariable(ENV.configuration, serializeConfiguration(target, state, facts));
  }

  return {
    CONTRACT_VERSION: CONTRACT_VERSION,
    BROKER_MESSAGE_TYPE: BROKER_MESSAGE_TYPE,
    BROKER_SESSION_KEY: BROKER_SESSION_KEY,
    ENV: ENV,
    STEPS: STEPS,
    ARM_SCOPE: ARM_SCOPE,
    FABRIC_SCOPE: FABRIC_SCOPE,
    TARGET_KEYS: TARGET_KEYS,
    TARGET_DEFAULTS: TARGET_DEFAULTS,
    applyAutomaticTarget: applyAutomaticTarget,
    FABRIC_DELEGATED_SCOPES: FABRIC_DELEGATED_SCOPES,
    isGuid: isGuid,
    isHttpsUrl: isHttpsUrl,
    isSha256: isSha256,
    brokerOrigin: brokerOrigin,
    isWebAppName: isWebAppName,
    isResourceGroupName: isResourceGroupName,
    environmentDomain: environmentDomain,
    apiBaseUrl: apiBaseUrl,
    fabricSqlServer: fabricSqlServer,
    requiredTables: requiredTables,
    generateApiKey: generateApiKey,
    fingerprint: fingerprint,
    toBase64: toBase64,
    applyNotebookParameters: applyNotebookParameters,
    buildNotebookDefinition: buildNotebookDefinition,
    parseApiPackageSetting: parseApiPackageSetting,
    resolveApiPackage: resolveApiPackage,
    packageBlobName: packageBlobName,
    needsShortcutProvisioning: needsShortcutProvisioning,
    PROVISION_SHORTCUTS_ACTION: PROVISION_SHORTCUTS_ACTION,
    PACKAGE_CONTAINER: PACKAGE_CONTAINER,
    API_KEY_SETTING: API_KEY_SETTING,
    RUN_FROM_PACKAGE_SETTING: RUN_FROM_PACKAGE_SETTING,
    PACKAGE_IDENTITY_SETTING: PACKAGE_IDENTITY_SETTING,
    PACKAGE_SHA_SETTING: PACKAGE_SHA_SETTING,
    PACKAGE_VERSION_SETTING: PACKAGE_VERSION_SETTING,
    normalizeMode: normalizeMode,
    resolveMode: resolveMode,
    parseConfiguration: parseConfiguration,
    serializeConfiguration: serializeConfiguration,
    collectFacts: collectFacts,
    completedFromResults: completedFromResults,
    mergeConfiguration: mergeConfiguration,
    validateTarget: validateTarget,
    buildPlan: buildPlan,
    describeConsent: describeConsent,
    describeBrokerSetup: describeBrokerSetup,
    describeAppRegistration: describeAppRegistration,
    redirectUriFor: redirectUriFor,
    adminConsentUrl: adminConsentUrl,
    createHttp: createHttp,
    createDataverseClient: createDataverseClient,
    createAuthClient: createAuthClient,
    createMsalTokenProvider: createMsalTokenProvider,
    createBrokerSession: createBrokerSession,
    validSession: validSession,
    saveBrokerSession: saveBrokerSession,
    loadBrokerSession: loadBrokerSession,
    clearBrokerSession: clearBrokerSession,
    createDirectClient: createDirectClient,
    createOrchestrator: createOrchestrator,
    loadSetupContext: loadSetupContext,
    saveSetupContext: saveSetupContext,
    saveBrokerUrl: saveBrokerUrl,
    saveClientId: saveClientId,
    saveApiPackageUrl: saveApiPackageUrl
  };
});
