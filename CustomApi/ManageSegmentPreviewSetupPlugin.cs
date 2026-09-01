using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    public sealed class ManageSegmentPreviewSetupPlugin : IPlugin
    {
        private const string ApiUrlVariable = "klth_FabricBehavioralApiUrl";
        private const string ApiKeyVariable = "klth_FabricBehavioralApiKey";
        private static readonly HttpClient HttpClient = CreateHttpClient();

        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(
                typeof(IPluginExecutionContext));
            var tracing = (ITracingService)serviceProvider.GetService(
                typeof(ITracingService));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(
                typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            var action = context.InputParameters.Contains("klth_action")
                ? context.InputParameters["klth_action"] as string
                : null;
            action = string.IsNullOrWhiteSpace(action)
                ? "status"
                : action.Trim().ToLowerInvariant();
            if (action != "status" && action != "provision-shortcuts")
            {
                throw new InvalidPluginExecutionException(
                    "The requested Segment Preview setup action is not supported.");
            }

            var result = CreateDataverseStatus();
            var apiUrl = ReadEnvironmentVariable(service, ApiUrlVariable);
            var apiKey = ReadEnvironmentVariable(service, ApiKeyVariable);
            var configuration = result.Components.Single(
                component => component.Id == "dataverse-configuration");
            var missing = new List<string>();
            if (string.IsNullOrWhiteSpace(apiUrl))
            {
                missing.Add(ApiUrlVariable);
            }

            if (string.IsNullOrWhiteSpace(apiKey))
            {
                missing.Add(ApiKeyVariable);
            }

            if (missing.Count > 0)
            {
                configuration.State = "notConfigured";
                configuration.Message =
                    missing.Count + " Dataverse environment variable(s) must be configured.";
                configuration.Detail = string.Join(", ", missing);
                configuration.Action = "configure-dataverse";
                result.Components.Add(new SetupComponent
                {
                    Id = "azure-api",
                    Name = "Azure API",
                    Category = "Azure",
                    State = "blocked",
                    Message =
                        "Configure the Dataverse environment variables before checking Azure and Fabric."
                });
                result.OverallState = "partial";
                context.OutputParameters["klth_resultjson"] = Serialize(result);
                return;
            }

            Uri endpoint;
            if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out endpoint) ||
                endpoint.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidPluginExecutionException(
                    "The environment variable '" + ApiUrlVariable +
                    "' must contain an absolute HTTPS URL.");
            }

            var relativePath = action == "provision-shortcuts"
                ? "setup/provision"
                : "setup/status";
            var method = action == "provision-shortcuts"
                ? HttpMethod.Post
                : HttpMethod.Get;
            tracing.Trace(
                "Calling Segment Preview setup endpoint for action {0}.",
                action);

            try
            {
                using (var request = new HttpRequestMessage(
                    method,
                    new Uri(endpoint, relativePath)))
                {
                    request.Headers.Add("x-api-key", apiKey);
                    if (method == HttpMethod.Post)
                    {
                        request.Content = new StringContent(
                            "{\"dataverseTables\":[]}",
                            Encoding.UTF8,
                            "application/json");
                    }

                    using (var response = HttpClient.SendAsync(request)
                        .GetAwaiter()
                        .GetResult())
                    {
                        var body = response.Content.ReadAsStringAsync()
                            .GetAwaiter()
                            .GetResult();
                        if (!response.IsSuccessStatusCode)
                        {
                            var error = TryDeserialize<SetupApiError>(body);
                            var message =
                                error != null && !string.IsNullOrWhiteSpace(error.Message)
                                    ? error.Message
                                    : response.StatusCode == HttpStatusCode.Forbidden
                                        ? "The Segment Preview Azure Web App blocks public HTTPS access. " +
                                          "Run Setup Center > Install everything to restore public network access, " +
                                          "or remove an App Service access restriction that blocks Dataverse."
                                        : "The Segment Preview setup API returned HTTP " +
                                          (int)response.StatusCode + ".";
                            throw new InvalidPluginExecutionException(
                                message);
                        }

                        var remote = action == "provision-shortcuts"
                            ? Deserialize<SetupProvisionEnvelope>(body).Status
                            : Deserialize<SetupResult>(body);
                        if (remote == null)
                        {
                            throw new InvalidPluginExecutionException(
                                "The Segment Preview setup API returned an invalid response.");
                        }

                        result.ApiVersion = remote.ApiVersion;
                        result.CheckedAt = remote.CheckedAt;
                        result.Components.AddRange(remote.Components ?? new List<SetupComponent>());
                        result.OverallState = result.Components.All(
                            component => component.State == "ready")
                            ? "ready"
                            : remote.OverallState;
                    }
                }
            }
            catch (HttpRequestException exception)
            {
                throw new InvalidPluginExecutionException(
                    "The Segment Preview Azure API is not reachable.",
                    exception);
            }
            catch (AggregateException exception)
            {
                throw new InvalidPluginExecutionException(
                    "The Segment Preview Azure API request failed.",
                    exception.Flatten());
            }
            catch (System.Threading.Tasks.TaskCanceledException exception)
            {
                throw new InvalidPluginExecutionException(
                    "The Segment Preview Azure API did not respond within 60 seconds.",
                    exception);
            }
            catch (SerializationException exception)
            {
                throw new InvalidPluginExecutionException(
                    "The Segment Preview Azure API returned an invalid response.",
                    exception);
            }

            context.OutputParameters["klth_resultjson"] = Serialize(result);
        }

        private static SetupResult CreateDataverseStatus()
        {
            return new SetupResult
            {
                OverallState = "partial",
                CheckedAt = DateTime.UtcNow.ToString("o"),
                Components = new List<SetupComponent>
                {
                    new SetupComponent
                    {
                        Id = "dataverse-solution",
                        Name = "Managed solution",
                        Category = "Dataverse",
                        State = "ready",
                        Message = "The Segment Preview Dataverse solution is installed."
                    },
                    new SetupComponent
                    {
                        Id = "dataverse-plugins",
                        Name = "Plugins and Custom APIs",
                        Category = "Dataverse",
                        State = "ready",
                        Message = "The Segment Preview server components are registered."
                    },
                    new SetupComponent
                    {
                        Id = "dataverse-webresources",
                        Name = "Web resources",
                        Category = "Dataverse",
                        State = "ready",
                        Message = "The Segment Preview user interfaces are installed."
                    },
                    new SetupComponent
                    {
                        Id = "dataverse-configuration",
                        Name = "Environment configuration",
                        Category = "Dataverse",
                        State = "ready",
                        Message = "The Azure API URL and server-side API key are configured."
                    }
                }
            };
        }

        private static string ReadEnvironmentVariable(
            IOrganizationService service,
            string schemaName)
        {
            return EnvironmentVariableReader.Read(service, schemaName, false);
        }

        private static string Serialize<T>(T value)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream())
            {
                serializer.WriteObject(stream, value);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }

        private static T Deserialize<T>(string json)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            {
                return (T)serializer.ReadObject(stream);
            }
        }

        private static T TryDeserialize<T>(string json) where T : class
        {
            try
            {
                return Deserialize<T>(json);
            }
            catch (SerializationException)
            {
                return null;
            }
        }

        private static HttpClient CreateHttpClient()
        {
            return new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(60)
            };
        }
    }

    [DataContract]
    internal sealed class SetupResult
    {
        [DataMember(Name = "overallState", Order = 1)]
        public string OverallState { get; set; }

        [DataMember(Name = "apiVersion", Order = 2, EmitDefaultValue = false)]
        public string ApiVersion { get; set; }

        [DataMember(Name = "checkedAt", Order = 3)]
        public string CheckedAt { get; set; }

        [DataMember(Name = "components", Order = 4)]
        public List<SetupComponent> Components { get; set; }
    }

    [DataContract]
    internal sealed class SetupComponent
    {
        [DataMember(Name = "id", Order = 1)]
        public string Id { get; set; }

        [DataMember(Name = "name", Order = 2)]
        public string Name { get; set; }

        [DataMember(Name = "category", Order = 3)]
        public string Category { get; set; }

        [DataMember(Name = "state", Order = 4)]
        public string State { get; set; }

        [DataMember(Name = "message", Order = 5)]
        public string Message { get; set; }

        [DataMember(Name = "detail", Order = 6, EmitDefaultValue = false)]
        public string Detail { get; set; }

        [DataMember(Name = "action", Order = 7, EmitDefaultValue = false)]
        public string Action { get; set; }
    }

    [DataContract]
    internal sealed class SetupProvisionEnvelope
    {
        [DataMember(Name = "status", Order = 1)]
        public SetupResult Status { get; set; }
    }

    [DataContract]
    internal sealed class SetupApiError
    {
        [DataMember(Name = "code", Order = 1)]
        public string Code { get; set; }

        [DataMember(Name = "message", Order = 2)]
        public string Message { get; set; }
    }
}
