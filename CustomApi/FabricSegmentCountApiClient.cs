using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricSegmentCountApiClient
    {
        private static readonly HttpClient HttpClient = CreateHttpClient();
        private readonly ITracingService tracing;

        public FabricSegmentCountApiClient(ITracingService tracing)
        {
            this.tracing = tracing;
        }

        public FilterCountResult Evaluate(
            Guid segmentDefinitionId,
            FabricSegmentCountSettings settings,
            FabricSegmentCountApiRequest requestPayload,
            FabricDependencyStatus dependencies)
        {
            var endpoint = new Uri(settings.BehavioralEndpoint, "segment-counts");
            using (var request = new HttpRequestMessage(HttpMethod.Post, endpoint))
            {
                request.Headers.Add("x-api-key", settings.ApiKey);
                request.Content = new StringContent(
                    FabricSegmentCountJsonSerialization.Serialize(requestPayload),
                    Encoding.UTF8,
                    "application/json");
                tracing.Trace(
                    "Calling full Fabric segment API for definition {0}.",
                    segmentDefinitionId);
                var roundtripTimer = Stopwatch.StartNew();
                using (var response = HttpClient.SendAsync(request).GetAwaiter().GetResult())
                {
                    var responseBody = response.Content.ReadAsStringAsync()
                        .GetAwaiter()
                        .GetResult();
                    var apiRoundtripMs = roundtripTimer.Elapsed.TotalMilliseconds;
                    if (!response.IsSuccessStatusCode)
                    {
                        ThrowApiError(response, responseBody);
                    }

                    var mappingTimer = Stopwatch.StartNew();
                    var result = FabricSegmentCountJsonSerialization
                        .Deserialize<FabricSegmentCountApiResponse>(responseBody);
                    var mapped = MapResult(result, dependencies, requestPayload);
                    if (mapped.Diagnostics != null &&
                        mapped.Diagnostics.TimingsMs != null)
                    {
                        mapped.Diagnostics.TimingsMs.DataverseApiRoundtrip =
                            apiRoundtripMs;
                        mapped.Diagnostics.TimingsMs.DataverseResponseMapping =
                            mappingTimer.Elapsed.TotalMilliseconds;
                    }

                    return mapped;
                }
            }
        }

        private static void ThrowApiError(HttpResponseMessage response, string responseBody)
        {
            var apiError = FabricSegmentCountJsonSerialization
                .TryDeserialize<FabricSegmentApiError>(responseBody);
            var message = apiError != null &&
                !string.IsNullOrWhiteSpace(apiError.Message)
                    ? apiError.Message
                    : "The full Fabric segment evaluation responded with HTTP " +
                      ((int)response.StatusCode).ToString() + ".";
            if (apiError != null && !string.IsNullOrWhiteSpace(apiError.Detail))
            {
                message += " " + apiError.Detail;
            }
            if (apiError != null && apiError.Diagnostics != null)
            {
                message += "\nSANK_DIAGNOSTICS:" +
                    Convert.ToBase64String(
                        Encoding.UTF8.GetBytes(
                            FabricSegmentCountJsonSerialization.Serialize(apiError.Diagnostics)));
            }

            throw new InvalidPluginExecutionException(message);
        }

        private FilterCountResult MapResult(
            FabricSegmentCountApiResponse result,
            FabricDependencyStatus dependencies,
            FabricSegmentCountApiRequest requestPayload)
        {
            if (!result.CatalogReady)
            {
                throw new InvalidPluginExecutionException(
                    "The deployed Fabric API is older than the installed Segment Preview " +
                    "solution and does not support optimized dependency repair. Open Setup " +
                    "Center and run Install everything to update the API, then retry.");
            }

            dependencies.SetAddedTables(
                result.AddedTables ?? new List<string>());
            if (result.Stages == null || result.Stages.Count == 0)
            {
                throw new InvalidPluginExecutionException(
                    "The Fabric segment evaluation returned no count stages.");
            }

            DateTime generatedAt;
            if (!DateTime.TryParse(
                result.GeneratedAt,
                null,
                System.Globalization.DateTimeStyles.RoundtripKind,
                out generatedAt))
            {
                throw new InvalidPluginExecutionException(
                    "The Fabric segment evaluation returned an invalid timestamp.");
            }

            var stageMetadata = BuildStageMetadata(requestPayload.Query);
            var stages = result.Stages
                .OrderBy(stage => stage.Order)
                .Select(stage =>
                {
                    var metadata = stage.Order >= 0 &&
                        stage.Order < stageMetadata.Count
                            ? stageMetadata[stage.Order]
                            : null;
                    return new FilterCountStage(
                        stage.Order,
                        stage.Label,
                        stage.Detail,
                        stage.Count,
                        "complete",
                        metadata != null && metadata.Presentation != null
                            ? metadata.Presentation
                            : stage.Presentation,
                        metadata == null ? null : metadata.GroupLabel);
                })
                .ToList();
            tracing.Trace(
                "Full Fabric segment API returned {0} stages.",
                stages.Count);
            return new FilterCountResult(
                generatedAt,
                false,
                stages,
                dependencies,
                result.QueryToken,
                result.Diagnostics);
        }

        private static IList<StageMetadata> BuildStageMetadata(
            FabricSegmentQueryRequest query)
        {
            var result = new List<StageMetadata>
            {
                new StageMetadata(null, null)
            };
            var firstOperand = query == null ? null : query.FirstOperand;
            if (firstOperand != null &&
                string.Equals(
                    firstOperand.Kind,
                    "profile",
                    StringComparison.OrdinalIgnoreCase))
            {
                result.AddRange((firstOperand.Steps ??
                    new List<FabricSegmentFilterStepRequest>())
                    .Select(step => new StageMetadata(
                        step.Presentation,
                        step.GroupLabel)));
            }

            if (query != null)
            {
                result.AddRange((query.SetOperations ??
                    new List<FabricSegmentSetOperationRequest>())
                    .Select(operation => new StageMetadata(
                        operation.Presentation,
                        operation.GroupLabel)));
            }

            return result;
        }

        private sealed class StageMetadata
        {
            public StageMetadata(
                FabricSegmentPresentationHint presentation,
                string groupLabel)
            {
                Presentation = presentation;
                GroupLabel = groupLabel;
            }

            public FabricSegmentPresentationHint Presentation { get; private set; }

            public string GroupLabel { get; private set; }
        }

        private static HttpClient CreateHttpClient()
        {
            return new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(180)
            };
        }
    }

    internal static class FabricSegmentCountJsonSerialization
    {
        public static string Serialize<T>(T value)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream())
            {
                serializer.WriteObject(stream, value);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }

        public static T Deserialize<T>(string json)
        {
            var serializer = new DataContractJsonSerializer(typeof(T));
            using (var stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            {
                return (T)serializer.ReadObject(stream);
            }
        }

        public static T TryDeserialize<T>(string json) where T : class
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
    }
}
