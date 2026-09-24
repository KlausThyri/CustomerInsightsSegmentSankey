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

        public FabricSegmentCountClient(
            IOrganizationService service,
            ITracingService tracing)
        {
            this.service = service;
            this.tracing = tracing;
        }

        public FilterCountResult Evaluate(Guid segmentDefinitionId)
        {
            var phaseTimer = Stopwatch.StartNew();
            var settings = new FabricSegmentCountSettingsProvider(service)
                .Read();
            var settingsMs = phaseTimer.Elapsed.TotalMilliseconds;

            phaseTimer.Restart();
            var requestPayload = new FabricSegmentRequestBuilder(service)
                .Build(
                    segmentDefinitionId,
                    settings.BusinessUnitScopingEnabled);
            var requestBuildMs = phaseTimer.Elapsed.TotalMilliseconds;

            phaseTimer.Restart();
            var dependencies = new FabricTableDependencyResolver(service, tracing)
                .Resolve(requestPayload);
            var dependencyResolutionMs = phaseTimer.Elapsed.TotalMilliseconds;
            requestPayload.RequiredDataverseTables =
                dependencies.RequiredTables.ToList();

            var result = new FabricSegmentCountApiClient(tracing)
                .Evaluate(segmentDefinitionId, settings, requestPayload, dependencies);
            if (result.Diagnostics != null && result.Diagnostics.TimingsMs != null)
            {
                result.Diagnostics.TimingsMs.DataverseSettings = settingsMs;
                result.Diagnostics.TimingsMs.DataverseRequestBuild = requestBuildMs;
                result.Diagnostics.TimingsMs.DataverseDependencyResolution =
                    dependencyResolutionMs;
            }

            return result;
        }
    }
}
