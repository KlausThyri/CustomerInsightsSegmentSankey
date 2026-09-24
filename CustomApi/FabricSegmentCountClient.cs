using System;
using System.Diagnostics;
using System.Linq;
using Microsoft.Xrm.Sdk;

namespace CustomerInsightsSegmentSankey.CustomApi
{
    internal sealed class FabricSegmentCountClient
    {
        private readonly IOrganizationService service;
        private readonly ITracingService tracing;
        private readonly Guid organizationId;

        public FabricSegmentCountClient(
            IOrganizationService service,
            ITracingService tracing,
            Guid organizationId)
        {
            this.service = service;
            this.tracing = tracing;
            this.organizationId = organizationId;
        }

        public FilterCountResult Evaluate(
            Guid segmentDefinitionId,
            bool progressivePreview = false)
        {
            var phaseTimer = Stopwatch.StartNew();
            var settings = new FabricSegmentCountSettingsProvider(service)
                .Read();
            var settingsMs = phaseTimer.Elapsed.TotalMilliseconds;

            phaseTimer.Restart();
            var requestBuilder = new FabricSegmentRequestBuilder(
                service,
                organizationId);
            var requestPayload = requestBuilder.Build(
                segmentDefinitionId,
                settings.BusinessUnitScopingEnabled,
                progressivePreview);
            var requestBuildMs = phaseTimer.Elapsed.TotalMilliseconds;

            phaseTimer.Restart();
            var dependencies = new FabricTableDependencyResolver(service, tracing)
                .Resolve(requestPayload);
            var dependencyResolutionMs = phaseTimer.Elapsed.TotalMilliseconds;
            requestPayload.RequiredDataverseTables =
                dependencies.RequiredTables.ToList();

            var result = new FabricSegmentCountApiClient(tracing)
                .Evaluate(segmentDefinitionId, settings, requestPayload, dependencies);
            if (progressivePreview)
            {
                var stages = result.Stages.ToList();
                var nextOrder = stages.Count;
                stages.AddRange(requestBuilder.DeferredStages.Select(stage =>
                    new FilterCountStage(
                        nextOrder++,
                        stage.Label,
                        stage.Detail,
                        null,
                        "pending")));
                result = new FilterCountResult(
                    DateTime.Parse(result.GeneratedAt),
                    result.IsEstimate,
                    stages,
                    result.FabricDependencies,
                    string.Empty,
                    result.Diagnostics,
                    false);
            }
            if (result.Diagnostics != null && result.Diagnostics.TimingsMs != null)
            {
                result.Diagnostics.TimingsMs.DataverseSettings = settingsMs;
                result.Diagnostics.TimingsMs.DataverseRequestBuild = requestBuildMs;
                result.Diagnostics.TimingsMs.DataverseDependencyResolution =
                    dependencyResolutionMs;
                result.Diagnostics.TimingsMs.DataverseSegmentRetrieve =
                    requestBuilder.Timings.SegmentRetrieve;
                result.Diagnostics.TimingsMs.DataverseMqlParsing =
                    requestBuilder.Timings.MqlParsing;
                result.Diagnostics.TimingsMs.DataverseRelationshipMetadata =
                    requestBuilder.Timings.RelationshipMetadata;
                result.Diagnostics.TimingsMs.DataverseEntityMetadata =
                    requestBuilder.Timings.EntityMetadata;
                result.Diagnostics.TimingsMs.DataverseSegmentReferences =
                    requestBuilder.Timings.SegmentReferences;
                result.Diagnostics.TimingsMs.DataverseStaticMembers =
                    requestBuilder.Timings.StaticMembers;
                result.Diagnostics.Runtime.RequestBuildCache =
                    requestBuilder.Timings.Cache;
            }

            return result;
        }
    }
}
