using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricDependencyProvisioningClient
    {
        // Environment variable schema names are unchanged for compatibility with the
        // already-deployed Base Solution configuration.
        private const string ApiUrlVariable = "klth_FabricBehavioralApiUrl";
        private const string ApiKeyVariable = "klth_FabricBehavioralApiKey";
        private static readonly HttpClient HttpClient = CreateHttpClient();
        private readonly IOrganizationService service;
        private readonly ITracingService tracing;

        public FabricDependencyProvisioningClient(
            IOrganizationService service,
            ITracingService tracing)
        {
            this.service = service;
            this.tracing = tracing;
        }

        public IList<string> EnsureDataverseTables(IEnumerable<string> tables)
        {
            var apiUrl = ReadEnvironmentVariable(ApiUrlVariable, true);
            Uri baseEndpoint;
            if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out baseEndpoint) ||
                baseEndpoint.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidPluginExecutionException(
                    "The environment variable " + ApiUrlVariable +
                    " must contain an absolute HTTPS URL.");
            }

            var endpoint = new Uri(baseEndpoint, "fabric-dependencies");
            var apiKey = ReadEnvironmentVariable(ApiKeyVariable, true);
            var payload = new FabricDependencyApiRequest
            {
                DataverseTables = tables
                    .Where(table => !string.IsNullOrWhiteSpace(table))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList()
            };

            tracing.Trace(
                "Calling Fabric dependency API for {0} table(s).",
                payload.DataverseTables.Count);
            using (var request = new HttpRequestMessage(HttpMethod.Post, endpoint))
            {
                request.Headers.Add("x-api-key", apiKey);
                request.Content = new StringContent(
                    Serialize(payload),
                    Encoding.UTF8,
                    "application/json");
                HttpResponseMessage response;
                try
                {
                    response = HttpClient.SendAsync(request).GetAwaiter().GetResult();
                }
                catch (TaskCanceledException exception)
                {
                    throw new InvalidPluginExecutionException(
                        "Fabric did not finish exposing the required Dataverse tables in time. " +
                        "Retry the segment preview.",
                        exception);
                }

                using (response)
                {
                    var responseBody = response.Content.ReadAsStringAsync()
                        .GetAwaiter()
                        .GetResult();
                    if (!response.IsSuccessStatusCode)
                    {
                        var apiError = TryDeserialize<FabricDependencyApiError>(responseBody);
                        throw new InvalidPluginExecutionException(
                            apiError != null && !string.IsNullOrWhiteSpace(apiError.Message)
                                ? apiError.Message
                                : "The Fabric dependencies could not be provisioned.");
                    }

                    var result = Deserialize<FabricDependencyApiResponse>(responseBody);
                    if (!result.CatalogReady)
                    {
                        throw new InvalidPluginExecutionException(
                            "The deployed Fabric API is older than the installed Segment Preview " +
                            "solution and cannot confirm newly added tables. Open Setup Center and " +
                            "run Install everything to update the API, then retry the preview.");
                    }

                    return result.AddedTables ?? new List<string>();
                }
            }
        }

        private string ReadEnvironmentVariable(string schemaName, bool required)
        {
            return EnvironmentVariableReader.Read(service, schemaName, required);
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
    internal sealed class FabricDependencyApiRequest
    {
        [DataMember(Name = "dataverseTables", Order = 1)]
        public List<string> DataverseTables { get; set; }
    }

    [DataContract]
    internal sealed class FabricDependencyApiResponse
    {
        [DataMember(Name = "addedTables", Order = 1)]
        public List<string> AddedTables { get; set; }

        [DataMember(Name = "catalogReady", Order = 2)]
        public bool CatalogReady { get; set; }
    }

    [DataContract]
    internal sealed class FabricDependencyApiError
    {
        [DataMember(Name = "code", Order = 1)]
        public string Code { get; set; }

        [DataMember(Name = "message", Order = 2)]
        public string Message { get; set; }

        [DataMember(Name = "detail", Order = 3)]
        public string Detail { get; set; }
    }
}
